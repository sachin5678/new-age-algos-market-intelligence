/**
 * Telegram alert + snapshot templates (New Age Algos wire format, Telegram HTML).
 *
 * MarkdownV2 is deliberately NOT used: gramjs' MarkdownV2 parser ignores
 * backslash escapes and mangles hyphens, which delivered `\(x\)` / `\-` literally.
 *
 * Presentation only — scores, classification internals, publish decisions and
 * cooldowns live elsewhere. Sections with no supported data are OMITTED, never
 * padded, and interpretation is always visually separated from fact.
 *
 * Templates:
 *   formatAlert()            → dispatcher (breaking vs regular update)
 *   formatBreakingAlert()    → confirmed / developing / high-conviction events
 *   formatIntradayAlert()    → material news that is not breaking
 *   formatMarketSnapshot()   → dashboard-style market overview
 */

import {
  SEP,
  MESSAGE_BUDGET,
  fmtDateTime,
  esc,
  brandHeader,
  sectionTitle,
  brandFooter,
  sourceLink,
  statusBadge,
  severityEmoji,
  impactBadge,
  sectorChip,
  watchLine,
  viewBlock,
  storySlug,
  trimText,
  fitToBudget,
  caps,
  codeBlock,
  pad,
} from './theme.js';

const REGULATORY_INSTITUTIONS = new Set(['SEBI', 'RBI', 'GOVERNMENT', 'NSE', 'BSE', 'FED']);

/**
 * Status line per source hierarchy:
 *   tier 1 / official  → Confirmed
 *   tier 4 (social)    → Unconfirmed (never treated as fact)
 *   media report on a regulatory/official topic → Awaiting official confirmation
 *   other media        → Reported
 */
export function statusLine(event) {
  const src = event.source ?? 'Unknown source';
  switch (statusShort(event)) {
    case 'Unconfirmed':
      return `Unconfirmed — ${src} (commentary/social; not treated as fact)`;
    case 'Confirmed':
      return `Confirmed — ${src} (official source)`;
    case 'Awaiting official confirmation':
      return `Awaiting official confirmation — reported by ${src}`;
    default:
      return `Reported — ${src}`;
  }
}

/**
 * Compact confirmation badge for dense layouts (briefing story blocks).
 * Same source-hierarchy decision as statusLine() — never invented.
 */
export function statusShort(event = {}) {
  const tier = Number(event.trust_tier ?? 2);
  if (tier >= 4) return 'Unconfirmed';
  if (tier === 1 || event.source_type === 'official') return 'Confirmed';
  const regulatoryTopic =
    ['SEBI', 'RBI'].includes(event.category) ||
    (event.institutions ?? []).some((i) => REGULATORY_INSTITUTIONS.has(String(i).toUpperCase()));
  return regulatoryTopic ? 'Awaiting official confirmation' : 'Reported';
}

/**
 * Breaking vs regular update.
 *
 * "Breaking" is reserved for stories the product can stand behind:
 *   - an official/primary source (tier 1, official source_type or an explicit
 *     official confirmation), or
 *   - a material UPDATE to a story already published, or
 *   - high publication priority together with high analysis confidence.
 * Everything else that passes the publication gate renders as a regular update —
 * the channel never screams about unverified media copy.
 */
export function isBreaking(event = {}, verdict = {}) {
  if (event.detection_status === 'UPDATED') return true;
  if (event.trust_tier === 1 || event.source_type === 'official' || event.official_confirmation === true) return true;
  return verdict.publication_priority === 'high' && verdict.confidence === 'high';
}

/** Factual body: AI summary, else concrete facts, else nothing (never invented). */
function factText(verdict = {}) {
  const summary = verdict.summary && String(verdict.summary).trim();
  if (summary) return summary;
  if (Array.isArray(verdict.facts) && verdict.facts.length) return verdict.facts.slice(0, 3).join(' ');
  return '';
}

