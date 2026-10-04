/**
 * Scheduled briefing templates — pre-market intelligence and market wrap.
 *
 * Pure functions: context in, Telegram message text out (Telegram HTML).
 *
 * Rules:
 * - Sections without data are OMITTED — never fabricate numbers or commentary.
 * - Every story separates WHAT HAPPENED (fact) from WHY IT MATTERS (relevance)
 *   from NEW AGE ALGOS VIEW (interpretation, rendered as a blockquote).
 * - Sources are hyperlinked only when a real URL exists.
 * - Lists are capped by density so a busy morning never becomes a wall of text.
 * - Dates/times are computed in IST at render time — nothing hardcoded.
 */

import { formatMarketSnapshot, statusShort } from './format.js';
import {
  MESSAGE_BUDGET,
  SEP,
  fmtDate,
  fmtDateTime,
  fmtTime,
  esc,
  brandHeader,
  sectionHeader,
  sectionTitle,
  brandFooter,
  kv,
  bullets,
  sourceLink,
  statusBadge,
  severityEmoji,
  sectorChip,
  storySlug,
  trimText,
  fitToBudget,
  caps,
  codeBlock,
  pad,
} from './theme.js';

const MAX_DEVELOPMENTS = 5;
const MAX_WATCH = 6;
const MAX_KEY_EVENTS = 6;
const MAX_SECTORS = 6;
const MAX_MOVERS = 5;
const MAX_GLOBAL = 6;

export { fmtDate };

/** Header timestamp: caller-supplied date + live IST time (never hardcoded). */
function whenLine(ctx, opts) {
  const now = opts.now ?? ctx.now ?? new Date();
  return ctx.date ? `${ctx.date} • ${fmtTime(now)}` : fmtDateTime(now);
}

/** Plain text of a development item (string or structured). */
function factOf(item) {
  if (typeof item === 'string') return item;
  return item.headline || item.t || '';
}

/**
 * "Market lens" chips — only from entities actually extracted from the story.
 * Returns pre-escaped HTML fragments (sectors keep their icon, tickers stay plain).
 */
function lensParts(item) {
  const sectors = (item.sectors ?? []).slice(0, 4).map(sectorChip).filter(Boolean);
  const stocks = (item.companies ?? item.stocks ?? [])
    .map((s) => String(s ?? '').trim().toUpperCase().slice(0, 40))
    .filter(Boolean)
    .map(esc);
  return [...sectors, ...stocks];
}

/** One story block: slug, fact, why-it-matters, source + confirmation status. */
function storyBlock(item, index, c, { lead = false, number = true } = {}) {
  if (typeof item === 'string') return [number ? `${index}. ${esc(item)}` : esc(item)];

  const lines = [];
  const slug = storySlug({
    institutions: item.institutions ?? [],
    category: item.category,
    sectors: item.sectors ?? [],
    stocks: item.companies ?? item.stocks ?? [],
  });
  const label = number ? `${index}  ${slug}` : slug;
  lines.push(`${severityEmoji(item.level)} <b>${esc(label)}</b>`);
  lines.push('');

  const headline = factOf(item);
  if (headline) lines.push(esc(trimText(headline, c.para)));

  // The lead story gets the fuller factual summary; the rest stay scannable.
  if (lead && item.summary && String(item.summary).trim() && String(item.summary).trim() !== String(headline).trim()) {
    lines.push('');
    lines.push(esc(trimText(String(item.summary), c.para)));
  }

  const relevance = item.relevance && String(item.relevance).trim() ? String(item.relevance) : '';
  const lens = lensParts(item);
  if (relevance) {
    lines.push('');
    lines.push(sectionTitle('📌', 'Why it matters'));
    lines.push(esc(trimText(relevance, c.para)));
  } else if (lens.length) {
    lines.push('');
    lines.push(sectionTitle('📌', 'Market lens'));
    lines.push(lens.join(' • '));
  }

  if (item.source) {
    lines.push('');
    const status = item.status ? `  ${statusBadge(item.status)}` : '';
    lines.push(`${sectionTitle('📰', 'Source')}: ${sourceLink(item.url, item.source)}${status}`);
  }
  return lines;
}

