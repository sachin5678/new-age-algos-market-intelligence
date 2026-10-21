/**
 * The post-market wrap — the data behind the daily post.
 *
 * One source of truth for the numbers, so the Telegram message and the card
 * can never disagree: the session headline, the key highlights, the benchmark
 * line, the biggest story of the day and the day's top movers.
 *
 * Everything here is DERIVED from measured data. Nothing is written by hand:
 *
 *   "NIFTY 50 FALLS 78 POINTS | INDIACEM LEADS THE TAPE"
 *
 * The points come from the index value and its move, the leader from the top
 * mover, the highlights from the same numbers in words.
 */

import { cleanHeadline } from './context.js';

const fmtIndex = (v) =>
  Number.isFinite(Number(v))
    ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';

const fmtPct = (p) =>
  Number.isFinite(Number(p)) ? `${Number(p) > 0 ? '+' : ''}${Number(p).toFixed(2)}%` : '—';

/** Round to the nearest whole number (index points). */
const fmtPts = (n) => Math.abs(Math.round(Number(n))).toLocaleString('en-IN');

/** "21 Oct 2026" in IST. */
export function istDate(now) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
    .format(now)
    .toUpperCase();
}

/** "15:45 IST" in IST. */
export function istTime(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')} IST`;
}

/**
 * The session headline, derived from the numbers — never invented.
 *
 * "NIFTY 50 FALLS 78 POINTS | INDIACEM LEADS THE TAPE"
 */
export function sessionHeadline(indices = [], gainers = [], losers = []) {
  const nifty = indices.find((i) => /^nifty\s*50$/i.test(String(i.name ?? ''))) ?? indices[0];
  let left = 'SESSION CLOSE';
  if (nifty && Number.isFinite(Number(nifty.pct_change))) {
    const pct = Number(nifty.pct_change);
    const value = Number(nifty.value);
    const name = String(nifty.name ?? 'NIFTY 50').toUpperCase();
    // Points are derivable from the value and the move — no extra fetch.
    const prev = pct !== -100 ? value / (1 + pct / 100) : null;
    const points = Number.isFinite(prev) ? value - prev : null;
    if (pct > 0) left = `${name} GAINS ${fmtPts(points)} POINTS`;
    else if (pct < 0) left = `${name} FALLS ${fmtPts(points)} POINTS`;
    else left = `${name} ENDS FLAT`;
  }
  const leader = gainers[0]?.symbol
    ? String(gainers[0].symbol).toUpperCase()
    : losers[0]?.symbol
      ? String(losers[0].symbol).toUpperCase()
      : null;
  const right = gainers[0]?.symbol
    ? `${leader} LEADS THE TAPE`
    : losers[0]?.symbol
      ? `${leader} TOP LOSER`
      : null;
  return right ? `${left} | ${right}` : left;
}

/**
 * Two or three factual one-liners for the reader — every number comes from
 * the data, nothing is editorialised.
 */
export function keyHighlights(indices = [], gainers = [], losers = [], story = null) {
  const out = [];
  const nifty = indices.find((i) => /^nifty\s*50$/i.test(String(i.name ?? ''))) ?? indices[0];
  if (nifty && Number.isFinite(Number(nifty.pct_change))) {
    const pct = Number(nifty.pct_change);
    out.push(
      `NIFTY 50 closed ${Math.abs(pct).toFixed(2)}% ${pct < 0 ? 'lower' : 'higher'} at ${fmtIndex(nifty.value)}`
    );
  }
  const gainer = gainers[0];
  const loser = losers[0];
  if (gainer) {
    out.push(`${String(gainer.symbol).toUpperCase()} led the index, up ${Math.abs(Number(gainer.pct)).toFixed(2)}%`);
  }
  if (loser) {
    out.push(`${String(loser.symbol).toUpperCase()} lagged, down ${Math.abs(Number(loser.pct)).toFixed(2)}%`);
  }
  if (story?.why) out.push(String(story.why));
  return out.slice(0, 4);
}

/** Longest headline the wrap prints — a headline, not an article. */
export const MAX_HEADLINE_CHARS = 140;

/** Cut at a word boundary and mark the cut. */
export function trimWords(text, max = MAX_HEADLINE_CHARS) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * The wrap, ready to render — in Telegram text or as a card.
 *
 * @param {object} ctx  { indices, gainers, losers, story }
 */
export function buildWrapData(ctx = {}, { now = new Date() } = {}) {
  const indices = (ctx.indices ?? []).filter((i) => i && Number.isFinite(Number(i.value))).slice(0, 3);
  const gainers = (ctx.gainers ?? []).filter((m) => m && Number.isFinite(Number(m.pct))).slice(0, 3);
  const losers = (ctx.losers ?? []).filter((m) => m && Number.isFinite(Number(m.pct))).slice(0, 3);
  const rawStory = ctx.story ?? null;

  const story = rawStory
    ? {
        headline: trimWords(cleanHeadline(rawStory.headline ?? rawStory.t ?? '')),
        why: trimWords(String(rawStory.relevance ?? '').trim(), 160),
        source: String(rawStory.source ?? '').trim(),
        url: rawStory.url ?? null,
      }
    : null;

  return {
    date: istDate(now),
    time: istTime(now),
    headline: sessionHeadline(indices, gainers, losers),
    highlights: keyHighlights(indices, gainers, losers, story),
    indices,
    gainers,
    losers,
    story,
  };
}
