/**
 * Structured visual briefing contract (§19), redesigned as a CONTENT-FIRST
 * market-intelligence model.
 *
 * Two independent ideas live here, and keeping them separate is the whole point:
 *
 *   1. RELEVANCE  — why a story is still worth showing (a previous-session item
 *      with an unresolved catalyst does not become worthless at 00:00), and
 *   2. FRESHNESS  — how old a raw article is allowed to be before it is noise.
 *
 * The old implementation had only (2): `filterFresh` at 48h/24h fed straight to
 * the ranking, so a pre-market run at 08:30 IST could legitimately conclude
 * "no material developments in the freshness window" while yesterday's session
 * and last night's global move sat right outside the cut. Pre-market now builds
 * its own windows (§PART 10): OVERNIGHT, PREVIOUS SESSION and the look-ahead
 * themes for today, each classified and labelled (§PART 13).
 *
 * Output is still never invented:
 *   - missing metrics stay null → renderer prints N/A
 *   - "what drove the market" is a SYNTHESIS composed only from numbers we
 *     actually hold, never a copy of a headline (§PART 6)
 *   - story bodies are cut at SENTENCE boundaries (§PART 3) — never "…"
 *
 * Pure functions only — no I/O, no rendering, no delivery.
 */

import { viewFromEvents } from '../briefings/context.js';
import { statusShort, isBreaking } from '../telegram/format.js';
import { categoryLabel } from '../telegram/theme.js';

/** Which snapshot matches a named instrument — same rules as the text briefs. */
export const pickSnapshot = (snaps = [], re) => snaps.find((s) => re.test(String(s?.name)));

const RE = {
  nifty: /^nifty(\s*50)?$/i,
  banknifty: /bank\s*nifty|nifty\s*bank/i,
  sensex: /sensex/i,
  advances: /advance/i,
  declines: /decline/i,
  fii: /^fii/i,
  dii: /^dii/i,
  usdinr: /usd\s*\/?\s*inr|usdinr|rupee/i,
  crude: /brent|crude|wti/i,
  gold: /gold/i,
  sp: /^s&p\s*500$|^s&p500$/i,
  nasdaq: /^nasdaq/i,
  dow: /^dow(\s+jones)?$/i,
  nikkei: /nikkei/i,
  hang: /hang\s*seng/i,
  shanghai: /shanghai/i,
};

/** Structured snapshot row — value/change/pct exactly as collected (or null). */
export function snapRow(snaps = [], re, label = null) {
  const s = pickSnapshot(snaps, re);
  if (!s) return null;
  return {
    name: label ?? String(s.name),
    value: typeof s.value === 'number' ? s.value : null,
    change: typeof s.change === 'number' ? s.change : null,
    pct_change: typeof s.pct_change === 'number' ? s.pct_change : null,
    asof: s.asof ?? null,
    source: s.source ?? null,
  };
}

// ------------------------------------------------------------- calendar

const TZ = 'Asia/Kolkata';
/** IST has no DST — a wall-clock instant is unambiguous as a fixed offset. */
const IST_OFFSET = '+05:30';

/** Calendar date in IST, e.g. "2026-10-05". */
export function istDateKey(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** "2026-10-02" + "09:15" → the instant that wall clock reads in IST. */
export function istInstant(dateKey, hhmm) {
  return new Date(`${dateKey}T${hhmm}:00${IST_OFFSET}`);
}

function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.UTC(y, m - 1, d + days)));
}

function weekdayOf(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun
}

/** "2026-10-01" → "Thursday" — the weekday of the SESSION, not of `now`. */
export function weekdayName(dateKey) {
  const [y, m, d] = String(dateKey ?? '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(
    new Date(Date.UTC(y, m - 1, d, 12))
  );
}

/**
 * Market calendar (§13) — reuses the exact holidays list and marketHours the
 * publication gate already uses. Returns status the template styles.
 *   kind: trading_day | weekend | holiday
 */
export function marketCalendar(now = new Date(), holidays = [], marketHours = {}) {
  const tz = marketHours.timezone ?? TZ;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  const weekdayLong = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
  })
    .format(now)
    .toUpperCase();
  const dateLong = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
    .format(now)
    .toUpperCase();

  const weekend = marketHours.weekdaysOnly !== false && (p.weekday === 'Sat' || p.weekday === 'Sun');
  const holiday = holidays.includes(date);
  const kind = weekend ? 'weekend' : holiday ? 'holiday' : 'trading_day';
  return {
    date,
    dateLong, // "05 OCTOBER 2026"
    weekday: weekdayLong, // "MONDAY"
    time: `${p.hour}:${p.minute} IST`,
    kind,
    isTradingDay: kind === 'trading_day',
    closed: kind !== 'trading_day',
    closedLabel: weekend ? 'MARKET CLOSED' : holiday ? 'MARKET CLOSED — NSE HOLIDAY' : null,
  };
}

/** Most recent trading date strictly before `dateKey` (weekends + holidays skipped). */
export function previousTradingDate(dateKey, holidays = [], marketHours = {}) {
  const weekdaysOnly = marketHours.weekdaysOnly !== false;
  let k = dateKey;
  for (let i = 0; i < 14; i++) {
    k = shiftDateKey(k, -1);
    const wd = weekdayOf(k);
    if (weekdaysOnly && (wd === 0 || wd === 6)) continue;
    if (holidays.includes(k)) continue;
    return k;
  }
  return null;
}

/**
 * The content windows a briefing reads from (PART 10).
 *
 *   PRE-MARKET   session    = previous trading day 09:15 -> 15:30 IST
 *                overnight  = that close -> now (a Monday run spans the weekend)
 *   CLOSING      session    = today 09:15 -> 15:30 IST
 *                overnight  = previous close -> today's open
 *
 * `structuralStart` is the line below which a story must earn its place on
 * RELEVANCE rather than age. Everything at or after it is structurally in
 * scope; before it, only stories that still score (PART 25) survive.
 *
 * open/close come from settings.marketHours - never hard-coded.
 */