/** Watch list: stocks first (bold), then sectors with their icon. */
function renderWatch(items, cap) {
  const stocks = [];
  const sectors = [];
  for (const raw of items.slice(0, cap)) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (/\bsector$/i.test(s)) sectors.push(s.replace(/\s+sector$/i, ''));
    else stocks.push(s.toUpperCase().slice(0, 40));
  }
  const lines = [];
  for (const s of stocks) lines.push(`📌 <b>${esc(s)}</b>`);
  if (stocks.length && sectors.length) lines.push('');
  for (const s of sectors) {
    const chip = sectorChip(s);
    if (chip) lines.push(chip);
  }
  return lines;
}

/** `<code>` index block: aligned monospace rows with direction arrows. */
function indexBlock(indices) {
  const rows = indices.map((i) => {
    const pct = typeof i.pct_change === 'number' ? i.pct_change : null;
    const dir = pct == null ? '  ' : pct > 0 ? '🟢' : pct < 0 ? '🔴' : '⚪';
    const value = typeof i.value === 'number' ? i.value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '';
    const pctTxt = pct == null ? '' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
    return `${pad(String(i.name).toUpperCase(), 12)} ${pad(value, 13)} ${dir} ${pctTxt}`.trimEnd();
  });
  return codeBlock(rows);
}

/** Split "IT: 43,000 (+0.90%)" → icon chip + value, without losing data. */
function sectorRow(entry) {
  const [name, ...rest] = String(entry).split(':');
  const value = rest.join(':').trim();
  const chip = sectorChip(name) ?? esc(name);
  return value ? `${chip}  <i>${esc(value)}</i>` : chip;
}

function stockRow(entry) {
  const [name, ...rest] = String(entry).split(':');
  const value = rest.join(':').trim();
  const label = `📌 <b>${esc(String(name).trim().toUpperCase())}</b>`;
  return value ? `${label}  <i>${esc(value)}</i>` : label;
}

// ------------------------------------------------------------------- PRE-MARKET

/**
 * 🌅 Pre-market intelligence.
 * ctx: { date?, now?, us: [], asia: [], usdinr?, crude?, gold?, nifty?,
 *        banknifty?, indices: [], developments: [], watchlist: [], keyEvents: [],
 *        view? }
 * Every field optional; empty sections are omitted, never invented.
 */
export function formatPreMarket(ctx = {}, opts = {}) {
  const budget = opts.budget ?? MESSAGE_BUDGET;
  return fitToBudget((density, optional) => renderPreMarket(ctx, opts, density, optional), budget);
}

