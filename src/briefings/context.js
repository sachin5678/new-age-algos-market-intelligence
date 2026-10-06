/**
 * Briefing context assembly: snapshots (MarketData/Global providers) +
 * recent events from the store → template context.
 *
 * Only uses data we actually have; missing sections stay undefined so the
 * templates omit them (nothing is ever fabricated).
 */

import { statusShort } from '../telegram/format.js';

/**
 * Ranked recent events → development blocks capped.
 *
 * `t` (legacy "Headline (Source)" string) is kept for existing consumers; the
 * extra fields are purely presentational so the templates can render a source
 * hyperlink, a confirmation badge, a story slug and — when the analysis
 * produced one — a "why it matters" line and a view. Nothing is invented:
 * every field already exists on the stored event.
 */
export function developmentsFromEvents(events = [], cap = 5) {
  return rankEvents(events, cap).map((e) => {
    const verdict = e.ai_verdict ?? {};
    const block = {
      t: `${e.title}${e.source ? ` (${e.source})` : ''}`,
      headline: e.title,
      level: e.importance_level,
      source: e.source ?? null,
      url: e.url ?? e.canonical_url ?? null,
      status: statusShort(e),
      category: e.category ?? null,
      institutions: e.institutions ?? [],
      sectors: e.sectors ?? [],
      companies: e.companies ?? [],
    };
    const summary = typeof e.ai_summary === 'string' ? e.ai_summary.trim() : '';
    if (summary) block.summary = summary;
    const relevance = typeof verdict.market_relevance === 'string' ? verdict.market_relevance.trim() : '';
    if (relevance) block.relevance = relevance;
    const takeaway = typeof verdict.trader_takeaway === 'string' ? verdict.trader_takeaway.trim() : '';
    if (takeaway) block.takeaway = takeaway;
    return block;
  });
}

/** Best available interpretation across the ranked events (never fabricated). */
export function viewFromEvents(events = [], cap = 1) {
  for (const e of rankEvents(events, cap)) {
    const t = e?.ai_verdict?.trader_takeaway;
    if (typeof t === 'string' && t.trim()) return t.trim();
  }
  return null;
}

export function rankEvents(events = [], cap = 10) {
  const order = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  return [...(events ?? [])]
    .sort(
      (a, b) =>
        (order[b.importance_level] ?? 0) - (order[a.importance_level] ?? 0) ||
        (b.importance ?? 0) - (a.importance ?? 0)
    )
    .slice(0, cap);
}

const findSnap = (snaps, re) => snaps.find((s) => re.test(String(s.name)));

