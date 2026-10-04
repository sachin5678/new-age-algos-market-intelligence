import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAlert,
  formatBreakingAlert,
  formatIntradayAlert,
  formatMarketSnapshot,
} from '../src/telegram/format.js';
import { formatPreMarket, formatClosing } from '../src/telegram/briefings.js';
import { SEP, MESSAGE_BUDGET, labelChunks, sourceLink, impactBadge, sectorChip, trimText } from '../src/telegram/theme.js';

const NOW = new Date('2026-10-04T05:00:00.000Z'); // 10:30 IST

/** Telegram HTML must balance in every rendered message or delivery fails. */
function assertBalanced(text, label = 'message') {
  for (const tag of ['b', 'i', 'u', 'code', 'blockquote']) {
    const opens = [...text.matchAll(new RegExp(`<${tag}>`, 'g'))].length;
    const closes = [...text.matchAll(new RegExp(`</${tag}>`, 'g'))].length;
    assert.equal(opens, closes, `${label}: unbalanced <${tag}> (${opens} vs ${closes})`);
  }
  const hrefs = [...text.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
  for (const h of hrefs) {
    assert.ok(/^https?:\/\//.test(h), `${label}: href must be http(s): ${h}`);
    assert.ok(!/[<>]/.test(h), `${label}: href contains raw angle brackets: ${h}`);
  }
}

const officialEvent = {
  title: 'NSE revises circuit-breaker bands for cash segment',
  url: 'https://www.nseindia.com/circulars/cb-revision',
  source: 'NSE',
  trust_tier: 1,
  source_type: 'official',
  category: 'MARKET',
  institutions: ['NSE'],
  companies: [],
  sectors: ['BANKING'],
  importance: 88,
  importance_level: 'HIGH',
  detection_status: 'UPDATED',
};

const mediaEvent = {
  title: 'Rupee closes at 88.45 to the dollar as oil eases',
  url: 'https://www.reuters.com/markets/asia/rupee-test?a=1&b=2',
  source: 'Reuters',
  trust_tier: 2,
  source_type: 'media',
  category: 'MACRO',
  institutions: [],
  companies: [],
  sectors: ['BANKING', 'AUTO'],
  importance: 71,
  importance_level: 'MEDIUM',
};

const richVerdict = {
  event_type: 'market',
  headline: 'NSE revises circuit-breaker bands for cash segment',
  summary: 'The exchange widened the bands to 10% for large-cap stocks after a volatility review.',
  facts: ['Bands revised to 10%'],
  market_relevance: 'Intraday risk controls change for index heavyweights.',
  affected_sectors: ['BANKING'],
  affected_stocks: ['HDFCBANK'],
  impact: 'negative',
  confidence: 'high',
  source_type: 'official',
  is_material: true,
  publication_priority: 'high',
  trader_takeaway: 'Watch whether the first volatility spike is bought or sold before reading the bands as direction.',
};

// ------------------------------------------------------------------ breaking

test('breaking alert: confirmed source, status badge and blockquoted view', () => {
  const text = formatBreakingAlert(officialEvent, richVerdict, { now: NOW });
  assertBalanced(text, 'breaking');
  assert.ok(text.includes('🚨 <b>NEW AGE ALGOS</b>'));
  assert.ok(text.includes('⚡ <b>HIGH-IMPACT MARKET ALERT</b>'));
  assert.ok(text.includes('🔴 <b>NSE • MARKETS</b>'), 'slug from extracted entities');
  assert.ok(text.includes('✅ <i>Confirmed — NSE (official source)</i>'), 'tier-1 confirmation badge');
  assert.ok(text.includes('<blockquote>'), 'view rendered as blockquote');
  assert.ok(text.includes('📊 <b>MARKET IMPACT</b>'));
  assert.ok(text.includes('🔴 <b>Negative</b>'), 'negative impact indicator');
  assert.ok(text.trimEnd().endsWith('<i>Data-driven • Systematic • Transparent</i>'));
});

test('breaking alert keeps fact / relevance / interpretation visually separate', () => {
  const text = formatBreakingAlert(officialEvent, richVerdict, { now: NOW });
  const factAt = text.indexOf(richVerdict.summary);
  const whyAt = text.indexOf('📌 <b>Why it matters</b>');
  const viewAt = text.indexOf('<blockquote>');
  assert.ok(factAt > 0 && whyAt > factAt, 'fact must precede relevance');
  assert.ok(viewAt > whyAt, 'interpretation must follow relevance');
  assert.ok(text.indexOf('🧠 <b>NEW AGE ALGOS VIEW</b>') < viewAt, 'view heading must wrap the blockquote');
  // The interpretation never repeats the fact verbatim.
  assert.ok(!text.slice(viewAt).includes(richVerdict.summary), 'view must not repeat the fact');
});

test('status badges: confirmed / reported / awaiting / unconfirmed, never invented', () => {
  const cases = [
    [{ ...officialEvent, detection_status: 'NEW' }, '✅ <i>Confirmed — NSE (official source)</i>'],
    [{ ...mediaEvent, category: 'MARKET', institutions: [], sectors: [] }, '🟡 <i>Reported — Reuters</i>'],
    [{ ...mediaEvent, category: 'RBI' }, '⚠️ <i>Awaiting official confirmation — reported by Reuters</i>'],
    [{ ...mediaEvent, source: 'FinTwit', trust_tier: 4 }, '⚠️ <i>Unconfirmed — FinTwit (commentary/social; not treated as fact)</i>'],
  ];
  for (const [ev, expected] of cases) {
    const text = formatAlert(ev, { headline: 'x', summary: 'y' }, { now: NOW });
    assert.ok(text.includes(expected), `missing status: ${expected}`);
  }
});

// --------------------------------------------------------------- intraday

test('regular update: compact template with severity, watch line and source link', () => {
  const text = formatIntradayAlert(mediaEvent, {
    headline: mediaEvent.title,
    summary: 'The rupee settled at 88.45 after Brent fell below $79.',
    market_relevance: 'Softer oil eases the import bill and supports IT margins.',
    affected_sectors: ['BANKING', 'AUTO'],
    affected_stocks: ['HDFCBANK'],
    impact: 'positive',
    confidence: 'medium',
    publication_priority: 'medium',
    trader_takeaway: '',
  }, { now: NOW });

  assertBalanced(text, 'intraday');
  assert.ok(text.includes('📈 <b>MARKET UPDATE</b>'));
  assert.ok(text.includes('🟠 <b>MACRO</b>') || text.includes('🟠 <b>BANKING • AUTO</b>') || /🟠 <b>/.test(text), 'severity dot');
  assert.ok(text.includes('👀 <b>Watch</b>: HDFCBANK • BANKING • AUTO'), 'watch line missing');
  assert.ok(text.includes('<a href="https://www.reuters.com/markets/asia/rupee-test?a=1&amp;b=2">Reuters</a>'));
  assert.ok(text.includes('🟡 <i>Reported — Reuters</i>'));
  assert.ok(!text.includes('HIGH-IMPACT'), 'must not claim breaking');
  assert.ok(!text.includes('⚪'), 'no unclear-impact noise on a normal update');
  assert.ok(text.includes('📌 <b>Why it matters</b>'));
});

test('severity dot follows importance (🔴 HIGH / 🟠 MEDIUM / 🟡 LOW)', () => {
  const v = { headline: 'h', summary: 's' };
  const high = formatIntradayAlert({ ...mediaEvent, importance_level: 'HIGH' }, v, { now: NOW });
  const mid = formatIntradayAlert({ ...mediaEvent, importance_level: 'MEDIUM' }, v, { now: NOW });
  const low = formatIntradayAlert({ ...mediaEvent, importance_level: 'LOW' }, v, { now: NOW });
  assert.ok(high.includes('🔴 <b>'));
  assert.ok(mid.includes('🟠 <b>'));
  assert.ok(low.includes('🟡 <b>'));
});

test('missing fields never render a section (no fabricated data)', () => {
  const text = formatIntradayAlert(
    { title: 'Plain item', source: 'PTI', trust_tier: 3, category: 'OTHER', url: null },
    {},
    { now: NOW }
  );
  assertBalanced(text, 'minimal update');
  assert.ok(text.includes('Plain item'), 'headline must still render');
  assert.ok(text.includes('🟡 <i>Reported — PTI</i>'));
  assert.ok(!text.includes('<a href'), 'no link without a URL');
  assert.ok(!text.includes('Why it matters'));
  assert.ok(!text.includes('Watch'));
  assert.ok(!text.includes('MARKET IMPACT'));
  assert.ok(!text.includes('<blockquote>'));
});

// ------------------------------------------------------------- escaping

test('special characters in every dynamic field are escaped', () => {
  const text = formatBreakingAlert(
    {
      ...officialEvent,
      title: 'C++ & 5%: RBI <rate> (FY24) "test"',
      source: 'Blog & Co',
      url: 'https://x.test/q?a=1&b=<2>',
    },
    {
      ...richVerdict,
      headline: 'C++ & 5%: RBI <rate> (FY24)',
      summary: 'Rates "held" at 5% <watch>.',
      affected_sectors: ['<BANKING>'],
      affected_stocks: ['A&B'],
      market_relevance: 'Bonds & equities react.',
      trader_takeaway: 'Yields > 7% matters.',
    },
    { now: NOW }
  );
  assertBalanced(text, 'escaping');
  assert.ok(!text.includes('<rate>') && !text.includes('<watch>') && !text.includes('<BANKING>'));
  assert.ok(text.includes('&lt;rate&gt;') && text.includes('&lt;watch&gt;'));
  assert.ok(text.includes('&amp;'), 'ampersands must be escaped');
  assert.ok(!text.includes('&#39;'), 'no residual entities');
});

test('sourceLink never fabricates and always escapes', () => {
  assert.equal(sourceLink('https://a.test/x?y=1&z=2', 'ET'), '<a href="https://a.test/x?y=1&amp;z=2">ET</a>');
  assert.equal(sourceLink('', 'ET'), 'ET');
  assert.equal(sourceLink(null, 'ET'), 'ET');
  assert.equal(sourceLink('javascript:alert(1)', 'ET'), 'ET');
  assert.equal(sourceLink('https://a.test/<b>', 'ET'), 'ET');
  assert.equal(sourceLink(undefined, '<ET>'), '&lt;ET&gt;');
});

test('impact badge maps direction and defaults to Unclear', () => {
  assert.equal(impactBadge('positive'), '🟢 <b>Positive</b>');
  assert.equal(impactBadge('negative'), '🔴 <b>Negative</b>');
  assert.equal(impactBadge('neutral'), '🟡 <b>Neutral</b>');
  assert.equal(impactBadge('mixed'), '🟠 <b>Mixed</b>');
  assert.equal(impactBadge('unclear'), '⚪ <b>Unclear</b>');
  assert.equal(impactBadge(undefined), '⚪ <b>Unclear</b>');
});

test('sector chips keep acronyms uppercase and escape names', () => {
  assert.equal(sectorChip('IT'), '💻 IT');
  assert.equal(sectorChip('BANKING'), '🏦 Banking');
  assert.equal(sectorChip('OIL & GAS'), '🛢️ Oil &amp; Gas');
  const evil = sectorChip('<X>');
  assert.ok(!evil.includes('<X>'), 'sector names must be escaped');
  assert.ok(evil.includes('&lt;') && evil.includes('&gt;'));
  assert.equal(sectorChip(''), null);
});

// --------------------------------------------------------- market snapshot

test('market snapshot renders a dashboard from real metrics only', () => {
  const text = formatMarketSnapshot(
    {
      now: NOW,
      indices: [
        { name: 'NIFTY 50', value: 24850.35, pct_change: 0.72 },
        { name: 'NIFTY BANK', value: 52410.8, pct_change: -0.31 },
      ],
      breadth: { advances: 1284, declines: 932 },
      flows: [{ name: 'FII', value: '₹+1,240 Cr' }],
      leaders: ['TCS', 'VEDL'],
      laggards: ['SUNPHARMA'],
    },
    { now: NOW }
  );
  assertBalanced(text, 'snapshot');
  assert.ok(text.startsWith('📊 <b>NEW AGE ALGOS</b>'));
  assert.ok(text.includes('🇮🇳 <b>MARKET SNAPSHOT</b>'));
  assert.ok(text.includes('📈 <b>INDICES</b>'));
  assert.match(text, /NIFTY 50\s+24,850\.35\s+🟢 \+0\.72%/);
  assert.match(text, /NIFTY BANK\s+52,410\.8\s+🔴 -0\.31%/);
  assert.match(text, /ADVANCES\s+1,284/);
  assert.ok(text.includes('₹+1,240 Cr'));
  assert.ok(text.includes('🔥 <b>LEADERS</b>') && text.includes('TCS • VEDL'));
  assert.ok(text.includes('⚠️ <b>LAGGARDS</b>') && text.includes('SUNPHARMA'));
  assert.ok(text.trimEnd().endsWith('<i>Data-driven • Systematic • Transparent</i>'));
});

test('market snapshot with no data renders only the brand frame', () => {
  const text = formatMarketSnapshot({ now: NOW }, { now: NOW });
  assertBalanced(text, 'empty snapshot');
  assert.ok(text.includes('🇮🇳 <b>MARKET SNAPSHOT</b>'));
  for (const marker of ['INDICES', 'MARKET BREADTH', 'FLOWS', 'LEADERS', 'LAGGARDS']) {
    assert.ok(!text.includes(marker), `empty snapshot must omit ${marker}`);
  }
  assert.ok(text.includes('04 OCT 2026 • 10:30 IST'));
});

test('snapshot omits a metric that is missing instead of showing 0', () => {
  const text = formatMarketSnapshot(
    { now: NOW, indices: [{ name: 'NIFTY 50', value: 24850.35, pct_change: 0.72 }] },
    { now: NOW }
  );
  assert.ok(!text.includes('ADVANCES'), 'breadth must be omitted when unknown');
  assert.ok(!text.includes('BANKNIFTY'), 'missing index must be omitted');
  assert.ok(!text.includes('NaN'));
});

// ----------------------------------------------------------------- briefings

function story(i) {
  return {
    t: `Story ${i} (Reuters)`,
    headline: `Story ${i} headline about Indian markets`,
    level: i === 1 ? 'HIGH' : 'MEDIUM',
    source: 'Reuters',
    url: `https://reuters.test/${i}`,
    status: 'Reported',
    category: 'MARKET',
    institutions: [],
    sectors: ['IT'],
    companies: [`SYM${i}`],
    summary: `Story ${i} summary with concrete numbers.`,
    relevance: `Why story ${i} matters for the session.`,
  };
}

test('pre-market renders 0, 1, 5 and 8 developments with correct caps', () => {
  const none = formatPreMarket({ date: '04 Oct 2026' }, { now: NOW });
  assert.ok(!none.includes('WHAT MATTERS TODAY'), 'no developments → no section');

  const one = formatPreMarket({ date: '04 Oct 2026', developments: [story(1)] }, { now: NOW });
  assert.ok(one.includes('🔴 <b>1  IT • SYM1</b>'));
  assert.ok(!one.includes('<b>2  '), 'no phantom second item');

  const five = formatPreMarket({ date: '04 Oct 2026', developments: [1, 2, 3, 4, 5].map(story) }, { now: NOW });
  assert.ok(five.includes('5  '));
  assertBalanced(five, 'five developments');

  const eight = formatPreMarket({ date: '04 Oct 2026', developments: [1, 2, 3, 4, 5, 6, 7, 8].map(story) }, { now: NOW });
  assert.ok(eight.includes('<b>5  '), 'caps at five stories');
  assert.ok(!eight.includes('<b>6  '), 'never dumps more than five stories');
  assert.ok(!eight.includes('Story 6'), 'sixth story must not leak in');
});

test('no section heading is ever duplicated', () => {
  const text = formatPreMarket(
    {
      date: '04 Oct 2026',
      developments: [1, 2, 3].map(story),
      watchlist: ['TCS', 'IT sector'],
      us: ['S&P 500: 6,700 (-0.30%)'],
      nifty: '24,850 (+0.72%)',
      keyEvents: ['10:00 AM — PMI'],
      view: 'Watch the opening range.',
    },
    { now: NOW }
  );
  for (const heading of ['WHAT MATTERS TODAY', 'STOCKS / SECTORS TO WATCH', 'GLOBAL CUES', 'INDIAN MARKET SETUP', "TODAY'S KEY EVENTS", 'NEW AGE ALGOS VIEW']) {
    const hits = text.split(heading).length - 1;
    assert.equal(hits, 1, `"${heading}" rendered ${hits} times`);
  }
  assertBalanced(text, 'full pre-market');
});

test('a story without a URL shows its source as plain text', () => {
  const text = formatPreMarket(
    { date: '04 Oct 2026', developments: [{ ...story(1), url: null }] },
    { now: NOW }
  );
  assert.ok(!text.includes('<a href'), 'no hyperlink without a URL');
  assert.ok(text.includes('Reuters'), 'source name still shown');
  assertBalanced(text, 'no-url story');
});

test('closing view and pre-market view render only when analysis produced one', () => {
  const withView = formatClosing({ date: '04 Oct 2026', view: 'Breadth improved; watch follow-through.' }, { now: NOW });
  assert.ok(withView.includes('<blockquote>Breadth improved; watch follow-through.</blockquote>'));
  const withoutView = formatClosing({ date: '04 Oct 2026' }, { now: NOW });
  assert.ok(!withoutView.includes('<blockquote>'));
});

// ------------------------------------------------------------------ length

test('messages stay inside the length budget and keep balanced HTML', () => {
  const long = 'Considerable market commentary with plenty of detail about rates, flows and earnings. '.repeat(12);
  const bigPre = {
    date: '04 Oct 2026',
    developments: [1, 2, 3, 4, 5].map((i) => ({ ...story(i), summary: long, relevance: long })),
    watchlist: Array.from({ length: 15 }, (_, i) => `STOCK${i}`),
    us: Array.from({ length: 8 }, (_, i) => `US item ${i}: ${long}`),
    asia: Array.from({ length: 8 }, (_, i) => `ASIA item ${i}: ${long}`),
    keyEvents: Array.from({ length: 10 }, (_, i) => `Event ${i}: ${long}`),
    usdinr: long,
    crude: long,
    gold: long,
    view: long,
  };
  const text = formatPreMarket(bigPre, { now: NOW });
  assert.ok(text.length <= MESSAGE_BUDGET, `pre-market too long: ${text.length}`);
  assertBalanced(text, 'budgeted pre-market');
  assert.ok(text.trimEnd().endsWith('<i>Data-driven • Systematic • Transparent</i>'), 'footer must survive budgeting');

  const bigClose = formatClosing(
    {
      date: '04 Oct 2026',
      developments: [1, 2, 3, 4, 5].map((i) => ({ ...story(i), summary: long })),
      topSectors: Array.from({ length: 8 }, (_, i) => `SECTOR${i}: ${long}`),
      weakSectors: Array.from({ length: 8 }, (_, i) => `WEAK${i}: ${long}`),
      movers: Array.from({ length: 10 }, (_, i) => `MOVER${i}: ${long}`),
      fii: [long],
      dii: [long],
      global: Array.from({ length: 8 }, (_, i) => `GLOBAL${i}: ${long}`),
      watchNext: Array.from({ length: 8 }, (_, i) => `WATCH${i}: ${long}`),
      view: long,
    },
    { now: NOW }
  );
  assert.ok(bigClose.length <= MESSAGE_BUDGET, `closing too long: ${bigClose.length}`);
  assertBalanced(bigClose, 'budgeted closing');
});

test('trimText never cuts mid-sentence', () => {
  const s = 'First sentence is fine. Second sentence trails off into the distance and keeps going.';
  const out = trimText(s, 45);
  assert.ok(out.length <= 45 + 1);
  assert.ok(out.endsWith('.') || out.endsWith('…'), 'must end at a sentence or ellipsis');
  assert.ok(!out.includes('Second sentence is fi'), 'never cut mid-word');
  assert.equal(trimText('short', 100), 'short');
});

test('split messages are labelled so readers can follow the thread', () => {
  assert.deepEqual(labelChunks(['one']), ['one'], 'single message is untouched');
  const parts = labelChunks(['a', 'b', 'c']);
  assert.equal(parts.length, 3);
  assert.ok(parts[0].endsWith('<i>part 1 of 3</i>'));
  assert.ok(parts[2].endsWith('<i>part 3 of 3</i>'));
  assert.ok(parts[1].startsWith('b\n\n'), 'chunk content preserved');
});

test('every template shares the same brand frame', () => {
  const views = [
    formatPreMarket({}, { now: NOW }),
    formatClosing({}, { now: NOW }),
    formatBreakingAlert(officialEvent, richVerdict, { now: NOW }),
    formatIntradayAlert(mediaEvent, { headline: 'h' }, { now: NOW }),
    formatMarketSnapshot({ now: NOW }, { now: NOW }),
  ];
  for (const text of views) {
    const lines = text.split('\n');
    assert.match(lines[0], /<b>NEW AGE ALGOS<\/b>$/, 'brand line missing');
    assert.equal(lines[1], SEP, 'separator missing after brand line');
    assert.ok(text.includes('<i>Data-driven • Systematic • Transparent</i>'), 'tagline missing');
    assert.ok(text.includes('<i>04 OCT 2026 • 10:30 IST</i>'), 'timestamp missing');
    assert.ok(!text.includes('TOP DEVELOPMENTS'), 'legacy template must be gone');
    assert.ok(!/\\[()\-.|]/.test(text), 'MarkdownV2 residue');
  }
});
