/** Telegram message formatting. Raw importance scores are NEVER exposed.
 *
 * Output is Telegram HTML (`<b>`, `<i>`, `<u>`, `<code>`, `<a>`, …). MarkdownV2
 * is deliberately avoided: gramjs' MarkdownV2 parser ignores backslash escapes
 * and mangles hyphens, which delivered `\(x\)` / `\-` literally to readers.
 */

import { escapeHtml } from './transport.js';

const REGULATORY_INSTITUTIONS = new Set(['SEBI', 'RBI', 'GOVERNMENT', 'NSE', 'BSE', 'FED']);

/**
 * Status line per source hierarchy:
 *   tier 1 / official  → Confirmed
 *   tier 4 (social)    → Unconfirmed (never treated as fact)
 *   media report on a regulatory/official topic → Awaiting official confirmation
 *   other media        → Reported
 */
export function statusLine(event) {
  const tier = Number(event.trust_tier ?? 2);
  const src = event.source ?? 'Unknown source';
  if (tier >= 4) return `Unconfirmed — ${src} (commentary/social; not treated as fact)`;
  if (tier === 1 || event.source_type === 'official') return `Confirmed — ${src} (official source)`;
  const regulatoryTopic =
    ['SEBI', 'RBI'].includes(event.category) ||
    (event.institutions ?? []).some((i) => REGULATORY_INSTITUTIONS.has(String(i).toUpperCase()));
  if (regulatoryTopic) return `Awaiting official confirmation — reported by ${src}`;
  return `Reported — ${src}`;
}

/** Bold + underline a headline so it reads like a wire slug. */
function headline(text) {
  return `<b><u>${escapeHtml(text)}</u></b>`;
}

/** Labelled section: `<b>` label on its own line, escaped body under it. */
function labelled(lines, label, body) {
  lines.push('');
  lines.push(`<b>${label}:</b>`);
  lines.push(escapeHtml(body));
}

/**
 * Intraday market alert — exact New Age Algos wire format (Telegram HTML).
 * Sections with no supported data (sectors/stocks) are omitted, never padded.
 */
export function formatAlert(event, verdict = {}, opts = {}) {
  const lines = [];
  lines.push('🚨 <b>MARKET ALERT</b>');
  lines.push('');
  lines.push(headline(verdict.headline || event.title || ''));

  const summary =
    (verdict.summary && String(verdict.summary).trim()) ||
    (Array.isArray(verdict.facts) && verdict.facts.length ? verdict.facts.slice(0, 3).join(' ') : '');
  if (summary) {
    lines.push('');
    lines.push(escapeHtml(String(summary).trim()));
  }

  if (verdict.market_relevance && String(verdict.market_relevance).trim()) {
    labelled(lines, '📌 Market relevance', verdict.market_relevance);
  }

  const sectors = (Array.isArray(verdict.affected_sectors) ? verdict.affected_sectors : event.sectors ?? []).slice(0, 5);
  if (sectors.length) {
    labelled(lines, '🏭 Sectors', sectors.join(', '));
  }

  // Stocks only when the information clearly supports the relationship.
  const stocks = Array.isArray(verdict.affected_stocks) ? verdict.affected_stocks.slice(0, 5) : [];
  if (stocks.length) {
    labelled(lines, '📊 Stocks potentially affected', stocks.join(', '));
  }

  labelled(lines, '🔎 Source', event.source ?? 'Unknown source');
  labelled(lines, '⚠️ Status', statusLine(event));

  lines.push('');
  lines.push('<i>— New Age Algos</i>');

  if (opts.footer) {
    lines.push('');
    lines.push(escapeHtml(opts.footer));
  }
  return lines.join('\n');
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
