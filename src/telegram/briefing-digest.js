/**
 * Compact single-message briefings — 10–12 lines, no images, no page spam.
 *
 * The long-form templates (formatPreMarket / formatClosing) render every
 * section and comfortably run 40–70 lines. That is right for a document, wrong
 * for a Telegram channel: readers saw 5–7 separate page images twice a day.
 * These digests answer "what do I need to know" in one message that is still
 * scannable on a phone.
 *
 * Rules inherited from the long-form templates:
 *   - a section with no data is OMITTED, never fabricated;
 *   - every dynamic string is escaped before it is embedded;
 *   - interpretation (view) stays visually distinct from fact.
 *
 * Hard cap: BRIEF_MAX_LINES. Layout is built as whole logical lines; when a
 * context carries more sections than the budget allows, cap() sheds the least
 * essential ones in a fixed order. The header, the index line, the
 * interpretation and the brand tail are never shed, so the message always
 * opens and closes as one brand.
 */

import { SEP, esc, trimText, fmtDate, fmtTime } from './theme.js';

/** Lines the reader asked for: one message, 10–12 lines. */
export const BRIEF_MAX_LINES = 12;

/** Story lines kept in the digest (lead story may carry a "why" clause). */
const MAX_STORIES = 2;

/** "NIFTY 50 24,612.45 (-0.42%)" from a structured index row. */
function indexCell(row) {
  const value = Number(row.value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const pct = typeof row.pct_change === 'number' ? row.pct_change : null;
  const pctTxt = pct == null ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  // esc(): snapshot names reach us raw ("S&P 500") and Telegram rejects a
  // bare '&' as unparseable entities.
  return `${esc(String(row.name ?? '').toUpperCase())} ${value}${pctTxt}`;
}

/** "IT: 1,432.5 (+1.20%)" → "IT +1.20%" — the label carries the meaning. */
function sectorCell(entry) {
  const [name, ...rest] = String(entry).split(':');
  const amount = rest.join(':').trim();
  const pct = amount.match(/\(([-+][\d.]+)%\)/);
  const value = pct ? `${pct[1]}%` : esc(trimText(amount, 40));
  return `${esc(String(name).trim().toUpperCase())}${value ? ` ${value}` : ''}`;
}

/** "TRENT: 6,120.00 (+5.20%)" → "TRENT +5.20%". */
function moverCell(entry) {
  const [name, ...rest] = String(entry).split(':');
  const amount = rest.join(':').trim();
  const pct = amount.match(/\(([-+][\d.]+)%\)/);
  return `${esc(String(name).trim().toUpperCase())}${pct ? ` ${pct[1]}%` : ''}`;
}

/**
 * One story as a single logical line: "1. Headline — why it matters · Source".
 * The lead story keeps its relevance clause; the rest stay scannable, because
 * three full paragraphs would break the line budget the reader asked for.
 */
function storyLine(item, n, { withWhy = false } = {}) {
  if (typeof item === 'string') return `${n}. ${esc(trimText(item, 130))}`;

  const headline = esc(trimText(String(item.headline ?? item.t ?? ''), 110));
  const parts = [`${n}. ${headline}`];

  if (withWhy) {
    const why = String(item.relevance ?? '').trim();
    if (why) parts.push(esc(trimText(why, 80)));
  }

  let line = parts.join(' — ');
  if (item.source) {
    const link = item.url
      ? `<a href="${esc(String(item.url))}">${esc(String(item.source))}</a>`
      : esc(String(item.source));
    line += ` · ${link}`;
  }
  return line;
}

/** Bulleted inline list: "A • B • C" (already-escaped cells). */
const inline = (cells) => cells.filter(Boolean).join(' • ');

/** Shared tail: rule + brand/disclaimer on one line (2 lines, frees a slot). */
function tail() {
  return [
    `${SEP}`,
    `⚡ <b>NEW AGE ALGOS</b> · <i>Data-driven • Systematic • Transparent · Not investment advice</i>`,
  ];
}

/** Header: brand + title + timestamp on one line (the long form uses four). */
function head(icon, title, ctx, opts) {
  const now = opts.now ?? ctx.now ?? new Date();
  const when = ctx.date ? `${ctx.date} • ${fmtTime(now)}` : `${fmtDate(now)} • ${fmtTime(now)}`;
  return [`${icon} <b>NEW AGE ALGOS</b> — <b>${title}</b> <i>${esc(when)}</i>`];
}

// ------------------------------------------------------------------- PRE-MARKET

/**
 * 🌅 Pre-market digest.
 * Reads exactly the context buildPreMarketContext() produces, so it can be
 * swapped for formatPreMarket() without touching the data layer.
 *
 * Returns a string of at most BRIEF_MAX_LINES lines.
 */
export function formatPreMarketDigest(ctx = {}, opts = {}) {
  const L = head('🌅', 'PRE-MARKET', ctx, opts);

  const indices = (ctx.indices ?? []).filter((i) => i && typeof i.value === 'number').slice(0, 3);
  if (indices.length) {
    L.push(`📈 ${inline(indices.map(indexCell))}`);
  }

  const macros = inline([
    (ctx.usdinr ?? '') && `USD/INR ${esc(ctx.usdinr)}`,
    (ctx.crude ?? '') && `Crude ${esc(ctx.crude)}`,
    (ctx.gold ?? '') && `Gold ${esc(ctx.gold)}`,
  ]);
  const globalBits = inline([
    ...((ctx.us ?? []).slice(0, 2).map((s) => `🇺🇸 ${esc(s)}`)),
    ...((ctx.asia ?? []).length ? [`Asia ${esc(ctx.asia[0])}`] : []),
    macros,
  ]);
  if (globalBits) L.push(`🌍 ${globalBits}`);

  const stories = (ctx.developments ?? []).slice(0, MAX_STORIES);
  if (stories.length) {
    L.push(`🔥 <b>WHAT MATTERS TODAY</b>`);
    stories.forEach((s, i) => L.push(storyLine(s, i + 1, { withWhy: i === 0 })));
  }

  const watch = (ctx.watchlist ?? [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .map((s) => (/sector$/i.test(s) ? esc(s.replace(/\s+sector$/i, '')) : esc(s.toUpperCase())));
  if (watch.length) L.push(`👀 <b>WATCH</b> ${inline(watch)}`);

  const events = (ctx.keyEvents ?? []).map((e) => String(e ?? '').trim()).filter(Boolean);
  if (events.length) L.push(`⚠️ <b>TODAY</b> ${inline(events.map((e) => esc(trimText(e, 70))))}`);

  const view = String(ctx.view ?? '').trim();
  if (view) L.push(`🧠 <blockquote>${esc(trimText(view, 320))}</blockquote>`);

  return cap(L);
}

// ----------------------------------------------------------------------- CLOSING

/**
 * 🌙 Market-wrap digest.
 * Reads exactly the context buildClosingContext() produces.
 */
export function formatClosingDigest(ctx = {}, opts = {}) {
  const L = head('🌙', 'MARKET WRAP', ctx, opts);

  const indices = (ctx.indices ?? []).filter((i) => i && typeof i.value === 'number').slice(0, 3);
  if (indices.length) L.push(`📈 ${inline(indices.map(indexCell))}`);

  const breadth = inline([
    ctx.advances != null ? `Adv ${Number(ctx.advances).toLocaleString('en-IN')} 🟢` : '',
    ctx.declines != null ? `Dec ${Number(ctx.declines).toLocaleString('en-IN')} 🔴` : '',
    ...((ctx.topSectors ?? []).slice(0, 2).map(sectorCell)),
  ]);
  if (breadth) L.push(`📊 ${breadth}`);

  const stories = (ctx.developments ?? []).slice(0, MAX_STORIES);
  if (stories.length) {
    L.push(`🔥 <b>KEY DRIVER</b>`);
    stories.forEach((s, i) => L.push(storyLine(s, i + 1, { withWhy: i === 0 })));
  }

  const movers = (ctx.movers ?? []).slice(0, 4).map(moverCell);
  if (movers.length) L.push(`🔥 <b>MOVERS</b> ${inline(movers)}`);

  const flows = inline([
    ...((ctx.fii ?? []).map((f) => esc(trimText(f, 60)))),
    ...((ctx.dii ?? []).map((d) => esc(trimText(d, 60)))),
  ]);
  if (flows) L.push(`💰 <b>FLOWS</b> ${flows}`);

  const global = (ctx.global ?? []).slice(0, 3).map((g) => esc(trimText(g, 60)));
  if (global.length) L.push(`🌍 <b>GLOBAL</b> ${inline(global)}`);

  const next = (ctx.watchNext ?? ctx.keyEvents ?? [])
    .map((e) => String(e ?? '').trim())
    .filter(Boolean);
  if (next.length) L.push(`🔮 <b>TOMORROW</b> ${inline(next.map((e) => esc(trimText(e, 70))))}`);

  const view = String(ctx.view ?? '').trim();
  if (view) L.push(`🧠 <blockquote>${esc(trimText(view, 320))}</blockquote>`);

  return cap(L);
}

/**
 * Enforce BRIEF_MAX_LINES without ever dropping the header, the index line,
 * the interpretation or the brand tail — those are the reason to read it.
 *
 * Over-budget content sheds optional one-liners in a fixed order (the least
 * useful first), then whole story lines from the bottom. Priority is explicit
 * so the VIEW line — which sits last in the message — can never be the thing
 * that "falls off the bottom".
 *
 * Shed order: least essential first.
 */
const SHED_ORDER = [/^🌍/, /^💰/, /^👀/, /^🔥 <b>MOVERS/, /^📊/, /^⚠️/, /^🔮/];

function cap(L) {
  const t = tail();
  const maxContent = BRIEF_MAX_LINES - t.length;
  if (L.length <= maxContent) return [...L, ...t].join('\n');

  let content = L;

  // 1. shed optional one-liners in priority order (never the protected ones)
  for (const re of SHED_ORDER) {
    if (content.length <= maxContent) break;
    const at = content.findIndex((line, i) => i > 0 && re.test(line));
    if (at > 0) content = [...content.slice(0, at), ...content.slice(at + 1)];
  }

  // 2. still over? shed story lines bottom-up — the section label survives as
  //    the heading, so the block still reads as one unit.
  while (content.length > maxContent) {
    const lastStory = content.findLastIndex((line, i) => i > 0 && /^\d+\.\s/.test(line));
    if (lastStory <= 0) break;
    content = [...content.slice(0, lastStory), ...content.slice(lastStory + 1)];
  }

  // 3. safety net for a pathological context. Shed whole lines — trimming text
  //    instead would never reduce the line count and spin forever here.
  //    The header at [0] always survives.
  while (content.length > maxContent && content.length > 1) {
    content = content.slice(0, -1);
  }

  return [...content, ...t].join('\n');
}
