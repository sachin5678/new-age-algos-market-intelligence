/** Telegram message formatting. Raw importance scores are NEVER exposed. */

import { escapeMarkdownV2 } from './transport.js';

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

/**
 * Intraday market alert — exact New Age Algos wire format (MarkdownV2).
 * Sections with no supported data (sectors/stocks) are omitted, never padded.
 */
export function formatAlert(event, verdict = {}, opts = {}) {
  const lines = [];
  lines.push('🚨 *MARKET ALERT*');
  lines.push('');
  lines.push(escapeMarkdownV2(verdict.headline || event.title || ''));

  const summary =
    (verdict.summary && String(verdict.summary).trim()) ||
    (Array.isArray(verdict.facts) && verdict.facts.length ? verdict.facts.slice(0, 3).join(' ') : '');
  if (summary) {
    lines.push('');
    lines.push(escapeMarkdownV2(String(summary).trim()));
  }

  if (verdict.market_relevance && String(verdict.market_relevance).trim()) {
    lines.push('');
    lines.push('📌 *Market relevance:*');
    lines.push(escapeMarkdownV2(verdict.market_relevance));
  }

  const sectors = (Array.isArray(verdict.affected_sectors) ? verdict.affected_sectors : event.sectors ?? []).slice(0, 5);
  if (sectors.length) {
    lines.push('');
    lines.push('🏭 *Sectors:*');
    lines.push(escapeMarkdownV2(sectors.join(', ')));
  }

  // Stocks only when the information clearly supports the relationship.
  const stocks = Array.isArray(verdict.affected_stocks) ? verdict.affected_stocks.slice(0, 5) : [];
  if (stocks.length) {
    lines.push('');
    lines.push('📊 *Stocks potentially affected:*');
    lines.push(escapeMarkdownV2(stocks.join(', ')));
  }

  lines.push('');
  lines.push('🔎 *Source:*');
  lines.push(escapeMarkdownV2(event.source ?? 'Unknown source'));

  lines.push('');
  lines.push('⚠️ *Status:*');
  lines.push(escapeMarkdownV2(statusLine(event)));

  lines.push('');
  lines.push('\\- New Age Algos');

  if (opts.footer) {
    lines.push('');
    lines.push(escapeMarkdownV2(opts.footer));
  }
  return lines.join('\n');
}

/** Split a message into chunks ≤ limit, preferring paragraph boundaries. */
export function chunkMessage(text, limit = 4096) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}