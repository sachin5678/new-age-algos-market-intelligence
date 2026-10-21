/**
 * The post-market wrap — the channel's daily post, in Telegram text.
 *
 * The layout follows the market-closing-wrap format readers already know:
 *
 *   🇮🇳 MARKET CLOSING WRAP | 21 OCT 2026
 *   📉 NIFTY 50 FALLS 78 POINTS | INDIACEM LEADS THE TAPE
 *   ◆ NIFTY 50: 22,811.35  🟢 -0.34%
 *   ──────────────
 *   📊 KEY HIGHLIGHTS
 *   ──────────────
 *   📰 BIGGEST NEWS
 *   ──────────────
 *   🔥 TOP MOVERS · NIFTY 500
 *
 * Rules inherited from the rest of the product:
 *   - a section with no data is OMITTED, never fabricated;
 *   - every dynamic string is escaped before it reaches a Telegram tag;
 *   - the message is ONE message (never chunked into "part 1 of 2").
 *
 * The numbers come from src/briefings/wrap.js — the same derivation the card
 * uses, so the two can never disagree.
 */

import { esc } from './theme.js';
import { buildWrapData } from '../briefings/wrap.js';

/** Telegram's hard limit for one message. */
const MESSAGE_LIMIT = 4096;

/** A section rule, the same hairline the card draws. */
const RULE = '━━━━━━━━━━━━━━━━━━━━━━';

/** "22,811.35" in the Indian format. */
const fmtIndex = (v) =>
  Number.isFinite(Number(v))
    ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';

/** "+10.06%" / "-17.65%". */
const fmtPct = (p) =>
  Number.isFinite(Number(p)) ? `${Number(p) > 0 ? '+' : ''}${Number(p).toFixed(2)}%` : '—';

/** The direction dot: green up, red down, white flat. */
const dot = (p) => (Number(p) > 0 ? '🟢' : Number(p) < 0 ? '🔴' : '⚪');

/** The emoji that opens the session headline. */
const headEmoji = (headline) =>
  headline.includes('FALLS') ? '📉' : headline.includes('GAINS') ? '📈' : '📊';

/** "◆ NIFTY 50: 22,811.35  🟢 -0.34%" */
const indexRow = (i) =>
  `◆ ${esc(String(i.name ?? '').toUpperCase())}: ${esc(fmtIndex(i.value))}  ${dot(i.pct_change)} ${esc(fmtPct(i.pct_change))}`;

/** "• NIFTY 50 closed 0.34% lower at 22,811.35" */
const highlightRow = (h) => `• ${esc(h)}`;

/** "🟢 INDIACEM: +12.04% — India Cements Ltd." */
const moverRow = (m) =>
  `${dot(m.pct)} ${esc(String(m.symbol ?? '').toUpperCase())}: ${esc(fmtPct(m.pct))} — ${esc(String(m.name ?? ''))}`;

/** The story: headline, why it matters, source. */
function storyBlock(story) {
  if (!story || !story.headline) return null;
  const lines = [`<b>${esc(story.headline)}</b>`];
  if (story.why) lines.push(esc(story.why));
  if (story.source) {
    lines.push(
      story.url
        ? `— <a href="${esc(story.url)}">${esc(story.source)}</a>`
        : `— ${esc(story.source)}`
    );
  }
  return lines.join('\n');
}

/**
 * The daily post.
 *
 * @param {object} ctx  { indices, gainers, losers, story, now }
 * @returns {string}    one Telegram HTML message
 */
export function formatMarketWrap(ctx = {}, opts = {}) {
  const now = opts.now ?? ctx.now ?? new Date();
  const wrap = buildWrapData(ctx, { now });

  const blocks = [];

  // Header
  blocks.push([`🇮🇳 <b>MARKET CLOSING WRAP</b> | ${esc(wrap.date)}`]);

  // Session headline — computed, never written
  blocks.push([`${headEmoji(wrap.headline)} <b>${esc(wrap.headline)}</b>`]);

  // The benchmark line
  if (wrap.indices.length) {
    blocks.push([wrap.indices.map(indexRow).join('\n')]);
  }

  // Key highlights
  if (wrap.highlights.length) {
    blocks.push([RULE, `📊 <b>KEY HIGHLIGHTS</b>`, ...wrap.highlights.map(highlightRow)]);
  }

  // The one story of the day
  const story = storyBlock(wrap.story);
  if (story) {
    blocks.push([RULE, `📰 <b>BIGGEST NEWS</b>`, story]);
  }

  // The movers
  if (wrap.gainers.length || wrap.losers.length) {
    blocks.push([
      RULE,
      `🔥 <b>TOP MOVERS</b> <i>NIFTY 500</i>`,
      ...wrap.gainers.map(moverRow),
      ...wrap.losers.map(moverRow),
    ]);
  }

  // Brand tail
  blocks.push([
    `⚡ <b>NEW AGE ALGOS</b> · <i>Data-driven • Systematic • Transparent · Not investment advice</i>`,
  ]);

  const text = blocks.map((b) => b.join('\n')).join('\n\n');
  return text.length <= MESSAGE_LIMIT ? text : trimToBudget(text);
}

/** Last resort: drop whole body lines (never the header or the brand tail). */
function trimToBudget(text) {
  const lines = text.split('\n');
  const head = lines.slice(0, 2);
  const tail = lines.slice(-1);
  let body = lines.slice(2, -1);
  const render = () => [...head, ...body, ...tail].join('\n');
  while (body.length && render().length > MESSAGE_LIMIT) body.pop();
  return render();
}
