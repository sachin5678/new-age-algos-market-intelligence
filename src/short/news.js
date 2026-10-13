/**
 * Daily market-news roundup — data stage for `--type news-roundup`.
 *
 * Fetches market RSS feeds (ET Markets + Livemint are the reliable ones;
 * Moneycontrol/Business Standard are attempted but tolerated failures),
 * keeps the last 24h of headlines, clusters syndicated duplicates and picks
 * the top stories by a deterministic keyword score. From those it builds a
 * verdict-shaped object (headline / facts / market_relevance) plus a
 * synthetic store-shaped event with a per-day id (`evt_news_roundup_YYYYMMDD`
 * in IST) so the YouTube registry dedups one roundup per trading day.
 *
 * Deterministic by design: no AI call happens here. The CLI may polish the
 * verdict through the existing AI service when a key is configured, but the
 * rules verdict alone is always renderable.
 */

/** Market RSS feeds. First two are the dependable ones; the rest best-effort. */
export const ROUNDUP_FEEDS = Object.freeze([
  {
    source: 'ET Markets',
    url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  },
  { source: 'Livemint Markets', url: 'https://livemint.com/rss/markets' },
  { source: 'Moneycontrol', url: 'https://www.moneycontrol.com/rss/marketreports.xml' },
  {
    source: 'Business Standard',
    url: 'https://www.business-standard.com/rss/markets-106.rss',
  },
]);

// One pattern per keyword group so every distinct market word scores:
// "RBI … repo rate … inflation" = 9, not one flat +3.
const SCORE_KEYWORDS = [
  [3, /\b(rbi|sebi|fed)\b/i],
  [3, /\b(ltcg|stt|gst|budget)\b/i],
  [3, /\b(repo\s*rate|rate\s*cut)\b/i],
  [3, /\b(sanction|tariff|cpi|inflation|gdp)\b/i],
  [3, /\b(earnings|results)\b/i],
  [2, /\b(ipo|listing|buyback|dividend|bonus)\b/i],
  [2, /\b(crash|rally|surge|plunge|slump)\b/i],
  [2, /\b(record|all-?time)\b/i],
  [2, /\b(merger|acquisition)\b/i],
  [2, /\b(rupee|sensex|nifty|bank\s*nifty)\b/i],
  [2, /\b(moody'?s|upgrade|downgrade|fii|fpi)\b/i],
  [1, /\b(stock|shares?|market)\b/i],
  [1, /\b(funds?|gold|oil|bond|treasury|etf|nasdaq)\b/i],
];

const STOP = new Set(
  ('the a an of to in for and on as at by is are was were with after before from this that it its ' +
    'or but not more most vs amid over into off up down about across also can could may might must ' +
    'new says said see how what why when who whose your you we they be been being have has had do ' +
    'does did will would shall should than then there here which while during under until upon no ' +
    'nor so such some any each every both few own same')
    .split(' ')
);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Decode the XML entities RSS headlines actually use (named + numeric). */
export function decodeEntities(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[name])
    );
}

/** Strip tags/entities/surrounding punctuation from a raw RSS headline. */
export function cleanTitle(title = '') {
  return decodeEntities(String(title).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/^[\s|:–—-]+|[\s|:–—-]+$/g, '')
    .trim();
}

/** Parse RSS 2.0 <item> blocks; CDATA-aware; drops items without a date. */
export function parseRssItems(xml = '') {
  const items = [];
  for (const block of String(xml).match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1] : '';
    };
    const unwrap = (raw) => {
      const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
      return (cdata ? cdata[1] : raw).trim();
    };
    const title = cleanTitle(unwrap(pick('title')));
    const link = cleanTitle(unwrap(pick('link')));
    const ts = Date.parse(unwrap(pick('pubDate')));
    if (title && link && Number.isFinite(ts)) {
      items.push({ title, link, ts, pubDate: new Date(ts).toISOString() });
    }
  }
  return items;
}