/** The story's headline (AI's, else the source headline) — never invented. */
function headlineOf(event = {}, verdict = {}) {
  return String(verdict.headline ?? event.title ?? '').trim();
}

/**
 * WHAT HAPPENED block: headline, then the fuller factual body when it adds
 * something the headline doesn't already say. Omitted entirely when empty.
 */
function factBlock(event, verdict, c) {
  const headline = trimText(headlineOf(event, verdict), c.para);
  const body = trimText(factText(verdict), c.para);
  const lines = [];
  if (headline) lines.push(esc(headline));
  if (body && body !== headline) {
    if (lines.length) lines.push('');
    lines.push(esc(body));
  }
  return lines;
}

function affectedOf(event = {}, verdict = {}) {
  const sectors = (Array.isArray(verdict.affected_sectors) && verdict.affected_sectors.length
    ? verdict.affected_sectors
    : event.sectors ?? []
  ).slice(0, 5);
  const stocks = (Array.isArray(verdict.affected_stocks) && verdict.affected_stocks.length
    ? verdict.affected_stocks
    : event.companies ?? []
  ).slice(0, 5);
  return { sectors, stocks };
}

function slugFor(event = {}, verdict = {}) {
  const { sectors, stocks } = affectedOf(event, verdict);
  return storySlug({
    institutions: event.institutions ?? [],
    category: event.category,
    sectors,
    stocks,
  });
}

/** Timestamp line — dynamic (IST), never hardcoded. */
function when(opts) {
  return fmtDateTime(opts.now ?? new Date());
}

// ------------------------------------------------------------------ TEMPLATES

/**
 * Dispatcher — deliver.js keeps calling formatAlert(); the template choice is a
 * presentation decision made from the event + its analysis.
 */
export function formatAlert(event, verdict = {}, opts = {}) {
  return isBreaking(event, verdict)
    ? formatBreakingAlert(event, verdict, opts)
    : formatIntradayAlert(event, verdict, opts);
}

/**
 * 🚨 Breaking / high-impact alert.
 *
 * WHAT HAPPENED → WHY IT MATTERS → WHAT TO WATCH → VIEW → SOURCE / STATUS.
 */
export function formatBreakingAlert(event = {}, verdict = {}, opts = {}) {
  const budget = opts.budget ?? MESSAGE_BUDGET;
  const base = { event, verdict, opts };

  return fitToBudget((density, optional) => renderBreaking(base, density, optional), budget);
}

function renderBreaking({ event, verdict, opts }, density, optional) {
  const c = caps(density);
  const { sectors, stocks } = affectedOf(event, verdict);
  const L = [];

  L.push(...brandHeader({ icon: '🚨', title: 'HIGH-IMPACT MARKET ALERT', titleIcon: '⚡', when: when(opts) }));

  // ---------------------------------------------------------- WHAT HAPPENED
  L.push('');
  L.push(...[SEP, `${severityEmoji(event.importance_level)} <b>${esc(slugFor(event, verdict))}</b>`, SEP]);

  const fact = factBlock(event, verdict, c);
  if (fact.length) {
    L.push('');
    L.push(...fact);
  }

  // ------------------------------------------------------------ WHY IT MATTERS
  if (verdict.market_relevance && String(verdict.market_relevance).trim()) {
    L.push('');
    L.push(sectionTitle('📌', 'Why it matters'));
    L.push(esc(trimText(String(verdict.market_relevance), c.para)));
  }

  // ---------------------------------------------------------- MARKET IMPACT
  if (optional) {
    L.push('');
    L.push(...[SEP, sectionTitle('📊', 'MARKET IMPACT'), SEP]);
    L.push('');
    L.push(impactBadge(verdict.impact));
    if (sectors.length) {
      L.push('');
      L.push(`<b>Related:</b> ${sectors.map((s) => sectorChip(s)).filter(Boolean).join(' • ')}`);
    }
    if (stocks.length) {
      L.push('');
      L.push(`<b>Stocks:</b> ${stocks.map((s) => esc(String(s).toUpperCase())).join(' • ')}`);
    }
  }

  // ------------------------------------------------------------------ VIEW
  const view = viewBlock(verdict.trader_takeaway);
  if (view && optional) {
    L.push('');
    L.push(...[SEP, sectionTitle('🧠', 'NEW AGE ALGOS VIEW'), SEP]);
    L.push('');
    L.push(view);
  }

  // ----------------------------------------------------- SOURCE / CONFIRMATION
  L.push('');
  L.push(...[SEP, sectionTitle('🔗', 'SOURCE'), SEP]);
  L.push('');
  L.push(sourceLink(event.url, event.source ?? 'Unknown source'));
  L.push(statusBadge(statusLine(event)));

  L.push(...brandFooter('⚡'));
  return L.join('\n');
}

