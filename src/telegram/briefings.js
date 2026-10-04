/**
 * Scheduled briefing templates — pre-market and closing.
 * Pure functions: context in, Telegram message text out (Telegram HTML).
 *
 * Rules:
 * - Sections without data are OMITTED entirely — never fabricate numbers.
 * - Keep it concise: max 5 developments, 6 watch items, 6 key events,
 *   5 movers — never 20+ items.
 * - Footer tagline on every briefing.
 *
 * Telegram HTML (not MarkdownV2) is used because gramjs' MarkdownV2 parser
 * ignores backslash escapes, which previously rendered `\(x\)` / `\-` literally.
 */

import { escapeHtml } from './transport.js';

const FOOTER = ['<i>— New Age Algos</i>', '<i>Data-driven | Systematic | Transparent</i>'];
const MAX_DEVELOPMENTS = 5;
const MAX_WATCH = 6;
const MAX_KEY_EVENTS = 6;
const MAX_SECTORS = 6;
const MAX_MOVERS = 5;
const MAX_GLOBAL = 6;

const IST = 'Asia/Kolkata';

export function fmtDate(d = new Date()) {
  return new Date(d).toLocaleDateString('en-GB', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Bold section heading (emoji kept outside the tag for reliable rendering). */
function heading(text) {
  return `<b>${text}</b>`;
}

/** "Label: value" with the label bold, value escaped. */
function kv(label, value) {
  return `<b>${label}:</b> ${escapeHtml(value)}`;
}

function bullets(items) {
  return items.map((x) => `• ${escapeHtml(x)}`);
}

/** Accept plain strings or {t|headline} objects in section lists. */
function asText(item) {
  if (typeof item === 'string') return escapeHtml(item);
  return escapeHtml(item?.t ?? item?.headline ?? '');
}

function section(lines, header, items, formatter = (x) => `• ${asText(x)}`) {
  if (!items?.length) return;
  lines.push('');
  lines.push(heading(header));
  lines.push('');
  for (const item of items) lines.push(formatter(item));
}

/**
 * 🌅 Pre-market brief (Telegram HTML).
 * ctx: { date?, now?, us: [], asia: [], usdinr?, crude?, gold?,
 *        nifty?, banknifty?, developments: [], watchlist: [], keyEvents: [] }
 * Every field optional; empty/missing sections are omitted.
 */
export function formatPreMarket(ctx = {}) {
  const L = [];
  L.push('🌅 <b>NEW AGE ALGOS</b>');
  L.push(heading('PRE-MARKET BRIEF'));
  L.push(`<i>${escapeHtml(ctx.date ?? fmtDate(ctx.now ?? new Date()))}</i>`);

  const us = (ctx.us ?? []).slice(0, MAX_GLOBAL);
  const asia = (ctx.asia ?? []).slice(0, MAX_GLOBAL);
  const hasGlobal = us.length || asia.length || ctx.usdinr || ctx.crude || ctx.gold;
  if (hasGlobal) {
    L.push('');
    L.push(heading('🌍 GLOBAL CUES'));
    if (us.length) {
      L.push('');
      L.push('<b>🇺🇸 US:</b>');
      L.push(...bullets(us));
    }
    if (asia.length) {
      L.push('');
      L.push('<b>🇯🇵 / 🇭🇰 / 🇨🇳 ASIA:</b>');
      L.push(...bullets(asia));
    }
    if (ctx.usdinr) {
      L.push('');
      L.push(kv('💱 USD/INR', ctx.usdinr));
    }
    if (ctx.crude) {
      L.push('');
      L.push(kv('🛢️ CRUDE', ctx.crude));
    }
    if (ctx.gold) {
      L.push('');
      L.push(kv('🥇 GOLD', ctx.gold));
    }
  }

  if (ctx.nifty || ctx.banknifty) {
    L.push('');
    L.push(heading('📊 INDIAN MARKET SETUP'));
    L.push('');
    if (ctx.nifty) L.push(kv('NIFTY', ctx.nifty));
    if (ctx.banknifty) L.push(kv('BANKNIFTY', ctx.banknifty));
  }

  const developments = (ctx.developments ?? []).slice(0, MAX_DEVELOPMENTS);
  if (developments.length) {
    L.push('');
    L.push(heading('🔥 TOP DEVELOPMENTS'));
    L.push('');
    developments.forEach((d, i) => L.push(`${i + 1}. ${asText(d)}`));
  }

  const watch = (ctx.watchlist ?? []).slice(0, MAX_WATCH);
  section(L, '🏭 STOCKS / SECTORS TO WATCH', watch);

  const keyEvents = (ctx.keyEvents ?? []).slice(0, MAX_KEY_EVENTS);
  section(L, "⚠️ TODAY'S KEY EVENTS", keyEvents);

  L.push('');
  L.push(...FOOTER);
  return L.join('\n');
}

/**
 * 📊 Closing brief (Telegram HTML).
 * ctx: { date?, now?, nifty?, banknifty?, advances?, declines?,
 *        topSectors: [], weakSectors: [], movers: [], developments: [],
 *        fii?: [], dii?: [], global: [], watchNext: [] }
 */
export function formatClosing(ctx = {}) {
  const L = [];
  L.push('📊 <b>NEW AGE ALGOS</b>');
  L.push(heading('INDIA MARKET CLOSE'));
  L.push(`<i>${escapeHtml(ctx.date ?? fmtDate(ctx.now ?? new Date()))}</i>`);

  if (ctx.nifty || ctx.banknifty) {
    L.push('');
    if (ctx.nifty) L.push(kv('NIFTY', ctx.nifty));
    if (ctx.banknifty) L.push(kv('BANKNIFTY', ctx.banknifty));
  }

  if (ctx.advances != null || ctx.declines != null) {
    L.push('');
    L.push(heading('📈 MARKET BREADTH'));
    L.push('');
    if (ctx.advances != null) L.push(kv('Advances', String(ctx.advances)));
    if (ctx.declines != null) L.push(kv('Declines', String(ctx.declines)));
  }

  section(L, '🏆 TOP SECTORS', (ctx.topSectors ?? []).slice(0, MAX_SECTORS));
  section(L, '📉 WEAK SECTORS', (ctx.weakSectors ?? []).slice(0, MAX_SECTORS));
  section(L, '🔥 KEY STOCK MOVERS', (ctx.movers ?? []).slice(0, MAX_MOVERS));

  const developments = (ctx.developments ?? []).slice(0, MAX_DEVELOPMENTS);
  if (developments.length) {
    L.push('');
    L.push(heading('📰 IMPORTANT DEVELOPMENTS'));
    L.push('');
    developments.forEach((d, i) => L.push(`${i + 1}. ${asText(d)}`));
  }

  const fiiDii = [...(ctx.fii ?? []), ...(ctx.dii ?? [])].slice(0, 4);
  section(L, '💰 FII / DII', fiiDii);

  section(L, '🌍 GLOBAL CUES', (ctx.global ?? []).slice(0, MAX_GLOBAL));
  section(L, '📅 TOMORROW TO WATCH', (ctx.watchNext ?? []).slice(0, MAX_KEY_EVENTS));

  L.push('');
  L.push(...FOOTER);
  return L.join('\n');
}
