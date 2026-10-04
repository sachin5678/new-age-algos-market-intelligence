/**
 * Structured visual briefing contract (§19).
 *
 * Turns the SAME structured data the text briefings use (snapshots from the
 * market/global providers + recent events from the store) into one neutral
 * object the deterministic renderer consumes. Nothing is invented:
 *
 *   - missing metrics stay null → renderer prints N/A
 *   - freshness (§12): stale published_at events are dropped unless the event
 *     is a material UPDATE (labelled "UPDATED")
 *   - market calendar (§13): reuses config/holidays.json + marketHours —
 *     weekend/holiday never masquerades as a normal pre-market
 *   - catalysts/risks are only derived from data actually present
 *   - stock/sector reasons come from the event that surfaced them
 *
 * Pure functions only — no I/O, no rendering, no delivery.
 */

import { rankEvents, viewFromEvents } from '../briefings/context.js';
import { statusShort, isBreaking } from '../telegram/format.js';
import { categoryLabel, trimText } from '../telegram/theme.js';

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

/**
 * Market calendar (§13) — reuses the exact holidays list and marketHours the
 * publication gate already uses. Returns status the template styles.
 *   kind: trading_day | weekend | holiday
 */
export function marketCalendar(now = new Date(), holidays = [], marketHours = {}) {
  const tz = marketHours.timezone ?? 'Asia/Kolkata';
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

// ------------------------------------------------------------ freshness

/**
 * Stale-story filter (§12).
 *
 * Keeps an event when its published_at (fallback: detection time) is inside
 * the freshness window, OR when it is a material UPDATE (detection_status
 * UPDATED) — those are kept and flagged `updated: true` so the template can
 * label them "UPDATED". Everything else (old FY24/FY25 copy that merely ranks
 * high) is dropped.
 */
export function filterFresh(events = [], { now = new Date(), maxAgeHours = 48 } = {}) {
  const nowMs = now.getTime();
  const maxMs = maxAgeHours * 3600 * 1000;
  const kept = [];
  const dropped = [];
  for (const e of events ?? []) {
    const updated = e?.detection_status === 'UPDATED';
    const ts = Date.parse(e?.published_at ?? e?.first_seen_at ?? e?.detected_at ?? '');
    const age = Number.isFinite(ts) ? nowMs - ts : Infinity;
    if (updated) {
      kept.push({ ...e, updated: true });
      continue;
    }
    if (Number.isFinite(age) && age >= -6 * 3600 * 1000 && age <= maxMs) kept.push(e);
    else dropped.push(e);
  }
  return { kept, dropped };
}

// ------------------------------------------------- developments (§4/§10)

const IMPACT_LABELS = new Set(['positive', 'negative', 'mixed', 'neutral']);

function eventUrl(e) {
  const url = e.url ?? e.canonical_url ?? null;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** Ranked fresh events → visual development blocks (rank 01…). */
export function developmentsFrom(events = [], { now = new Date(), maxAgeHours = 48, cap = 5 } = {}) {
  const { kept } = filterFresh(events, { now, maxAgeHours });
  return rankEvents(kept, cap).map((e, i) => {
    const verdict = e.ai_verdict ?? {};
    const block = {
      rank: i + 1,
      event_id: e.event_id ?? null,
      updated: e.updated === true || e.detection_status === 'UPDATED',
      category: categoryLabel(e.category) || 'MARKET',
      institutions: e.institutions ?? [],
      headline: String(verdict.headline ?? e.title ?? '').trim(),
      summary: typeof e.ai_summary === 'string' && e.ai_summary.trim() ? e.ai_summary.trim() : null,
      why_it_matters:
        typeof verdict.market_relevance === 'string' && verdict.market_relevance.trim()
          ? verdict.market_relevance.trim()
          : null,
      impact: IMPACT_LABELS.has(verdict.impact) ? verdict.impact : null,
      status: statusShort(e),
      source_name: e.source ?? null,
      source_url: eventUrl(e),
      published_at: e.published_at ?? e.detected_at ?? null,
      sectors: e.sectors ?? [],
      companies: e.companies ?? [],
    };
    return block;
  });
}

// ------------------------------------------- watch lists (§4 sections 4-5)

function reasonFor(event, { max = 90 } = {}) {
  const relevance = event?.ai_verdict?.market_relevance;
  if (typeof relevance === 'string' && relevance.trim()) return trimText(relevance.trim(), max);
  const cat = categoryLabel(event?.category);
  const sector = (event?.sectors ?? [])[0];
  const bits = [cat, sector].filter(Boolean);
  if (bits.length) return trimText(bits.join(' • '), max);
  return trimText(event?.title ?? '', max);
}

/**
 * Stocks to watch (§4): ONLY stocks surfaced by the ranked fresh events,
 * each with the actual reason it surfaced. Fewer than 3 → fewer (never padded).
 */
export function stocksToWatch(events = [], { now = new Date(), maxAgeHours = 48, cap = 7 } = {}) {
  const { kept } = filterFresh(events, { now, maxAgeHours });
  const out = [];
  const seen = new Set();
  for (const e of rankEvents(kept, 8)) {
    for (const sym of e.companies ?? []) {
      const key = String(sym).toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ symbol: String(sym).toUpperCase(), reason: reasonFor(e) });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Sectors to watch (§5) — same rule as stocks, sector level. */
export function sectorsToWatch(events = [], { now = new Date(), maxAgeHours = 48, cap = 6 } = {}) {
  const { kept } = filterFresh(events, { now, maxAgeHours });
  const out = [];
  const seen = new Set();
  for (const e of rankEvents(kept, 8)) {
    for (const sec of e.sectors ?? []) {
      const key = String(sec).toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ sector: String(sec).toUpperCase(), reason: reasonFor(e) });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// ------------------------------------------ catalysts / risks (§4 §6)

const GLOBAL_EQUITY_RES = [RE.sp, RE.nasdaq, RE.dow, RE.nikkei, RE.hang, RE.shanghai];

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
  return out.slice(0, 4);
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
export function viewText(events = []) {
  const t = viewFromEvents(events, 3);
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
export function usedSources({ developments = [], snapshots = [] } = {}) {
  const out = [];
  const seen = new Set();
  const add = (name, url = null) => {
    const n = String(name ?? '').trim();
    if (!n || seen.has(n.toUpperCase())) return;
    seen.add(n.toUpperCase());
    out.push({ name: n, url });
  };
  for (const d of developments) add(d.source_name, d.source_url);
  for (const s of snapshots) add(snapSourceLabel(s), null);
  return out;
}

// ------------------------------------------------------ closing extras

/** Structured movers split by sign (§18 top gainers / losers). */
export function moversFromSnapshots(snapshots = [], cap = 4) {
  const indexLike =
    /^(nifty|s&p|dow|nasdaq|nikkei|hang|shanghai|usd|brent|crude|gold|fii|dii|advance|decline|gift|sensex)/i;
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
} = {}) {
  const maxAgeHours = freshHours ?? (type === 'closing' ? 24 : 48);
  const calendar = marketCalendar(now, holidays, marketHours);
  const developments = developmentsFrom(events, { now, maxAgeHours, cap: 5 });
  const stocks = stocksToWatch(events, { now, maxAgeHours, cap: 7 });
  const sectors = sectorsToWatch(events, { now, maxAgeHours, cap: 6 });
  const market = marketPulse(snapshots);
  const global = globalCues(snapshots);
  const catalysts = deriveCatalysts({ developments, snapshots });
  const risks = deriveRisks({ developments, snapshots });
  const view = viewText(events);

  const brief = {
    type,
    date: calendar.date,
    generated_at: now.toISOString(),
    market_status: calendar.kind,
    calendar,
    market,
    global,
    top_developments: developments,
    stocks_to_watch: stocks,
    sectors_to_watch: sectors,
    catalysts,
    risks,
    view,
    sources: usedSources({ developments, snapshots }),
    sample,
  };

  if (type === 'closing') {
    const adv = snapRow(snapshots, RE.advances, 'ADVANCES');
    const dec = snapRow(snapshots, RE.declines, 'DECLINES');
    brief.breadth = adv || dec ? { advances: adv, declines: dec } : null;
    const fii = snapRow(snapshots, RE.fii, 'FII');
    const dii = snapRow(snapshots, RE.dii, 'DII');
    brief.flows = fii || dii ? { fii, dii } : null;
    brief.movers = moversFromSnapshots(snapshots, 4);
    brief.sector_performance = sectorPerformance(snapshots, 6);
    // "what drove the market" = the single most important fresh development
    brief.key_driver = developments[0] ?? null;
    // tomorrow's watch = the same watch lists the pre-market would show
    brief.watch_next = {
      stocks: stocks.slice(0, 5).map((s) => s.symbol),
      sectors: sectors.slice(0, 4).map((s) => s.sector),
    };
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
    summary: summary ? trimText(summary, 320) : null,
    impact,
    why_it_matters:
      typeof v.market_relevance === 'string' && v.market_relevance.trim()
        ? v.market_relevance.trim()
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