/** Normalized headline tokens (for duplicate detection), stopwords dropped. */
export function headlineTokens(title = '') {
  return new Set(
    cleanTitle(title)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/** Jaccard similarity of two token sets (0..1). */
export function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Deterministic market-importance score for a headline. */
export function scoreHeadline(title = '') {
  let score = 0;
  for (const [weight, re] of SCORE_KEYWORDS) if (re.test(title)) score += weight;
  return score;
}

/**
 * Filter to the window, cluster syndicated duplicates across feeds, and
 * return the top `limit` stories ranked by (score, recency).
 */
export function selectTopStories(items, { now = Date.now(), windowHours = 24, limit = 3 } = {}) {
  const cutoff = now - windowHours * 3600e3;
  const fresh = items.filter((i) => Number.isFinite(i.ts) && i.ts >= cutoff);

  const clusters = [];
  for (const item of [...fresh].sort((a, b) => b.ts - a.ts)) {
    const tokens = headlineTokens(item.title);
    const twin = clusters.find((c) => jaccard(c.tokens, tokens) >= 0.55);
    if (twin) {
      twin.items.push(item);
      if (item.ts > twin.ts) twin.ts = item.ts;
      if (!twin.sources.includes(item.source)) twin.sources.push(item.source);
      twin.score += 1; // the same story in two feeds means it matters
    } else {
      clusters.push({
        tokens,
        items: [item],
        sources: [item.source],
        score: scoreHeadline(item.title) + 1,
        ts: item.ts,
      });
    }
  }
  clusters.sort((a, b) => b.score - a.score || b.ts - a.ts);

  return clusters.slice(0, limit).map((c) => ({
    title: c.items[0].title,
    link: c.items[0].link,
    ts: c.ts,
    pubDate: new Date(c.ts).toISOString(),
    sources: c.sources,
    score: c.score,
  }));
}

/** IST calendar parts for the roundup (id + human label). */
export function istDateLabel(now = Date.now()) {
  const [y, m, d] = new Date(now + 5.5 * 3600e3).toISOString().slice(0, 10).split('-');
  return { iso: `${y}-${m}-${d}`, label: `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` };
}

/** Deterministic verdict from the top stories (always renderable). */
export function buildRoundupVerdict(stories, dateLabel) {
  const sources = [...new Set(stories.flatMap((s) => s.sources ?? []))];
  return {
    event_type: 'daily market news roundup',
    headline: `Three market stories that ruled ${dateLabel} — in sixty seconds!`,
    summary:
      `Market news roundup for ${dateLabel}: ` +
      stories.map((s, i) => `(${i + 1}) ${s.title}`).join(' ') +
      `. Sources: ${sources.join(', ')}.`,
    facts: stories.map((s) => s.title),
    market_relevance:
      `Policy, listings, macro — ${dateLabel} reminded every trader: in India the headline moves ` +
      'the sector first. Your sixty-second edge before the next open.',
    impact: 'mixed',
  };
}

/** Synthetic store-shaped event; per-day id keeps YouTube dedup to one per day. */
export function roundupEvent(stories, verdict, now = Date.now()) {
  const { iso, label } = istDateLabel(now);
  return {
    event_id: `evt_news_roundup_${iso.replace(/-/g, '')}`,
    cluster_id: `cl_news_roundup_${iso.replace(/-/g, '')}`,
    url: stories[0].link,
    title: `Market news roundup ${label}`,
    description: verdict.summary,
    source: [...new Set(stories.flatMap((s) => s.sources ?? []))].join(' / '),
    category: 'MARKET NEWS',
    importance: 0.9,
    importance_level: 'HIGH',
    published_at: new Date(now).toISOString(),
    detected_at: new Date(now).toISOString(),
    companies: [],
    sectors: [],
    institutions: [],
    sample: false,
  };
}

/**
 * Fetch every feed, merge, and build the roundup (event + verdict + stories).
 * Individual feed failures are tolerated; zero fresh stories is fatal.
 *
 * @param {object} [args]
 * @param {number} [args.now]        clock (ms) — injectable for tests
 * @param {Function} [args.fetchImpl] fetch implementation (injectable)
 * @param {object} [args.logger]
 * @param {number} [args.windowHours] freshness window (default 24h)
 * @returns {Promise<{event: object, verdict: object, stories: Array, itemCount: number, failedFeeds: string[]}>}
 */
export async function fetchNewsRoundup({
  now = Date.now(),
  fetchImpl = fetch,
  logger = console,
  windowHours = 24,
  feeds = ROUNDUP_FEEDS,
} = {}) {
  const results = await Promise.allSettled(
    feeds.map(async ({ source, url }) => {
      const res = await fetchImpl(url, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseRssItems(await res.text()).map((item) => ({ ...item, source }));
    })
  );

  const items = [];
  const failedFeeds = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failedFeeds.push(`${feeds[i].source}: ${r.reason?.message ?? r.reason}`);
  });
  logger?.log?.(
    `ROUNDUP FEEDS ${items.length} fresh-window items` +
      (failedFeeds.length ? ` (failed: ${failedFeeds.join('; ')})` : ' (all feeds ok)')
  );

  const stories = selectTopStories(items, { now, windowHours });
  if (!stories.length) {
    throw new Error(
      `no market news found in the last ${windowHours}h (${items.length} items seen` +
        (failedFeeds.length ? `, ${failedFeeds.length} feed(s) failed` : '') +
        ') — refusing to render an empty roundup'
    );
  }

  const { label } = istDateLabel(now);
  const verdict = buildRoundupVerdict(stories, label);
  const event = roundupEvent(stories, verdict, now);
  return { event, verdict, stories, itemCount: items.length, failedFeeds };
}
