/**
 * Post-market wrap — the one message the channel posts at the end of a
 * session.
 *
 * The reader asked for exactly this and nothing else:
 *   - the day's top 3 gainers (NIFTY 500)
 *   - the day's top 3 losers (NIFTY 500)
 *   - the single biggest news of the day
 *
 * A pre-market summary and the old multi-section closing digest are gone.
 * What is left is one message a trader can read on a phone in ten seconds:
 * what moved, and why it moved.
 *
 * Rules inherited from the rest of the product:
 *   - a section with no data is OMITTED, never fabricated;
 *   - every dynamic string is escaped before it reaches a Telegram tag;
 *   - the message is ONE message (never chunked into "part 1 of 2").
 */

import { SEP, esc, trimText, fmtDate, fmtTime } from './theme.js';

/** Content lines a wrap may use (header + 3 + 3 + news + brand). */
export const WRAP_MAX_LINES = 16;

/** Telegram's hard limit for one message. */
const MESSAGE_LIMIT = 4096;

/** "24,812.35" in the Indian format. */
function fmtPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** "+10.06%" / "-17.65%". */
function fmtPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** "NIFTY 50 24,812.35 (-0.42%)" from a structured index row. */
function indexCell(row) {
  const value = fmtPrice(row.value);
  const pct = typeof row.pct_change === 'number' ? row.pct_change : null;
  const pctTxt = pct == null ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  return `${esc(String(row.name ?? '').toUpperCase())} ${value}${pctTxt}`;
}

/**
 * "1. INDIACEM +10.06% — India Cements Ltd. @ ₹323.95"
 *
 * The symbol carries the trade, the percentage carries the move, the name
 * tells the reader which company it is and the price anchors it.
 */
function moverLine(mover, n) {
  const symbol = esc(String(mover.symbol ?? '').toUpperCase());
  const pct = esc(fmtPct(mover.pct));
  const name = esc(trimText(String(mover.name ?? ''), 38));
  const price = esc(fmtPrice(mover.price));
  const tail = name ? ` — ${name}` : '';
  return `${n}. <b>${symbol}</b> ${pct}${tail} @ ₹${price}`;
}

/** The single biggest story: headline, why it matters, source. */
function newsLine(story) {
  if (!story) return null;
  const headline = esc(trimText(String(story.headline ?? story.t ?? ''), 120));
  if (!headline) return null;
  const parts = [`<b>${headline}</b>`];

  const why = esc(trimText(String(story.relevance ?? ''), 90));
  if (why) parts.push(why);

  if (story.source) {
    const link = story.url
      ? `<a href="${esc(String(story.url))}">${esc(String(story.source))}</a>`
      : esc(String(story.source));
    parts.push(link);
  }
  return parts.join(' — ');
}

/**
 * 🌙 Post-market wrap.
 *
 * @param {object} ctx  { indices, gainers, losers, story, now }
 * @returns {string}    one Telegram HTML message
 */
export function formatMarketWrap(ctx = {}, opts = {}) {
  const now = opts.now ?? ctx.now ?? new Date();
  const blocks = [];

  // Header
  const when = `${fmtDate(now)} • ${fmtTime(now)}`;
  blocks.push([`🌙 <b>NEW AGE ALGOS</b> — <b>POST-MARKET</b> <i>${esc(when)}</i>`]);

  // Index pulse — one line, the benchmark the movers hang off.
  const indices = (ctx.indices ?? []).filter((i) => i && typeof i.value === 'number').slice(0, 3);
  if (indices.length) blocks.push([`📈 ${indices.map(indexCell).join(' • ')}`]);

  // Top gainers
  const gainers = (ctx.gainers ?? []).slice(0, 3);
  if (gainers.length) {
    blocks.push([
      `🟢 <b>TOP GAINERS</b> <i>NIFTY 500</i>`,
      ...gainers.map((g, i) => moverLine(g, i + 1)),
    ]);
  }

  // Top losers
  const losers = (ctx.losers ?? []).slice(0, 3);
  if (losers.length) {
    blocks.push([
      `🔴 <b>TOP LOSERS</b> <i>NIFTY 500</i>`,
      ...losers.map((l, i) => moverLine(l, i + 1)),
    ]);
  }

  // The one story of the day
  const story = newsLine(ctx.story);
  if (story) blocks.push([`📰 <b>BIGGEST NEWS</b>`, story]);

  // Brand tail
  blocks.push([
    SEP,
    `⚡ <b>NEW AGE ALGOS</b> · <i>Data-driven • Systematic • Transparent · Not investment advice</i>`,
  ]);

  const text = blocks.map((b) => b.join('\n')).join('\n\n');
  return text.length <= MESSAGE_LIMIT ? text : trimToBudget(text);
}

/** Last resort: drop whole body lines (never the header or the brand tail). */
function trimToBudget(text) {
  const lines = text.split('\n');
  const head = lines.slice(0, 1);
  const tail = lines.slice(-2);
  let body = lines.slice(1, -2);
  const render = () => [...head, ...body, ...tail].join('\n');
  while (body.length && render().length > MESSAGE_LIMIT) body.pop();
  return render();
}