/** "1,234.5 (-0.4%)" — only from provided snapshot values. */
function fmtSnap(s) {
  if (!s || typeof s.value !== 'number') return null;
  const value = s.value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (typeof s.pct_change === 'number') {
    const pct = `${s.pct_change > 0 ? '+' : ''}${s.pct_change.toFixed(2)}%`;
    return `${value} (${pct})`;
  }
  if (typeof s.change === 'number' && s.change !== 0) {
    const ch = `${s.change > 0 ? '+' : ''}${s.change.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    return `${value} (${ch})`;
  }
  return value;
}

function fmtNamed(snaps, re) {
  const s = findSnap(snaps, re);
  const v = fmtSnap(s);
  return v ? `${s.name}: ${v}` : null;
}

const labeled = (label, snaps, re) => {
  const s = findSnap(snaps, re);
  const v = fmtSnap(s);
  return v ? `${label}: ${v}` : null;
};

const usdinrLine = (snaps) => labeled('USD/INR', snaps, /usd\s*\/\s*inr|usdinr|rupee/i);
const crudeLine = (snaps) => labeled('Crude', snaps, /brent|crude|wti/i);
const goldLine = (snaps) => labeled('Gold', snaps, /gold/i);
const spLine = (snaps) => labeled('US (S&P 500)', snaps, /^s&p 500|^s&p500/i);
const nikkeiLine = (snaps) => labeled('Asia (Nikkei)', snaps, /nikkei/i);
const hangLine = (snaps) => labeled('Asia (Hang Seng)', snaps, /hang seng/i);

/** Watch list: top events → affected stocks, then sectors (text-supported only). */
export function watchlistFromEvents(events = [], cap = 6) {
  const out = [];
  const seen = new Set();
  const top = rankEvents(events, 8);
  for (const e of top) {
    for (const sym of e.companies ?? []) {
      const key = `sym:${sym}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sym);
      if (out.length >= cap) return out;
    }
  }
  for (const e of top) {
    for (const sec of e.sectors ?? []) {
      const key = `sec:${sec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${sec} sector`);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export function buildPreMarketContext({ snapshots = [], events = [], now = new Date(), keyEvents = [] } = {}) {
  const snaps = snapshots;
  const ctx = { date: undefined, now };
  const us = [
    fmtNamed(snaps, /^(s&p 500|s&p500)$/i),
    fmtNamed(snaps, /^nasdaq/i),
    fmtNamed(snaps, /^dow jones|^dow$/i),
  ].filter(Boolean);
  const asia = [
    fmtNamed(snaps, /nikkei/i),
    fmtNamed(snaps, /hang seng/i),
    fmtNamed(snaps, /shanghai/i),
  ].filter(Boolean);
  const usdinr = fmtSnap(findSnap(snaps, /usd\s*\/\s*inr|usdinr|rupee/i));
  const crude = fmtSnap(findSnap(snaps, /brent|crude|wti/i));
  const gold = fmtSnap(findSnap(snaps, /gold/i));
  const nifty = fmtSnap(findSnap(snaps, /^nifty(\s*50)?$/i));
  const banknifty = fmtSnap(findSnap(snaps, /bank\s*nifty|nifty\s*bank/i));

  if (us.length) ctx.us = us;
  if (asia.length) ctx.asia = asia;
  if (usdinr) ctx.usdinr = usdinr;
  if (crude) ctx.crude = crude;
  if (gold) ctx.gold = gold;
  if (nifty) ctx.nifty = nifty;
  if (banknifty) ctx.banknifty = banknifty;
  const preIdx = indexRows(snaps);
  if (preIdx.length) ctx.indices = preIdx;

  const dev = developmentsFromEvents(events, 5);
  if (dev.length) ctx.developments = dev;
  const watch = watchlistFromEvents(events, 6);
  if (watch.length) ctx.watchlist = watch;
  if (keyEvents.length) ctx.keyEvents = keyEvents.slice(0, 6);
  const view = viewFromEvents(events, 3);
  if (view) ctx.view = view;

  return ctx;
}

/**
 * Structured index rows ({name, value, pct_change}) for the dashboard blocks.
 *
 * The three Indian indices a reader checks first: NIFTY 50, BANK NIFTY, SENSEX.
 * SENSEX used to be missing here while also missing from the mover filter below,
 * so BSE's benchmark turned up under KEY STOCK MOVERS instead of on the index
 * line — the same way "Bank Nifty" leaked, because it does not start with
 * "nifty".
 */
function indexRows(snaps) {
  return [
    findSnap(snaps, /^nifty(\s*50)?$/i),
    findSnap(snaps, /bank\s*nifty|nifty\s*bank/i),
    findSnap(snaps, /sensex/i),
  ]
    .filter((s) => s && typeof s.value === 'number')
    .map((s) => ({
      name: s.name,
      value: s.value,
      ...(typeof s.pct_change === 'number' ? { pct_change: s.pct_change } : {}),
    }));
}

export function buildClosingContext({ snapshots = [], events = [], now = new Date(), watchNext = [] } = {}) {
  const snaps = snapshots;
  const ctx = { date: undefined, now };

  const nifty = fmtSnap(findSnap(snaps, /^nifty(\s*50)?$/i));
  const banknifty = fmtSnap(findSnap(snaps, /bank\s*nifty|nifty\s*bank/i));
  if (nifty) ctx.nifty = nifty;
  if (banknifty) ctx.banknifty = banknifty;
  const closeIdx = indexRows(snaps);
  if (closeIdx.length) ctx.indices = closeIdx;

  const advances = findSnap(snaps, /advance/i);
  const declines = findSnap(snaps, /decline/i);
  if (advances) ctx.advances = advances.value;
  if (declines) ctx.declines = declines.value;

  // Sector performance: NIFTY <SECTOR> indices other than 50/BANK.
  const sectorSnaps = snaps
    .filter((s) => /^nifty\s+[a-z& ]+$/i.test(String(s.name)) && typeof s.pct_change === 'number')
    .filter((s) => !/^nifty(\s*50)?$/i.test(s.name) && !/bank/i.test(s.name))
    .sort((a, b) => b.pct_change - a.pct_change);
  if (sectorSnaps.length) {
    const asLine = (s) => `${s.name.replace(/^nifty\s+/i, '').toUpperCase()}: ${fmtSnap(s)}`;
    // Only real gainers under WHAT MOVED and real losers under LAGGARDS —
    // a mixed board must never label a +1.6% sector as a laggard.
    ctx.topSectors = sectorSnaps.slice(0, 6).map(asLine);
    const losers = sectorSnaps.filter((s) => s.pct_change < 0);
    if (losers.length) ctx.weakSectors = losers.slice().reverse().slice(0, 6).map(asLine);
  }

  // Stock movers: named non-index snapshots with pct_change (from market snapshots).
  // Prefix matching alone is not enough — "Bank Nifty" does not start with
  // "nifty" and "BSE SENSEX" does not start with "sensex", so both slipped
  // through and were printed under KEY STOCK MOVERS. Match them as whole words
  // too. Kept in step with src/visual/data.js moversFromSnapshots().
  const indexLike = (name) =>
    /^(nifty|s&p|dow|nasdaq|nikkei|hang|shanghai|usd|brent|crude|gold|fii|dii|advance|decline|gift)/i.test(name) ||
    /(^|\s)(nifty|sensex|bse)(\s|$)/i.test(name);
  const movers = snaps
    .filter((s) => !indexLike(String(s.name)) && typeof s.pct_change === 'number')
    .sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change))
    .map((s) => `${s.name}: ${fmtSnap(s)}`);
  if (movers.length) ctx.movers = movers;

  const dev = developmentsFromEvents(events, 5);
  if (dev.length) ctx.developments = dev;

  const fii = findSnap(snaps, /^fii/i);
  const dii = findSnap(snaps, /^dii/i);
  if (fii) ctx.fii = [`FII: ${fmtSnap(fii)}`];
  if (dii) ctx.dii = [`DII: ${fmtSnap(dii)}`];

  const global = [
    usdinrLine(snaps),
    crudeLine(snaps),
    goldLine(snaps),
    spLine(snaps),
    nikkeiLine(snaps),
    hangLine(snaps),
  ].filter(Boolean);
  if (global.length) ctx.global = global;

  if (watchNext.length) ctx.watchNext = watchNext.slice(0, 6);
  const view = viewFromEvents(events, 3);
  if (view) ctx.view = view;
  return ctx;
}