/**
 * 📈 Regular intraday update — material, but not breaking.
 * Compact: no framing rules between blocks, one glance per section.
 */
export function formatIntradayAlert(event = {}, verdict = {}, opts = {}) {
  const budget = opts.budget ?? MESSAGE_BUDGET;
  const base = { event, verdict, opts };
  return fitToBudget((density, optional) => renderIntraday(base, density, optional), budget);
}

function renderIntraday({ event, verdict, opts }, density, optional) {
  const c = caps(density);
  const { sectors, stocks } = affectedOf(event, verdict);
  const L = [];

  L.push(...brandHeader({ icon: '📰', title: 'MARKET UPDATE', titleIcon: '📈', when: when(opts) }));

  // Slug + fact
  L.push('');
  L.push(`${severityEmoji(event.importance_level)} <b>${esc(slugFor(event, verdict))}</b>`);
  const fact = factBlock(event, verdict, c);
  if (fact.length) {
    L.push('');
    L.push(...fact);
  }

  // Why it matters
  if (verdict.market_relevance && String(verdict.market_relevance).trim()) {
    L.push('');
    L.push(sectionTitle('📌', 'Why it matters'));
    L.push(esc(trimText(String(verdict.market_relevance), c.para)));
  }

  // Impact (only when the analysis actually characterised a direction —
  // "unclear" on every rules-only run would be noise, not information)
  if (optional && verdict.impact && verdict.impact !== 'unclear') {
    L.push('');
    L.push(`${sectionTitle('📊', 'Impact')}: ${impactBadge(verdict.impact)}`);
  }

  // What to watch
  const watch = watchLine(stocks, sectors);
  if (watch) {
    L.push('');
    L.push(watch);
  }

  // View (only when the analysis produced one — never invented)
  const view = viewBlock(verdict.trader_takeaway);
  if (view && optional) {
    L.push('');
    L.push(view);
  }

  // Source + confirmation status
  L.push('');
  L.push(`🔗 ${sourceLink(event.url, event.source ?? 'Unknown source')}`);
  L.push(statusBadge(statusLine(event)));

  L.push(...brandFooter());
  return L.join('\n');
}

// ----------------------------------------------------------- MARKET SNAPSHOT

const arrow = (pct) => (typeof pct !== 'number' || pct === 0 ? '⚪' : pct > 0 ? '🟢' : '🔴');
const pctText = (pct) =>
  typeof pct === 'number' ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '';
const numText = (v) =>
  typeof v === 'number' ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '';

/**
 * 📊 Market snapshot — dashboard-style, monospace aligned so it reads like a
 * terminal. ctx: { now?, indices: [{name, value, pct_change}], breadth:
 * {advances, declines}, flows: [{name, value}], leaders: [], laggards: [] }.
 * Every row must come from real snapshots — missing metrics are omitted.
 */
export function formatMarketSnapshot(ctx = {}, opts = {}) {
  const budget = opts.budget ?? MESSAGE_BUDGET;
  return fitToBudget(() => renderSnapshot(ctx), budget);
}