export function sessionWindow({ type = 'premarket', now = new Date(), holidays = [], marketHours = {} } = {}) {
  const open = marketHours.start ?? '09:15';
  const close = marketHours.end ?? '15:30';
  const today = istDateKey(now);
  const prevDate = previousTradingDate(today, holidays, marketHours) ?? today;

  if (type === 'closing') {
    const prevClose = istInstant(prevDate, close);
    return {
      type,
      today,
      sessionDate: today,
      prevDate,
      sessionStart: istInstant(today, open),
      sessionEnd: istInstant(today, close),
      overnightStart: prevClose,
      structuralStart: prevClose,
      label: 'TODAY’S SESSION',
    };
  }

  const sessionStart = istInstant(prevDate, open);
  const sessionEnd = istInstant(prevDate, close);
  return {
    type,
    today,
    sessionDate: prevDate,
    prevDate,
    sessionStart,
    sessionEnd,
    overnightStart: sessionEnd,
    structuralStart: sessionStart,
    label: 'YESTERDAY’S SESSION',
  };
}

// --------------------------------------------------------- text helpers

/**
 * Split prose into sentences.
 *
 * Deliberately conservative: a "." only ends a sentence when it is not a
 * decimal point AND the next non-space character starts a sentence. Without
 * that guard "steady at 5.50%" becomes "steady at 5" + "50%", which is exactly
 * the kind of silent data corruption a market briefing cannot afford.
 */
