/**
 * Compact single-message briefings — one message, ≤12 content lines, with a
 * blank line between sections so it does not read as a wall.
 *
 * The long-form templates (formatPreMarket / formatClosing) render every
 * section and comfortably run 40–70 lines. That is right for a document, wrong
 * for a Telegram channel: readers saw 5–7 separate page images twice a day.
 * These digests answer "what do I need to know" in one message that is still
 * scannable on a phone.
 *
 * Layout model: the message is a list of *sections*, each owning whole logical
 * lines (a section is never split across a blank line). `render()` puts exactly
 * one blank line between sections; `cap()` budgets only the content lines, so
 * the spacing never eats into the reading budget.
 *
 * Rules inherited from the long-form templates:
 *   - a section with no data is OMITTED, never fabricated;
 *   - every dynamic string is escaped before it is embedded;
 *   - interpretation (view) stays visually distinct from fact.
 *
 * When a context carries more sections than the budget allows, cap() sheds the
 * least essential ones in a fixed order. The header, the index line, the
 * interpretation and the brand tail are never shed, so the message always opens
 * and closes as one brand.
 */

import { SEP, esc, trimText, fmtDate, fmtTime } from './theme.js';

/** Content lines the reader asked for: one message, 10–12 lines. */
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

/** Header: brand + title + timestamp on one line (the long form uses four). */
function head(icon, title, ctx, opts) {
  const now = opts.now ?? ctx.now ?? new Date();
  const when = ctx.date ? `${ctx.date} • ${fmtTime(now)}` : `${fmtDate(now)} • ${fmtTime(now)}`;
  return `${icon} <b>NEW AGE ALGOS</b> — <b>${title}</b> <i>${esc(when)}</i>`;
}

/** Brand frame — always the last section, never counted against the budget. */
const TAIL = [
  `${SEP}`,
  `⚡ <b>NEW AGE ALGOS</b> · <i>Data-driven • Systematic • Transparent · Not investment advice</i>`,
];

/** Sections never shed, whatever the budget pressure. */
const NEVER_SHED = new Set(['head', 'indices', 'stories', 'view']);

/**
 * Shed order: least essential first. Every entry is a whole section, so
 * shedding can never leave a label without its content or a half-written line.
 */
const SHED_ORDER = ['global', 'flows', 'watch', 'movers', 'breadth', 'today', 'tomorrow'];

/** section builder: drops empty sections so nothing is ever rendered blank. */
function sectionList() {
  const list = [];
  return {
    list,
    add(key, ...lines) {
      const kept = lines.filter((l) => l !== null && l !== undefined && l !== '');
      if (kept.length) list.push({ key, lines: kept });
    },
  };
}

/**
 * Enforce BRIEF_MAX_LINES over content lines only.
 *
 * Sheds whole sections in SHED_ORDER, then — if a context is still oversized —
 * story items from the bottom, then any remaining sheddable section. The header
 * and the view are protected at every step, so the VIEW line, which sits last
 * in the message, can never be the thing that "falls off the bottom".
 */
function cap(S) {
  const count = (arr) => arr.reduce((n, s) => n + s.lines.length, 0);
  const maxContent = BRIEF_MAX_LINES - TAIL.length;
  let cur = S;

  for (const key of SHED_ORDER) {
    if (count(cur) <= maxContent) break;
    const i = cur.findIndex((s) => s.key === key);
    if (i >= 0) cur = [...cur.slice(0, i), ...cur.slice(i + 1)];
  }

  // still over? drop story items bottom-up — the section label survives.
  while (count(cur) > maxContent) {
    const i = cur.findIndex((s) => s.key === 'stories');
    if (i < 0 || cur[i].lines.length <= 1) break;
    cur = cur.map((s, j) => (j === i ? { ...s, lines: s.lines.slice(0, -1) } : s));
  }

  // safety net for a pathological context: whole sections only, header survives.
  while (count(cur) > maxContent) {
    let i = -1;
    for (let k = cur.length - 1; k >= 0; k--) {
      if (!NEVER_SHED.has(cur[k].key)) {
        i = k;
        break;
      }
    }
    if (i < 0) break;
    cur = [...cur.slice(0, i), ...cur.slice(i + 1)];
  }

  return cur;
}

/**
 * Sections → message. Exactly one blank line between sections (never two, so a
 * section can never look like it belongs to the one above it).
 */