function renderSnapshot(ctx) {
  const L = [];
  L.push(...brandHeader({ icon: '📊', title: 'MARKET SNAPSHOT', titleIcon: '🇮🇳', when: fmtDateTime(ctx.now ?? new Date()) }));

  const indices = (ctx.indices ?? []).filter((i) => i && typeof i.value === 'number').slice(0, 6);
  if (indices.length) {
    L.push('');
    L.push(...[SEP, sectionTitle('📈', 'INDICES'), SEP]);
    L.push('');
    const rows = indices.map((i) => {
      const pct = typeof i.pct_change === 'number' ? i.pct_change : null;
      return `${pad(String(i.name).toUpperCase(), 12)} ${pad(numText(i.value), 13)} ${arrow(pct)} ${pctText(pct)}`.trimEnd();
    });
    L.push(codeBlock(rows));
  }

  const { advances, declines } = ctx.breadth ?? {};
  if (advances != null || declines != null) {
    L.push('');
    L.push(...[SEP, sectionTitle('📊', 'MARKET BREADTH'), SEP]);
    L.push('');
    const rows = [];
    if (advances != null) rows.push(`${pad('ADVANCES', 13)} ${pad(numText(advances), 10)} 🟢`);
    if (declines != null) rows.push(`${pad('DECLINES', 13)} ${pad(numText(declines), 10)} 🔴`);
    L.push(codeBlock(rows));
  }

  const flows = (ctx.flows ?? []).filter(Boolean).slice(0, 4);
  if (flows.length) {
    L.push('');
    L.push(...[SEP, sectionTitle('💰', 'FLOWS'), SEP]);
    L.push('');
    L.push(codeBlock(flows.map((f) => `${pad(String(f.name).toUpperCase(), 8)} ${pad(String(f.value), 16)}`.trimEnd())));
  }

  const leaders = (ctx.leaders ?? []).filter(Boolean).slice(0, 5);
  if (leaders.length) {
    L.push('');
    L.push(sectionTitle('🔥', 'LEADERS'));
    L.push(esc(leaders.join(' • ')));
  }

  const laggards = (ctx.laggards ?? []).filter(Boolean).slice(0, 5);
  if (laggards.length) {
    L.push('');
    L.push(sectionTitle('⚠️', 'LAGGARDS'));
    L.push(esc(laggards.join(' • ')));
  }

  L.push(...brandFooter());
  return L.join('\n');
}

// ---------------------------------------------------------------- chunking

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;

/**
 * Keep every chunk well-formed Telegram HTML: reopen tags that were live at
 * the previous split point and close anything still open at the end of a chunk.
 * Plain text passes through untouched.
 */
function balanceHtmlChunks(chunks) {
  const carried = [];
  return chunks.map((chunk) => {
    const prefix = carried.map((t) => `<${t}>`).join('');
    const open = [...carried];
    for (const m of chunk.matchAll(TAG_RE)) {
      const name = m[2].toLowerCase();
      if (m[1]) {
        const idx = open.lastIndexOf(name);
        if (idx >= 0) open.splice(idx, 1);
      } else if (!m[0].endsWith('/>')) {
        open.push(name);
      }
    }
    const suffix = open.slice().reverse().map((t) => `</${t}>`).join('');
    carried.length = 0;
    carried.push(...open);
    return prefix + chunk + suffix;
  });
}

/**
 * Split a message into chunks ≤ limit, preferring paragraph boundaries.
 * When the message carries HTML, tags are balanced per chunk so Telegram never
 * sees an unterminated `<b>` (each chunk is sent as a standalone message).
 */
export function chunkMessage(text, limit = 4096) {
  const hasTags = /<[a-zA-Z]/.test(text);
  // Reserve room for reopened/closed tags added while balancing.
  const max = hasTags ? Math.max(256, limit - 256) : limit;
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) chunks.push(rest);
  return hasTags ? balanceHtmlChunks(chunks) : chunks;
}