export function splitSentences(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
    if (ch === '.' && /[0-9]/.test(s[i - 1] ?? '') && /[0-9]/.test(s[i + 1] ?? '')) continue; // 5.50
    let j = i + 1;
    while (j < s.length && /["')\]]/.test(s[j])) j++; // closing quotes / brackets
    if (j >= s.length) {
      out.push(s.slice(start, j).trim());
      start = j;
      i = j - 1;
      continue;
    }
    const rest = s.slice(j);
    const nextNonSpace = (rest.match(/\S/) ?? [''])[0];
    if (/\s/.test(rest[0] ?? '') && /[A-Z"'“(]/.test(nextNonSpace)) {
      out.push(s.slice(start, j).trim());
      start = j;
      i = j - 1;
    }
  }
  if (start < s.length) out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * Cut a body of text at a SENTENCE boundary inside a word budget.
 *
 * Never returns "…" and never cuts mid-sentence (PART 3): a reader must be
 * able to read the last word of what is on screen. If even the first sentence
 * exceeds the budget it is kept whole rather than beheaded — an over-long
 * sentence still reads as a sentence.
 */
export function sentences(text, { maxWords = 110 } = {}) {
  const parts = splitSentences(text);
  if (!parts.length) return '';
  let out = '';
  let words = 0;
  for (const p of parts) {
    const w = p.split(/\s+/).length;
    if (out && words + w > maxWords) break;
    out = out ? `${out} ${p}` : p;
    words += w;
    if (words >= maxWords) break;
  }
  return out;
}

/**
 * Short reason for a watch-list row: the FIRST CLAUSE of the analysis if it
 * stands on its own (3–12 words), otherwise a structured category/sector tag.
 * Never ends in "…" — a watchlist annotation should read like an annotation.
 */
const REASON_SPLIT = /\s+[—–;:]\s+|\s+—\s*/;

function shortReason(event, { maxWords = 12 } = {}) {
  const rel = event?.ai_verdict?.market_relevance;
  if (typeof rel === 'string' && rel.trim()) {
    const clause = String(rel).replace(/\s+/g, ' ').split(REASON_SPLIT)[0].trim().replace(/[.,;]$/, '');
    const n = clause.split(/\s+/).filter(Boolean).length;
    if (n >= 2 && n <= maxWords) return clause;
  }
  const bits = [categoryLabel(event?.category), (event?.sectors ?? [])[0]].filter(Boolean);
  if (bits.length) return bits.join(' • ');
  return shortClause(event?.title ?? '', maxWords);
}

/** First clause of a headline/summary, used when no analysis exists. */
function shortClause(text, maxWords = 8) {
  const first = splitSentences(text)[0] ?? '';
  const clause = first.split(REASON_SPLIT)[0].trim().replace(/[.,;]$/, '');
  const words = clause.split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? clause : words.slice(0, maxWords).join(' ');
}

// ------------------------------------------------------------ freshness

/**
 * Raw-age filter (§12) — kept because the intraday and alert paths still want
 * it, and because the pre-market RELEVANCE window needs a hard horizon to fall
 * back on. A material UPDATE is always retained.
 */
export function filterFresh(events = [], { now = new Date(), maxAgeHours = 48 } = {}) {
  const nowMs = now.getTime();
  const maxMs = maxAgeHours * 3600 * 1000;
  const kept = [];
  const dropped = [];
  for (const e of events ?? []) {
    const updated = e?.detection_status === 'UPDATED';
    const ts = eventTimestamp(e);
    const age = ts === null ? Infinity : nowMs - ts.getTime();
    if (updated) {
      kept.push({ ...e, updated: true });
      continue;
    }
    if (Number.isFinite(age) && age >= -6 * 3600 * 1000 && age <= maxMs) kept.push(e);
    else dropped.push(e);
  }
  return { kept, dropped };
}

/** Parsed publication instant (fallback: detection time), or null. */
export function eventTimestamp(e) {
  const raw = e?.published_at ?? e?.first_seen_at ?? e?.detected_at ?? '';
  const ts = Date.parse(raw ?? '');
  return Number.isFinite(ts) ? new Date(ts) : null;
}

// ------------------------------------------------- event classification

/**
 * Bucket + display label for one event (§PART 13). Labels are identity only —
 * they classify WHEN something happened, they never assert a fact.
 */
export const EVENT_TAGS = Object.freeze({
  overnight: { label: 'OVERNIGHT', emoji: '🌙' },
  session: { label: 'PREVIOUS SESSION — STILL RELEVANT', emoji: '👀' },
  closing_session: { label: 'TODAY’S SESSION', emoji: '📊' },
  updated: { label: 'UPDATED', emoji: '🔄' },
  today: { label: 'TODAY’S EVENT', emoji: '📅' },
  earlier: { label: 'ONGOING', emoji: '🔵' },
});

export function classifyEvent(e, windows) {
  if (e?.detection_status === 'UPDATED') return 'updated';
  const ts = eventTimestamp(e);
  if (!ts || !windows) return 'earlier';
  // The two report types walk their window in opposite order: a close report
  // anchors on TODAY'S open, a pre-market report anchors on the previous close.
  if (windows.type === 'closing') {
    if (ts >= windows.sessionStart) return 'closing_session';
    if (ts >= windows.overnightStart) return 'overnight';
    return 'earlier';
  }
  if (ts >= windows.overnightStart) return 'overnight';
  if (ts >= windows.sessionStart) return 'session';
  return 'earlier';
}

/**
 * Previous-session relevance score (§PART 25).
 *
 * A previous-day story stays in KEEP AN EYE ON TODAY when it has unresolved
 * market implications, pending official confirmation, a named stock/sector, or
 * it collides with a theme that is live today. This is EVENT RELEVANCE, not
 * ARTICLE FRESHNESS — a two-day-old policy thread scores higher than an
 * hour-old trivia piece.
 */
export function relevanceScore(e = {}, { themes = [] } = {}) {
  let s = 0;
  const level = e.importance_level;
  if (level === 'HIGH') s += 3;
  else if (level === 'MEDIUM') s += 2;
  // LOW scores nothing: a low-value story must not survive on age alone.

  if (e.detection_status === 'UPDATED') s += 3; // something actually changed

  const status = statusShort(e);
  if (status === 'Awaiting official confirmation' || status === 'Unconfirmed') s += 2;

  if ((e.companies ?? []).length || (e.sectors ?? []).length) s += 1; // hits a named stock/sector
  if (typeof e.ai_verdict?.market_relevance === 'string' && e.ai_verdict.market_relevance.trim()) s += 1;

  if (themes.length && matchesTheme(e, themes)) s += 3; // still on today's agenda
  return s;
}

function matchesTheme(e, themes) {
  const hay = [
    e.category,
    ...(e.institutions ?? []),
    ...(e.sectors ?? []),
    e.title,
  ]
    .map((v) => String(v ?? '').toUpperCase())
    .join(' ');
  return themes.some((t) => hay.includes(String(t).toUpperCase()));
}

/**
 * Story selection: RELEVANCE window in front of the FRESHNESS horizon.
 *
 * Always kept  — overnight, the session itself, material updates
 * Score-kept    — anything relevant to today (§PART 25), however old
 * Hard horizon  — nothing older than `maxAgeHours`, ever (no FY24 revival)
 */
const DEFAULT_HORIZON_H = 96;

/**
 * Per-bucket quotas. Without them a pre-market run would spend every slot on
 * last night's copy and never show the previous session — the exact complaint
 * that made this redesign necessary. Unused slots are backfilled in rank order,
 * so a quiet bucket never costs the page content.
 */
const PREMARKET_QUOTA = { updated: 1, overnight: 3, session: 2, earlier: 1 };
const CLOSING_QUOTA = { updated: 1, closing_session: 3, overnight: 2, earlier: 1 };

export function selectStories(events = [], {
  type = 'premarket',
  now = new Date(),
  holidays = [],
  marketHours = {},
  windows = null,
  themes = [],
  maxAgeHours = DEFAULT_HORIZON_H,
  relevanceMin = 6,
  cap = 6,
  quotas = null,
} = {}) {
  const w = windows ?? sessionWindow({ type, now, holidays, marketHours });
  const nowMs = now.getTime();
  const horizonMs = maxAgeHours * 3600 * 1000;
  const items = [];
  const dropped = [];

  for (const e of events ?? []) {
    const ts = eventTimestamp(e);
    if (!ts) {
      dropped.push({ event: e, why: 'no timestamp' });
      continue;
    }
    const ageMs = nowMs - ts.getTime();
    const ageH = ageMs / 3600000;
    if (ageMs < -6 * 3600 * 1000) {
      dropped.push({ event: e, why: 'future-dated' });
      continue;
    }
    const updated = e.detection_status === 'UPDATED';
    if (!updated && ageMs > horizonMs) {
      dropped.push({ event: e, why: 'past horizon' });
      continue;
    }

    const bucket = classifyEvent(e, w);
    const score = relevanceScore(e, { themes });
    const structural = updated || ts.getTime() >= w.structuralStart.getTime();
    const fresh = ageH <= 12;
    const relevant = score >= relevanceMin;

    if (!structural && !fresh && !relevant) {
      dropped.push({ event: e, why: `bucket=${bucket} score=${score} age=${ageH.toFixed(0)}h` });
      continue;
    }
    items.push({ event: e, bucket, score, ageH, ts });
  }

  const bucketRank = {
    updated: 5,
    closing_session: 4,
    overnight: 4,
    session: 3,
    earlier: 1,
  };
  items.sort(
    (a, b) =>
      (bucketRank[b.bucket] ?? 0) - (bucketRank[a.bucket] ?? 0) ||
      order(b.event.importance_level) - order(a.event.importance_level) ||
      (b.event.importance ?? 0) - (a.event.importance ?? 0) ||
      b.score - a.score ||
      b.ts - a.ts
  );

  // Bucket quotas first (so every window the report names is actually present),
  // then rank order to fill whatever slots are left.
  const q = quotas ?? (type === 'closing' ? CLOSING_QUOTA : PREMARKET_QUOTA);
  const chosen = [];
  const used = new Set();
  for (const [bucket, limit] of Object.entries(q)) {
    if (chosen.length >= cap) break;
    for (const it of items.filter((x) => x.bucket === bucket).slice(0, limit)) {
      if (chosen.length >= cap) break;
      chosen.push(it);
      used.add(it.event);
    }
  }
  for (const it of items) {
    if (chosen.length >= cap) break;
    if (used.has(it.event)) continue;
    chosen.push(it);
    used.add(it.event);
  }
  chosen.sort((a, b) => items.indexOf(a) - items.indexOf(b));

  return { items: chosen, dropped, windows: w };
}

const order = (lvl) => ({ HIGH: 3, MEDIUM: 2, LOW: 1 }[lvl] ?? 0);

// --------------------------------------------------------- dedup (§23)

const STOP = new Set(
  'a an the of for to in on at by with and or as is are was were be been from that this it its their our'.split(' ')
);

/**
 * Crude singular fold — outlets rarely agree on wording, but they do agree on
 * nouns: "positions"/"position", "limits"/"limit", "rates"/"rate". Without it
 * two reports of one circular score below the merge threshold and print twice.
 */
function stem(w) {
  if (w.length <= 3 || /ss$/.test(w)) return w;
  return /s$/.test(w) ? w.slice(0, -1) : w;
}

function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
      .map(stem)
  );
}

/** Jaccard over content tokens — "RBI holds rate" vs "RBI keeps repo rate". */
function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Do these two reports describe ONE story?
 *
 * A pure headline Jaccard misses real duplicates: "SEBI caps intraday positions
 * for prop desks from next month" vs "SEBI tightens intraday position limits
 * for prop desks" scores ~0.4 because the verbs differ — yet both are reporting
 * the same circular. Two outlets agree on WHO and WHAT far more reliably than
 * on wording, so same institution + same category earns a much lower bar.
 */
function isSameStory(a, b, { threshold, relatedThreshold }) {
  if (a.source_url && b.source_url && a.source_url === b.source_url) return true;
  const sim = similarity(a.headline, b.headline);
  if (sim >= threshold) return true;
  if (a.slug && b.slug && a.slug === b.slug && sim >= relatedThreshold) return true;
  return false;
}

/**
 * One EVENT, several outlets (§PART 23). The highest-importance report becomes
 * the primary; the rest collapse into `supporting_sources` so the page never
 * shows Reuters / ET / Moneycontrol / Livemint as four separate stories.
 */
export function dedupeStories(blocks = [], { threshold = 0.5, relatedThreshold = 0.34 } = {}) {
  const out = [];
  for (const b of blocks) {
    const hit = out.find((o) => isSameStory(o, b, { threshold, relatedThreshold }));
    if (!hit) {
      out.push({ ...b, supporting_sources: [] });
      continue;
    }
    if (b.source_name && b.source_name !== hit.source_name) {
      hit.supporting_sources ??= [];
      if (!hit.supporting_sources.some((s) => sourceKey(s.name) === sourceKey(b.source_name))) {
        hit.supporting_sources.push({ name: b.source_name, url: b.source_url ?? null });
      }
    }
  }
  return out;
}

// ------------------------------------------------- developments (§4/§10)

const IMPACT_LABELS = new Set(['positive', 'negative', 'mixed', 'neutral']);

function eventUrl(e) {
  const url = e.url ?? e.canonical_url ?? null;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * One editorial news block (§PART 4). Full headline, a body that ends on a
 * complete sentence, why it matters, source • time — no clamps, no "…".
 */
export function storyBlock(event, { rank = 1, bucket = 'session', now = new Date() } = {}) {
  const e = event;
  const verdict = e.ai_verdict ?? {};
  const tag = EVENT_TAGS[bucket] ?? EVENT_TAGS.earlier;
  // Main three get the longer budget (70–120w); secondary stories 40–70w.
  const maxWords = rank <= 3 ? 120 : 70;
  const body =
    sentences(e.ai_summary, { maxWords }) ||
    sentences(e.description, { maxWords }) ||
    sentences(e.content, { maxWords }) ||
    null;
  const why =
    typeof verdict.market_relevance === 'string' && verdict.market_relevance.trim()
      ? sentences(verdict.market_relevance, { maxWords: 34 })
      : null;

  return {
    rank,
    event_id: e.event_id ?? null,
    tag,
    bucket,
    updated: e.detection_status === 'UPDATED',
    category: categoryLabel(e.category) || 'MARKET',
    slug: [ (e.institutions ?? [])[0], categoryLabel(e.category) ]
      .map((x) => String(x ?? '').toUpperCase())
      .filter(Boolean)
      .join(' • '),
    headline: String(verdict.headline ?? e.title ?? '').trim(),
    summary: body,
    why_it_matters: why,
    impact: IMPACT_LABELS.has(verdict.impact) ? verdict.impact : null,
    status: statusShort(e),
    source_name: e.source ?? null,
    source_url: eventUrl(e),
    published_at: e.published_at ?? e.detected_at ?? null,
    sectors: e.sectors ?? [],
    companies: e.companies ?? [],
    relevance: relevanceScore(e),
  };
}

/**
 * Merging two outlets' reports of one event drops a number out of the middle of
 * the list. The rank is printed on the card, so renumber 01..N after dedupe
 * rather than publishing an unexplained gap (01, 03).
 */
export function renumber(blocks = []) {
  return blocks.map((b, i) => (b.rank === i + 1 ? b : { ...b, rank: i + 1 }));
}

/** Ranked, window-selected, deduplicated story blocks. */
export function developmentsFrom(events = [], opts = {}) {
  const { items } = selectStories(events, opts);
  return renumber(
    dedupeStories(
      items.map((it, i) => storyBlock(it.event, { rank: i + 1, bucket: it.bucket, now: opts.now }))
    )
  );
}

// ------------------------------------------- watch lists (§4 sections 4-5)

function reasonFor(event) {
  return shortReason(event);
}

/**
 * Stocks to watch (§4): ONLY stocks surfaced by the selected stories, each with
 * the actual reason it surfaced. Fewer than 3 → fewer (never padded).
 *
 * Companies that arrived through the SAME story share one reason, so they are
 * grouped onto a single row — three consecutive rows all reading
 * "Rate-sensitive sectors" is a formatting bug, not a briefing.
 */
export function stocksToWatch(events = [], opts = {}) {
  const { items } = selectStories(events, { cap: 8, ...opts });
  const cap = opts.cap ?? 7;
  const seen = new Set();
  const order = []; // reason → symbols, in first-seen order
  const byReason = new Map();

  for (const it of items) {
    if (seen.size >= cap) break;
    const reason = reasonFor(it.event);
    if (!byReason.has(reason)) {
      byReason.set(reason, []);
      order.push(reason);
    }
    const bucket = byReason.get(reason);
    for (const sym of it.event.companies ?? []) {
      if (seen.size >= cap) break;
      const key = String(sym).toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      bucket.push(key);
    }
  }

  return order
    .filter((reason) => byReason.get(reason).length)
    .map((reason) => {
      const symbols = byReason.get(reason);
      return { symbol: symbols.join(' · '), symbols, reason };
    });
}

/** Sectors to watch (§5) — same rule as stocks, sector level. */
export function sectorsToWatch(events = [], opts = {}) {
  const { items } = selectStories(events, { cap: 8, ...opts });
  const cap = opts.cap ?? 6;
  const out = [];
  const seen = new Set();
  for (const it of items) {
    for (const sec of it.event.sectors ?? []) {
      const key = String(sec).toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ sector: key, reason: sectorReason(it.event, sec) });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * A reason that just restates the row ("REGULATORY • Capital Markets" beside a
 * chip already reading CAPITAL MARKETS) tells the reader nothing — fall back to
 * the story's own opening clause, which is a real sentence about the sector.
 */
function sectorReason(event, sector) {
  const reason = reasonFor(event);
  const name = String(sector ?? '').toUpperCase();
  const withoutCat = String(reason ?? '')
    .split(' • ')
    .slice(1)
    .join(' • ')
    .trim();
  if (!name || !withoutCat || withoutCat.toUpperCase() !== name) return reason;
  const clause = shortClause(event?.title ?? '', 8);
  return clause || reason;
}

/**
 * KEEP AN EYE ON TODAY (§PART 11 section 4).
 *
 * Built from previous-session + overnight + ongoing stories that clear the
 * relevance bar, collapsed to one row per theme so the reader gets a agenda,
 * not a second copy of the news list. Label comes from the institution or the
 * category — never invented.
 */
export function keepAnEyeOn(events = [], opts = {}) {
  const { items, windows } = selectStories(events, { cap: 14, ...opts });
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const e = it.event;
    const inst = String((e.institutions ?? [])[0] ?? '').toUpperCase();
    const cat = categoryLabel(e.category).toUpperCase();
    // "RBI • MONETARY POLICY" — institution first when we have one, so the row
    // reads as an agenda item rather than another headline.
    const label = [inst, inst && inst !== cat ? cat : ''].filter(Boolean).join(' • ') || cat;
    if (!label || seen.has(label)) continue;
    const text =
      (typeof e.ai_verdict?.market_relevance === 'string' && e.ai_verdict.market_relevance.trim()
        ? sentences(e.ai_verdict.market_relevance, { maxWords: 26 })
        : null) ||
      sentences(e.ai_summary ?? e.description, { maxWords: 26 });
    if (!text) continue;
    seen.add(label);
    out.push({ label, text, tag: EVENT_TAGS[it.bucket] ?? EVENT_TAGS.earlier, score: it.score });
    if (out.length >= (opts.cap ?? 5)) break;
  }
  return { rows: out, windows };
}

/**
 * Fallback agenda built purely from measured data (PART 32).
 *
 * When the store has no usable events at all — a genuinely quiet overnight, or
 * a cold cache — KEEP AN EYE ON TODAY still lists what we actually measured
 * rather than disappearing. Every number here came from a snapshot; nothing is
 * inferred about what will happen.
 */
export function snapshotAgenda({ global = [], market = {} } = {}) {
  const EMOJI = { 'US EQUITIES': '🇺🇸', ASIA: '🌏', COMMODITIES: '🛢️', CURRENCY: '💱' };
  const tag = { emoji: '👀', label: '' };
  const rows = [];

  for (const g of global ?? []) {
    const parts = g.items.map((i) => {
      if (i.pct_change == null) return `${i.name} ${i.value != null ? i.value : 'N/A'}`;
      return `${i.name} ${i.pct_change > 0 ? '+' : ''}${Number(i.pct_change).toFixed(2)}%`;
    });
    if (!parts.length) continue;
    rows.push({
      label: `${EMOJI[g.group] ?? '🌍'} ${g.group}`,
      text: `${parts.join(' • ')} in the latest available read.`,
      tag,
      score: 0,
    });
  }

  if (!rows.length && market?.nifty) {
    rows.push({
      label: '📊 INDIAN MARKET',
      text:
        market.nifty.pct_change != null
          ? `Nifty 50 ${market.nifty.pct_change > 0 ? 'up' : 'down'} ${Math.abs(
              market.nifty.pct_change
            ).toFixed(2)}% in the latest available read.`
          : 'Nifty 50 snapshot available for the open.',
      tag,
      score: 0,
    });
  }
  return rows.slice(0, 5);
}

// ------------------------------------------ catalysts / risks (§4 §6)

const GLOBAL_EQUITY_RES = [RE.sp, RE.nasdaq, RE.dow, RE.nikkei, RE.hang, RE.shanghai];

/** Themes that are live today — used both for display and for relevance scoring. */
export function liveThemes({ developments = [], snapshots = [] } = {}) {
  const themes = new Set();
  const topics = developments.map((d) => `${d.headline} ${d.category}`);
  if (topics.some((t) => /\bRBI\b|MONETARY POLICY|REPO/i.test(t))) themes.add('RBI');
  if (topics.some((t) => /SEBI|REGULATORY/i.test(t))) themes.add('SEBI');
  if (topics.some((t) => /EARNINGS|RESULTS/i.test(t))) themes.add('EARNINGS');
  if (topics.some((t) => /CRUDE|OPEC|BRENT/i.test(t))) themes.add('CRUDE');
  if (pickSnapshot(snapshots, RE.sp) || pickSnapshot(snapshots, RE.nasdaq)) themes.add('US');
  if (pickSnapshot(snapshots, RE.fii)) themes.add('FII');
  return [...themes];
}

/**
 * Catalysts / risks (§4 section 6) — every bullet maps to data that is
 * actually present (an event topic or a snapshot sign). Empty → section omitted.
 */
export function deriveCatalysts({ developments = [], snapshots = [] } = {}) {
  const out = [];
  const has = (re) => Boolean(pickSnapshot(snapshots, re));
  const topics = developments.map((d) => `${d.headline} ${d.category}`);
  const seen = new Set();
  const add = (text) => {
    const t = String(text);
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  if (topics.some((t) => /\bRBI\b|MONETARY POLICY|REPO/i.test(t))) add('RBI policy');
  if (topics.some((t) => /SEBI|REGULATORY/i.test(t))) add('SEBI decisions');
  if (topics.some((t) => /EARNINGS|RESULTS/i.test(t))) add('Earnings flow');
  if (has(RE.sp) || has(RE.nasdaq) || has(RE.dow)) add('US cues');
  if (has(RE.fii)) add('FII flows');
  if (has(RE.crude)) add('Crude');
  if (has(RE.usdinr)) add('INR');
  return out.slice(0, 5);
}

export function deriveRisks({ developments = [], snapshots = [] } = {}) {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  const usdinr = snapRow(snapshots, RE.usdinr);
  if (usdinr?.pct_change != null && usdinr.pct_change > 0) add('INR weakness');
  const crude = snapRow(snapshots, RE.crude);
  if (crude?.pct_change != null && crude.pct_change > 0) add('Oil volatility');
  const equity = GLOBAL_EQUITY_RES.map((re) => snapRow(snapshots, re)).filter(
    (r) => r?.pct_change != null
  );
  const neg = equity.filter((r) => r.pct_change < 0).length;
  if (equity.length && neg >= equity.length - neg) add('Global risk-off');
  const text = developments.map((d) => `${d.headline} ${d.why_it_matters ?? ''}`).join(' ');
  if (/inflation/i.test(text)) add('Inflation');
  if (/\brate\s*(hike|cut|expectation|sensitiv)|repo\b/i.test(text)) add('Rate outlook');
  return out.slice(0, 4);
}

// ---------------------------------------------------------------- view

/** Interpretation (§4 §7): the best AI takeaway — never fabricated. */
export function viewText(events = [], preferred = []) {
  // The VIEW should comment on what is actually ON the page, so the selected
  // developments get first refusal. Raw importance rank is only a fallback —
  // otherwise a high-importance event that did not make the cut would speak
  // for a briefing it does not appear in.
  for (const e of preferred ?? []) {
    const t = e?.ai_verdict?.trader_takeaway;
    if (typeof t === 'string' && t.trim()) return t.trim();
  }
  const t = viewFromEvents(events, 5);
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

// ------------------------------------------------------------- sources

const snapSourceLabel = (s) => {
  const src = String(s?.source ?? '');
  if (/nse/i.test(src)) return 'NSE';
  if (/yfinance|yahoo/i.test(src)) return 'Yahoo Finance';
  return null;
};

/** Only sources actually used (§4 footer / §11). */
/**
 * Fold an outlet name to a comparison key so one paper under two spellings
 * ("The Economic Times" vs "Economic Times") is credited once, not twice.
 * The DISPLAY name is untouched — only the dedupe key is normalised.
 */
export const sourceKey = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^\s*the\s+/, '')
    .trim();

export function usedSources({ developments = [], snapshots = [] } = {}) {
  const out = [];
  const seen = new Set();
  const add = (name, url = null) => {
    const n = String(name ?? '').trim();
    const key = sourceKey(n);
    if (!n || !key || seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, url });
  };
  for (const d of developments) {
    add(d.source_name, d.source_url);
    for (const s of d.supporting_sources ?? []) add(s.name, s.url);
  }
  for (const s of snapshots) add(snapSourceLabel(s), null);
  return out;
}

// ------------------------------------------------------ closing extras

/** Structured movers split by sign (§18 top gainers / losers). */
export function moversFromSnapshots(snapshots = [], cap = 4) {
  const indexLike =
    /^(bank\s*nifty|nifty|s&p|dow|nasdaq|nikkei|hang|shanghai|usd|brent|crude|gold|fii|dii|advance|decline|gift|sensex)/i;
  const rows = snapshots
    .filter((s) => !indexLike.test(String(s.name)) && typeof s.pct_change === 'number')
    .map((s) => ({
      name: String(s.name),
      value: typeof s.value === 'number' ? s.value : null,
      pct_change: s.pct_change,
    }))
    .sort((a, b) => b.pct_change - a.pct_change);
  return {
    gainers: rows.filter((r) => r.pct_change > 0).slice(0, cap),
    losers: rows.filter((r) => r.pct_change < 0).sort((a, b) => a.pct_change - b.pct_change).slice(0, cap),
  };
}

/** NIFTY <sector> rows sorted by performance (§18 sector performance). */
export function sectorPerformance(snapshots = [], cap = 6) {
  return snapshots
    .filter((s) => /^nifty\s+[a-z& ]+$/i.test(String(s.name)) && typeof s.pct_change === 'number')
    .filter((s) => !RE.nifty.test(s.name) && !RE.banknifty.test(s.name))
    .map((s) => ({
      name: String(s.name).replace(/^nifty\s+/i, '').toUpperCase(),
      pct_change: s.pct_change,
      value: typeof s.value === 'number' ? s.value : null,
    }))
    .sort((a, b) => b.pct_change - a.pct_change)
    .slice(0, cap);
}

// ------------------------------------------------------- main builders

const GLOBAL_GROUPS = [
  ['US EQUITIES', [
    ['S&P 500', RE.sp],
    ['NASDAQ', RE.nasdaq],
    ['DOW', RE.dow],
  ]],
  ['ASIA', [
    ['NIKKEI', RE.nikkei],
    ['HANG SENG', RE.hang],
    ['SHANGHAI', RE.shanghai],
  ]],
  ['COMMODITIES', [
    ['BRENT', RE.crude],
    ['GOLD', RE.gold],
  ]],
  ['CURRENCY', [['USD/INR', RE.usdinr]]],
];

/** Global cues (§4 section 2) — only rows whose data exists. */
export function globalCues(snapshots = []) {
  const groups = [];
  for (const [label, entries] of GLOBAL_GROUPS) {
    const items = entries
      .map(([name, re]) => snapRow(snapshots, re, name))
      .filter(Boolean);
    if (items.length) groups.push({ group: label, items });
  }
  return groups;
}

/** Index rows (§4 section 1 / §18) — null value → renderer prints N/A. */
export function marketPulse(snapshots = []) {
  return {
    nifty: snapRow(snapshots, RE.nifty, 'NIFTY 50'),
    banknifty: snapRow(snapshots, RE.banknifty, 'BANK NIFTY'),
    sensex: snapRow(snapshots, RE.sensex, 'SENSEX'),
  };
}

// ------------------------------------------------ session synthesis (§6)

const pct = (p) => `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;

/** "MONDAY" -> "Monday"; "RBI" stays "RBI" — acronyms are never lower-cased. */
const ACRONYMS = new Set(['RBI', 'SEBI', 'NSE', 'BSE', 'FII', 'DII', 'IPO', 'IT', 'USD', 'INR', 'ETF', 'US', 'OPEC', 'SECTOR']);
function prose(label) {
  const t = String(label ?? '').trim();
  if (!t) return '';
  if (t.includes(' ')) return t.toLowerCase();
  return ACRONYMS.has(t.toUpperCase()) ? t.toUpperCase() : t.toLowerCase();
}
function listPhrase(items) {
  const parts = items.filter(Boolean).map(prose);
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
const upper = (d) => String(d ?? '').toUpperCase();

/**
 * WHAT DROVE THE MARKET (PART 6) — a SYNTHESIS of the session, composed only
 * from numbers we actually hold. It answers "why did the market behave that
 * way" from measured direction, measured leadership, measured breadth, measured
 * flows and the dominant news theme. It never copies a headline and never
 * asserts a cause we cannot show in the data.
 *
 * Returns null when there is nothing measurable to say — the template then
 * omits the section rather than printing a decorative empty box.
 */
export function sessionSynthesis({
  market = {},
  breadth = null,
  flows = null,
  sectors = [],
  developments = [],
  sessionWeekday = null,
  subject = 'Indian equities',
} = {}) {
  const rows = [market.nifty, market.sensex, market.banknifty].filter((r) => r?.pct_change != null);
  if (!rows.length) return null;

  const out = [];

  const directions = rows.map((r) => (r.pct_change > 0 ? 'up' : r.pct_change < 0 ? 'down' : 'flat'));
  const allUp = directions.every((d) => d === 'up');
  const allDown = directions.every((d) => d === 'down');
  const lead = market.nifty ?? rows[0];
  const leadName = lead.name === 'NIFTY 50' ? 'Nifty 50' : lead.name;
  const dirWord = allUp ? 'higher' : allDown ? 'lower' : 'mixed';
  const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'N/A');

  // The session weekday arrives either title-cased (weekdayName) or shouty
  // (calendar.weekday) — the prose must never read "on THURSDAY".
  const proseDay = sessionWeekday
    ? String(sessionWeekday)
        .toLowerCase()
        .replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
    : null;

  out.push(
    `${subject} ended ${dirWord}${proseDay ? ` on ${proseDay}` : ''}, with the ${leadName} at ` +
      `${fmt(lead.value)}${lead.pct_change != null ? ` (${pct(lead.pct_change)})` : ''}` +
      `${market.sensex?.pct_change != null && market.sensex !== lead ? ` and the Sensex ${pct(market.sensex.pct_change)}` : ''}.`
  );

  if (sectors.length >= 2) {
    const best = sectors[0];
    const worst = sectors[sectors.length - 1];
    if (best.pct_change > 0 && worst.pct_change < 0) {
      out.push(`${best.name} led at ${pct(best.pct_change)} while ${worst.name} lagged at ${pct(worst.pct_change)}.`);
    } else if (best.pct_change > 0) {
      out.push(`${best.name} led at ${pct(best.pct_change)} as gains spread across the board.`);
    } else if (best.pct_change < 0) {
      out.push(`${worst.name} was the weakest sector at ${pct(worst.pct_change)}.`);
    }
  }

  const adv = breadth?.advances?.value;
  const dec = breadth?.declines?.value;
  const flowBits = [];
  const fii = flows?.fii?.value;
  const dii = flows?.dii?.value;
  if (typeof fii === 'number' && typeof dii === 'number') {
    const money = (v) => Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    flowBits.push(
      `FII net ${fii > 0 ? 'inflows of' : 'outflows of'} ${money(fii)} against DII net ${dii > 0 ? 'buying of' : 'selling of'} ${money(dii)}`
    );
  }

  // Breadth and flows read as ONE sentence: they answer the same question
  // (who was actually buying?) and two separate lines cost a wrapping line on
  // every page of every render.
  if (typeof adv === 'number' && typeof dec === 'number') {
    const tone = adv > dec ? 'positive' : adv < dec ? 'negative' : 'even';
    out.push(
      `Breadth was ${tone}, with ${adv.toLocaleString('en-IN')} advances against ${dec.toLocaleString('en-IN')} declines` +
        `${flowBits.length ? `; ${flowBits[0]}` : ''}.`
    );
  } else if (flowBits.length) {
    out.push(`${flowBits[0][0].toUpperCase()}${flowBits[0].slice(1)}.`);
  }

  const themes = [...new Set(developments.slice(0, 3).map((d) => d.category))].filter(Boolean);
  if (themes.length) {
    out.push(`News flow was dominated by ${listPhrase(themes)} headlines.`);
  }

  return out.join(' ');
}

// ------------------------------------------------------- main builders

/**
 * buildVisualBriefing — the §19 contract for all three templates.
 * type: premarket | closing (breaking alerts use buildAlertBriefing).
 */
export function buildVisualBriefing({
  type = 'premarket',
  snapshots = [],
  events = [],
  now = new Date(),
  holidays = [],
  marketHours = {},
  freshHours = null,
  sample = false,
  imageCap = 3, // how many full editorial cards the POSTER may carry (adaptive)
} = {}) {
  const calendar = marketCalendar(now, holidays, marketHours);
  const isClosing = type === 'closing';

  // Windows come from the real trading calendar, not from a raw age cut.
  const windows = sessionWindow({ type, now, holidays, marketHours });

  const preSelect = {
    type,
    now,
    holidays,
    marketHours,
    windows,
    cap: imageCap,
    ...(freshHours ? { maxAgeHours: freshHours } : {}),
  };

  // Pass 1 - pick the structural window (overnight / session / updates) with no
  // theme bias, so we can see which topics are actually live today.
  const firstPass = selectStories(events, preSelect);
  const themes = liveThemes({
    developments: firstPass.items.map((it) => storyBlock(it.event, { bucket: it.bucket })),
    snapshots,
  });

  // Re-run selection now that today's themes are known (§PART 25 item 1):
  // a previous-session story about RBI is relevant BECAUSE RBI is on today.
  const { items, dropped: dropped2 } = selectStories(events, {
    ...preSelect,
    themes,
  });
  const developments = renumber(
    dedupeStories(
      items.map((it, i) => storyBlock(it.event, { rank: i + 1, bucket: it.bucket, now }))
    )
  );

  // The image is the executive cut; the PDF is the record. Anything the poster
  // could not fit still has to be readable somewhere, so the PDF draws from a
  // much wider selection (never truncated text — simply more of it).
  const fullItems = selectStories(events, {
    ...preSelect,
    themes,
    cap: 10,
    quotas: {},
  }).items;
  const developmentsFull = renumber(
    dedupeStories(
      fullItems.map((it, i) => storyBlock(it.event, { rank: i + 1, bucket: it.bucket, now }))
    )
  );

  const market = marketPulse(snapshots);
  const global = globalCues(snapshots);
  const breadthRow = snapRow(snapshots, RE.advances, 'ADVANCES');
  const declineRow = snapRow(snapshots, RE.declines, 'DECLINES');
  const breadth = breadthRow || declineRow ? { advances: breadthRow, declines: declineRow } : null;
  const fii = snapRow(snapshots, RE.fii, 'FII');
  const dii = snapRow(snapshots, RE.dii, 'DII');
  const flows = fii || dii ? { fii, dii } : null;
  const sectors = sectorPerformance(snapshots, 6);

  const stocks = stocksToWatch(events, { ...preSelect, themes, cap: 7 });
  const sectorsWatch = sectorsToWatch(events, { ...preSelect, themes, cap: 6 });
  const keep = keepAnEyeOn(events, { ...preSelect, themes, cap: 5 });
  // A quiet overnight must still produce an agenda — from measured data.
  const keepRows = keep.rows.length ? keep.rows : snapshotAgenda({ global, market });
  const catalysts = deriveCatalysts({ developments, snapshots });
  const risks = deriveRisks({ developments, snapshots });
  const view = viewText(
    events,
    items.map((it) => it.event)
  );

  const synthesis = sessionSynthesis({
    market,
    breadth,
    flows,
    sectors,
    developments,
    sessionWeekday: isClosing ? calendar.weekday : weekdayName(windows.sessionDate),
    subject: 'Indian equities',
  });

  const brief = {
    type,
    date: calendar.date,
    generated_at: now.toISOString(),
    market_status: calendar.kind,
    calendar,
    windows: {
      session_date: windows.sessionDate,
      session_start: windows.sessionStart.toISOString(),
      session_end: windows.sessionEnd.toISOString(),
      overnight_start: windows.overnightStart ? windows.overnightStart.toISOString() : null,
      label: windows.label,
    },
    market,
    global,
    // Editorial synthesis of the SESSION (§PART 6) — never a headline copy.
    driver: synthesis,
    previous_session: synthesis
      ? {
          label: windows.label,
          date: windows.sessionDate,
          synthesis,
          market,
          sectors: sectors.slice(0, 4),
          breadth,
          flows,
        }
      : null,
    // Individual events (§PART 6) — the counterpart to `driver`.
    developments,
    top_developments: developments, // legacy alias consumed by the QA gate
    developments_full: developmentsFull, // PDF/detail view — the image's superset
    imageCap, // the poster budget this plan was built with (see renderPlanPages)
    keep_an_eye: keepRows,
    stocks_to_watch: stocks,
    sectors_to_watch: sectorsWatch,
    catalysts,
    risks,
    view,
    // Sources reflect the FULL selection, not the poster's cut — the footer
    // must credit what the report (and its PDF) was built from.
    sources: usedSources({ developments: developmentsFull, snapshots }),
    sample,
    stats: {
      considered: events?.length ?? 0,
      selected: developments.length,
      dropped: dropped2.length,
      windows: windows.label,
    },
  };

  if (isClosing) {
    brief.breadth = breadth;
    brief.flows = flows;
    brief.movers = moversFromSnapshots(snapshots, 4);
    brief.sector_performance = sectors;
    brief.watch_next = {
      stocks: stocks.slice(0, 6).map((s) => s.symbol),
      sectors: sectorsWatch.slice(0, 5).map((s) => s.sector),
    };
    brief.previous_session = null; // a close report describes TODAY, not yesterday
  }

  return brief;
}

// -------------------------------------------------- breaking alert (§17)

const ALERT_STATUS = {
  Confirmed: ['CONFIRMED', 'b-confirmed'],
  Reported: ['REPORTED', 'b-reported'],
  'Awaiting official confirmation': ['AWAITING CONFIRMATION', 'b-awaiting'],
  Unconfirmed: ['UNCONFIRMED', 'b-unconfirmed'],
};

/**
 * buildAlertBriefing — structured contract for the 1080×1080 alert image.
 * Only called for events that already passed the publication gate.
 */
export function buildAlertBriefing({ event = {}, verdict = {}, now = new Date(), sample = false } = {}) {
  const v = { ...(event.ai_verdict ?? {}), ...verdict };
  const status = statusShort(event);
  const [statusLabel, statusClass] = ALERT_STATUS[status] ?? ALERT_STATUS.Reported;
  const impact = IMPACT_LABELS.has(v.impact) ? v.impact : null;
  const url = eventUrl(event);
  const summary = [v.summary, event.description]
    .map((s) => (typeof s === 'string' && s.trim() ? s.trim() : null))
    .find(Boolean);
  return {
    type: 'breaking',
    breaking: isBreaking(event, v),
    date: now.toISOString().slice(0, 10),
    generated_at: now.toISOString(),
    category: String(event.category ?? 'MARKET').toUpperCase(),
    headline: String(v.headline ?? event.title ?? '').trim(),
    // Alert body still has a bounded budget (the card is fixed-size), but it
    // ends on a complete sentence instead of "…".
    summary: summary ? sentences(summary, { maxWords: 70 }) : null,
    impact,
    why_it_matters:
      typeof v.market_relevance === 'string' && v.market_relevance.trim()
        ? sentences(v.market_relevance, { maxWords: 30 })
        : null,
    stocks: (Array.isArray(v.affected_stocks) && v.affected_stocks.length
      ? v.affected_stocks
      : event.companies ?? []
    ).slice(0, 5),
    sectors: (Array.isArray(v.affected_sectors) && v.affected_sectors.length
      ? v.affected_sectors
      : event.sectors ?? []
    ).slice(0, 5),
    status,
    status_label: statusLabel,
    status_class: statusClass,
    source_name: event.source ?? null,
    source_url: url,
    published_at: event.published_at ?? event.detected_at ?? null,
    sample,
  };
}