function render(S) {
  const blocks = [...S, { key: 'tail', lines: TAIL }];
  return blocks.map((b) => b.lines.join('\n')).join('\n\n');
}

// ------------------------------------------------------------------- PRE-MARKET

/**
 * 🌅 Pre-market digest.
 * Reads exactly the context buildPreMarketContext() produces, so it can be
 * swapped for formatPreMarket() without touching the data layer.
 *
 * Returns a string of at most BRIEF_MAX_LINES content lines.
 */
export function formatPreMarketDigest(ctx = {}, opts = {}) {
  const { list, add } = sectionList();
  add('head', head('🌅', 'PRE-MARKET', ctx, opts));

  const indices = (ctx.indices ?? []).filter((i) => i && typeof i.value === 'number').slice(0, 3);
  if (indices.length) add('indices', `📈 ${inline(indices.map(indexCell))}`);

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
  if (globalBits) add('global', `🌍 ${globalBits}`);

  const stories = (ctx.developments ?? []).slice(0, MAX_STORIES);
  if (stories.length) {
    add(
      'stories',
      `🔥 <b>WHAT MATTERS TODAY</b>`,
      ...stories.map((s, i) => storyLine(s, i + 1, { withWhy: i === 0 }))
    );
  }

  const watch = (ctx.watchlist ?? [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .map((s) => (/sector$/i.test(s) ? esc(s.replace(/\s+sector$/i, '')) : esc(s.toUpperCase())));
  if (watch.length) add('watch', `👀 <b>WATCH</b> ${inline(watch)}`);

  const events = (ctx.keyEvents ?? []).map((e) => String(e ?? '').trim()).filter(Boolean);
  if (events.length) add('today', `⚠️ <b>TODAY</b> ${inline(events.map((e) => esc(trimText(e, 70))))}`);

  const view = String(ctx.view ?? '').trim();
  if (view) add('view', `🧠 <blockquote>${esc(trimText(view, 320))}</blockquote>`);

  return render(cap(list));
}

// ----------------------------------------------------------------------- CLOSING

/**
 * 🌙 Market-wrap digest.
 * Reads exactly the context buildClosingContext() produces.
 */
export function formatClosingDigest(ctx = {}, opts = {}) {
  const { list, add } = sectionList();
  add('head', head('🌙', 'MARKET WRAP', ctx, opts));

  const indices = (ctx.indices ?? []).filter((i) => i && typeof i.value === 'number').slice(0, 3);
  if (indices.length) add('indices', `📈 ${inline(indices.map(indexCell))}`);

  const breadth = inline([
    ctx.advances != null ? `Adv ${Number(ctx.advances).toLocaleString('en-IN')} 🟢` : '',
    ctx.declines != null ? `Dec ${Number(ctx.declines).toLocaleString('en-IN')} 🔴` : '',
    ...((ctx.topSectors ?? []).slice(0, 2).map(sectorCell)),
  ]);
  if (breadth) add('breadth', `📊 ${breadth}`);

  const stories = (ctx.developments ?? []).slice(0, MAX_STORIES);
  if (stories.length) {
    add(
      'stories',
      `🔥 <b>KEY DRIVER</b>`,
      ...stories.map((s, i) => storyLine(s, i + 1, { withWhy: i === 0 }))
    );
  }

  const movers = (ctx.movers ?? []).slice(0, 4).map(moverCell);
  if (movers.length) add('movers', `🔥 <b>MOVERS</b> ${inline(movers)}`);

  const flows = inline([
    ...((ctx.fii ?? []).map((f) => esc(trimText(f, 60)))),
    ...((ctx.dii ?? []).map((d) => esc(trimText(d, 60)))),
  ]);
  if (flows) add('flows', `💰 <b>FLOWS</b> ${flows}`);

  const global = (ctx.global ?? []).slice(0, 3).map((g) => esc(trimText(g, 60)));
  if (global.length) add('global', `🌍 <b>GLOBAL</b> ${inline(global)}`);

  const next = (ctx.watchNext ?? ctx.keyEvents ?? [])
    .map((e) => String(e ?? '').trim())
    .filter(Boolean);
  if (next.length) add('tomorrow', `🔮 <b>TOMORROW</b> ${inline(next.map((e) => esc(trimText(e, 70))))}`);

  const view = String(ctx.view ?? '').trim();
  if (view) add('view', `🧠 <blockquote>${esc(trimText(view, 320))}</blockquote>`);

  return render(cap(list));
}