function renderPreMarket(ctx, opts, density, optional) {
  const c = caps(density);
  const L = [];

  L.push(...brandHeader({
    icon: '🌅',
    title: 'PRE-MARKET INTELLIGENCE',
    titleIcon: '📊',
    when: whenLine(ctx, opts),
  }));

  // ------------------------------------------------- WHAT MATTERS TODAY
  const developments = (ctx.developments ?? []).slice(0, Math.min(c.developments, MAX_DEVELOPMENTS));
  if (developments.length) {
    L.push('');
    L.push(...sectionHeader('🔥', 'WHAT MATTERS TODAY'));
    developments.forEach((d, i) => {
      L.push('');
      L.push(...storyBlock(d, i + 1, c, { lead: i === 0 }));
    });
  }

  // ------------------------------------------------------- WATCHLIST
  const watch = (ctx.watchlist ?? []).slice(0, Math.min(c.watch, MAX_WATCH));
  if (watch.length) {
    const rows = renderWatch(watch, c.watch);
    if (rows.length) {
      L.push('');
      L.push(...sectionHeader('👀', 'STOCKS / SECTORS TO WATCH'));
      L.push('');
      L.push(...rows);
    }
  }

  // ------------------------------------------------------- GLOBAL CUES
  const us = (ctx.us ?? []).slice(0, c.global);
  const asia = (ctx.asia ?? []).slice(0, c.global);
  const hasGlobal = us.length || asia.length || ctx.usdinr || ctx.crude || ctx.gold;
  if (hasGlobal) {
    L.push('');
    L.push(...sectionHeader('🌍', 'GLOBAL CUES'));
    if (us.length) {
      L.push('');
      L.push('<b>🇺🇸 United States</b>');
      L.push(...bullets(us));
    }
    if (asia.length) {
      L.push('');
      L.push('<b>🇯🇵 🇭🇰 🇨🇳 Asia</b>');
      L.push(...bullets(asia));
    }
    const macros = [ctx.usdinr && kv('USD/INR', ctx.usdinr), ctx.crude && kv('Crude', ctx.crude), ctx.gold && kv('Gold', ctx.gold)]
      .filter(Boolean);
    if (macros.length) {
      L.push('');
      L.push(...macros);
    }
  }

  // ------------------------------------------------ INDIAN MARKET SETUP
  const indices = (ctx.indices ?? []).filter((i) => i && typeof i.value === 'number').slice(0, 4);
  if (indices.length) {
    L.push('');
    L.push(...sectionHeader('📊', 'INDIAN MARKET SETUP'));
    L.push('');
    L.push(indexBlock(indices));
  } else if (ctx.nifty || ctx.banknifty) {
    L.push('');
    L.push(...sectionHeader('📊', 'INDIAN MARKET SETUP'));
    L.push('');
    if (ctx.nifty) L.push(kv('NIFTY', ctx.nifty));
    if (ctx.banknifty) L.push(kv('BANKNIFTY', ctx.banknifty));
  }

  // ------------------------------------------------------ KEY EVENTS
  const keyEvents = (ctx.keyEvents ?? []).slice(0, Math.min(c.events, MAX_KEY_EVENTS));
  if (keyEvents.length) {
    L.push('');
    L.push(...sectionHeader('⚠️', "TODAY'S KEY EVENTS"));
    L.push('');
    L.push(...bullets(keyEvents));
  }

  // ------------------------------------------------------------- VIEW
  const viewText = optional && ctx.view ? String(ctx.view).trim() : '';
  if (viewText) {
    L.push('');
    L.push(...sectionHeader('🧠', 'NEW AGE ALGOS VIEW'));
    L.push('');
    L.push(`<blockquote>${esc(viewText)}</blockquote>`);
  }

  L.push(...brandFooter('⚡'));
  return L.join('\n');
}

// ---------------------------------------------------------------------- CLOSING

/**
 * 🌙 Market wrap (closing report).
 * ctx: { date?, now?, nifty?, banknifty?, indices: [], advances?, declines?,
 *        topSectors: [], weakSectors: [], movers: [], developments: [],
 *        fii?: [], dii?: [], global: [], watchNext: [], view? }
 */
export function formatClosing(ctx = {}, opts = {}) {
  const budget = opts.budget ?? MESSAGE_BUDGET;
  return fitToBudget((density, optional) => renderClosing(ctx, opts, density, optional), budget);
}

/** Alias kept for callers/tests that read the template name literally. */
export const formatClosingReport = formatClosing;

function renderClosing(ctx, opts, density, optional) {
  const c = caps(density);
  const L = [];

  L.push(...brandHeader({
    icon: '🌙',
    title: 'MARKET WRAP',
    titleIcon: '📊',
    when: whenLine(ctx, opts),
  }));

  // ----------------------------------------------------------- INDICES
  const indices = (ctx.indices ?? []).filter((i) => i && typeof i.value === 'number').slice(0, 4);
  if (indices.length) {
    L.push('');
    L.push(indexBlock(indices));
  } else if (ctx.nifty || ctx.banknifty) {
    L.push('');
    const rows = [];
    if (ctx.nifty) rows.push(`NIFTY        ${ctx.nifty}`);
    if (ctx.banknifty) rows.push(`BANKNIFTY    ${ctx.banknifty}`);
    if (rows.length) L.push(codeBlock(rows));
  }

  // ----------------------------------------------------------- BREADTH
  if (ctx.advances != null || ctx.declines != null) {
    L.push('');
    L.push(sectionTitle('📈', 'MARKET BREADTH'));
    const rows = [];
    if (ctx.advances != null) rows.push(`${pad('ADVANCES', 12)} ${pad(Number(ctx.advances).toLocaleString('en-IN'), 9)} 🟢`);
    if (ctx.declines != null) rows.push(`${pad('DECLINES', 12)} ${pad(Number(ctx.declines).toLocaleString('en-IN'), 9)} 🔴`);
    L.push(codeBlock(rows));
  }

  // ------------------------------------------------------ KEY DRIVER
  const developments = (ctx.developments ?? []).slice(0, Math.min(c.developments, MAX_DEVELOPMENTS));
  if (developments.length) {
    L.push('');
    L.push(...sectionHeader('🔥', "TODAY'S KEY DRIVER"));
    L.push('');
    L.push(...storyBlock(developments[0], 1, c, { lead: true, number: false }));
  }

  // ------------------------------------------------------- WHAT MOVED
  const topSectors = (ctx.topSectors ?? []).slice(0, Math.min(c.watch, MAX_SECTORS));
  const weakSectors = (ctx.weakSectors ?? []).slice(0, Math.min(c.watch, MAX_SECTORS));
  if (topSectors.length) {
    L.push('');
    L.push(...sectionHeader('🏆', 'WHAT MOVED'));
    L.push('');
    L.push(...topSectors.map(sectorRow));
  }
  if (weakSectors.length) {
    L.push('');
    L.push(sectionTitle('⚠️', 'LAGGARDS'));
    L.push(...weakSectors.map(sectorRow));
  }

  // ---------------------------------------------------------- MOVERS
  const movers = (ctx.movers ?? []).slice(0, Math.min(c.watch, MAX_MOVERS));
  if (movers.length) {
    L.push('');
    L.push(sectionTitle('🔥', 'KEY STOCK MOVERS'));
    L.push(...movers.map(stockRow));
  }

  // ------------------------------------------------------------ FLOWS
  const flows = [...(ctx.fii ?? []), ...(ctx.dii ?? [])].slice(0, 4);
  if (flows.length) {
    L.push('');
    L.push(sectionTitle('💰', 'FLOWS'));
    L.push(...bullets(flows));
  }

  // ---------------------------------------------------- ALSO TODAY
  const rest = developments.slice(1);
  if (optional && rest.length) {
    L.push('');
    L.push(sectionTitle('📰', 'ALSO TODAY'));
    L.push(...bullets(rest.map((d) => factOf(d))));
  }

  // ---------------------------------------------------- GLOBAL CUES
  const global = (ctx.global ?? []).slice(0, c.global);
  if (global.length) {
    L.push('');
    L.push(sectionTitle('🌍', 'GLOBAL CUES'));
    L.push(...bullets(global));
  }

  // ------------------------------------------------- TOMORROW'S WATCH
  const watchNext = (ctx.keyEvents ?? ctx.watchNext ?? []).slice(0, Math.min(c.events, MAX_KEY_EVENTS));
  if (watchNext.length) {
    L.push('');
    L.push(sectionTitle('🔮', "TOMORROW'S WATCH"));
    L.push(...bullets(watchNext));
  }

  // ------------------------------------------------------------- VIEW
  const viewText = optional && ctx.view ? String(ctx.view).trim() : '';
  if (viewText) {
    L.push('');
    L.push(sectionTitle('🧠', 'NEW AGE ALGOS VIEW'));
    L.push(`<blockquote>${esc(viewText)}</blockquote>`);
  }

  L.push(...brandFooter());
  return L.join('\n');
}

export { formatMarketSnapshot, statusShort };
export { SEP };
