/**
 * New Age Algos — shared Telegram presentation primitives.
 *
 * One styling system for every message the product sends:
 *   formatPreMarket / formatClosing   (src/telegram/briefings.js)
 *   formatBreakingAlert / formatIntradayAlert / formatMarketSnapshot
 *                                    (src/telegram/format.js)
 *
 * Rules baked into these helpers (they are presentation-only — no data access,
 * no business decisions, no I/O):
 *   - Telegram HTML only (`<b> <i> <u> <a> <code> <blockquote>`).
 *   - Dynamic text is ALWAYS escaped before it reaches a tag.
 *   - A source is only a hyperlink when a real http(s) URL exists — never fabricate.
 *   - Confirmation status is derived from the source hierarchy, never invented.
 *   - Emoji are navigation aids (≈1 per section), not decoration.
 *   - Nothing renders mid-sentence when the length budget forces a trim.
 */

import { escapeHtml } from './transport.js';

/** Universal section rule — the visual spine of every long-form message. */
export const SEP = '━━━━━━━━━━━━━━━━━━━━';

/** Default length budget: comfortably under Telegram's 4096-char hard limit. */
export const MAX_MESSAGE_LENGTH = 4096;
export const MESSAGE_BUDGET = 3600;

const IST = 'Asia/Kolkata';

/** "04 Oct 2026" in IST. */
export function fmtDate(d = new Date()) {
  return new Date(d).toLocaleDateString('en-GB', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric' });
}

/** "04 OCT 2026 • 11:05 IST" — dynamic; dates/times are never hardcoded. */
export function fmtDateTime(d = new Date()) {
  const date = new Date(d).toLocaleDateString('en-GB', {
    timeZone: IST, day: '2-digit', month: 'short', year: 'numeric',
  }).toUpperCase();
  return `${date} • ${fmtTime(d)}`;
}

/** "11:05 IST" — used when a caller supplies its own date line. */
export function fmtTime(d = new Date()) {
  const time = new Date(d).toLocaleTimeString('en-GB', {
    timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${time} IST`;
}

/** Escape dynamic text for safe embedding in Telegram HTML. */
export const esc = escapeHtml;

// ------------------------------------------------------------------ layout

/** Branded header: brand line, rule, message title, optional timestamp line. */
export function brandHeader({ icon, title, titleIcon = null, when = null }) {
  const heading = titleIcon ? `${titleIcon} <b>${title}</b>` : `<b>${title}</b>`;
  const lines = [`${icon} <b>NEW AGE ALGOS</b>`, SEP, heading];
  if (when) lines.push(`<i>${esc(when)}</i>`);
  return lines;
}

/** Section heading framed by the rule (used by long-form briefings). */
export function sectionHeader(icon, title) {
  return [SEP, `${icon} <b>${title}</b>`, SEP];
}

/** Inline section heading for compact messages (alerts). */
export function sectionTitle(icon, title) {
  return `${icon} <b>${title}</b>`;
}

/** Product footer — identical on every message so the feed reads as one brand. */
export function brandFooter(icon = '⚡') {
  return ['', SEP, `${icon} <b>NEW AGE ALGOS</b>`, '<i>Data-driven • Systematic • Transparent</i>'];
}

/** "Label: value" with the label bold and the value escaped. */
export function kv(label, value) {
  return `<b>${esc(label)}:</b> ${esc(value)}`;
}

/** Bulleted list (escaped, each item trimmed to stay mobile-readable). */
export function bullets(items, max = 200) {
  return items.map((x) => `• ${esc(trimText(x, max))}`);
}

// ------------------------------------------------------------------ source

const URL_RE = /^https?:\/\/[^\s"'<>\\]+$/i;

/**
 * Hyperlink a source when — and only when — a usable http(s) URL exists.
 * Returns plain (escaped) text otherwise: a broken or fabricated link is worse
 * than no link.
 */
export function sourceLink(url, label) {
  const text = esc(label || 'Source');
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw || raw.length > 2048 || !URL_RE.test(raw)) return text;
  const href = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<a href="${href}">${text}</a>`;
}

// ------------------------------------------------------------------ status

/** Confirmation badge emoji for a statusLine() string. Never invents status. */
export function statusBadge(statusText) {
  const t = String(statusText ?? '');
  const icon = t.startsWith('Confirmed') ? '✅' : t.startsWith('Reported') ? '🟡' : '⚠️';
  return `${icon} <i>${esc(t)}</i>`;
}

// -------------------------------------------------------------- severity

/** Importance → severity dot. 🔴 HIGH · 🟠 MEDIUM · 🟡 LOW. */
export function severityEmoji(level) {
  const l = String(level ?? '').toUpperCase();
  if (l === 'HIGH') return '🔴';
  if (l === 'MEDIUM') return '🟠';
  return '🟡';
}

const IMPACT = {
  positive: ['🟢', 'Positive'],
  negative: ['🔴', 'Negative'],
  neutral: ['🟡', 'Neutral'],
  mixed: ['🟠', 'Mixed'],
  unclear: ['⚪', 'Unclear'],
};

/** AI/event impact direction → indicator. Unknown stays ⚪ Unclear (never guessed). */
export function impactBadge(impact) {
  const [icon, label] = IMPACT[String(impact ?? '').toLowerCase()] ?? IMPACT.unclear;
  return `${icon} <b>${label}</b>`;
}

// --------------------------------------------------------------- entities

const SECTOR_ICONS = {
  BANKING: '🏦', BANK: '🏦', NBFC: '🏦', FINANCIAL: '🏦',
  IT: '💻', TECHNOLOGY: '💻', TELECOM: '📡',
  ENERGY: '⚡', POWER: '⚡', UTILITIES: '⚡',
  REALTY: '🏠', REAL_ESTATE: '🏠',
  AUTO: '🚗', AUTOMOBILE: '🚗',
  'OIL & GAS': '🛢️', OIL: '🛢️', OILGAS: '🛢️', PETRO: '🛢️',
  PHARMA: '💊', HEALTHCARE: '🏥',
  CHEMICALS: '🧪', CHEMICAL: '🧪',
  METALS: '🪙', METAL: '🪙', MINING: '⛏️',
  FMCG: '🛒', CONSUMER: '🛒',
  MEDIA: '📺', INFRA: '🏗️', CEMENT: '🧱',
  PSU: '🏛️', DEFENCE: '🛡️', AGRI: '🌾', TEXTILES: '🧵',
  MARKET: '📈', GLOBAL: '🌍', MACRO: '🇮🇳', COMMODITIES: '🛢️',
  CURRENCY: '💱', BONDS: '📐', IPO: '🔔', FNO: '📐', RESULTS: '📋',
};

/** "BANKING" → "🏦 Banking" (unknown sectors fall back to 📌). */
export function sectorChip(sector) {
  const key = String(sector ?? '').trim().toUpperCase().replace(/\s+SECTOR$/, '');
  if (!key) return null;
  const icon = SECTOR_ICONS[key] ?? '📌';
  return `${icon} ${esc(sectorLabel(key))}`;
}

/** Acronyms stay uppercase; everything else is title-cased. */
const SECTOR_LABELS = {
  IT: 'IT',
  PSU: 'PSU',
  NBFC: 'NBFC',
  FMCG: 'FMCG',
  ETF: 'ETF',
  'OIL & GAS': 'Oil & Gas',
  'OIL AND GAS': 'Oil & Gas',
};

function sectorLabel(key) {
  if (SECTOR_LABELS[key]) return SECTOR_LABELS[key];
  return key
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

/** "TCS" → "📌 TCS" (tickers are shown bold inside a watch line). */
export function stockChip(stock) {
  const s = String(stock ?? '').trim();
  return s ? `📌 <b>${esc(s)}</b>` : null;
}

/** "👀 Watch: TCS • IT" — only lists what the analysis actually identified. */
export function watchLine(stocks = [], sectors = []) {
  const parts = [
    ...stocks.slice(0, 5).map((s) => esc(String(s).toUpperCase())),
    ...sectors.slice(0, 4).map((s) => esc(String(s).toUpperCase())),
  ];
  return parts.length ? `${sectionTitle('👀', 'Watch')}: ${parts.join(' • ')}` : null;
}

// ---------------------------------------------------------------- view

/**
 * "New Age Algos View" body. Rendered as a real blockquote (supported by both
 * the Bot API and gramjs) so interpretation is visually separated from fact.
 */
export function viewBlock(text) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  return `<blockquote>${esc(body)}</blockquote>`;
}

// ------------------------------------------------------------ story labels

const CATEGORY_LABELS = {
  SEBI: 'REGULATORY', RBI: 'MONETARY POLICY', FNO: 'DERIVATIVES', IPO: 'IPO',
  RESULTS: 'EARNINGS', CORPORATE_ACTION: 'CORPORATE ACTION', MACRO: 'MACRO',
  MARKET: 'MARKETS', GLOBAL: 'GLOBAL', COMMODITIES: 'COMMODITIES',
  CURRENCY: 'CURRENCY', BONDS: 'BONDS', SECTOR: 'SECTOR', STOCK: 'CORPORATE',
  OTHER: '',
};

export function categoryLabel(category) {
  return CATEGORY_LABELS[String(category ?? '').toUpperCase()] ?? String(category ?? '').toUpperCase();
}

/**
 * Story slug used as the item heading, e.g. "RBI • MONETARY POLICY" or
 * "IT • TCS". Built strictly from extracted entities — nothing is invented.
 */
export function storySlug({ institutions = [], category, sectors = [], stocks = [] } = {}) {
  const inst = institutions.map((i) => String(i).toUpperCase()).find(Boolean);
  const cat = categoryLabel(category);
  if (inst) return [inst, cat].filter(Boolean).join(' • ');
  const sector = sectors[0] ? String(sectors[0]).toUpperCase().replace(/\s+SECTOR$/, '') : null;
  const stock = stocks[0] ? String(stocks[0]).toUpperCase() : null;
  if (sector && stock) return `${sector} • ${stock}`;
  if (sector) return sector;
  if (stock) return stock;
  return cat || 'MARKET';
}

// ------------------------------------------------------------- length

/**
 * Sentence/word-safe truncation — never cuts mid-sentence when a sentence
 * boundary is available inside the last 60% of the budget.
 */
export function trimText(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('। '));
  if (stop > max * 0.6) return head.slice(0, stop + 1);
  const word = head.lastIndexOf(' ');
  const cut = word > max * 0.5 ? head.slice(0, word) : head;
  return `${cut.replace(/[,;:—-]+$/, '').trimEnd()}…`;
}

/**
 * Render at decreasing density until the message fits the budget:
 *   full     → every section at normal caps
 *   compact  → fewer items, shorter paragraphs
 *   minimal  → smallest caps
 *   minimal + drop optional sections (data sections are never dropped)
 * Last resort: drop whole content lines (never header/footer, never half a
 * line) so the message still fits; chunkMessage() handles anything left.
 */
export function fitToBudget(build, budget = MESSAGE_BUDGET) {
  const attempts = [
    ['full', true],
    ['compact', true],
    ['minimal', true],
    ['minimal', false],
  ];
  let last = null;
  for (const [density, optional] of attempts) {
    const text = build(density, optional);
    last = text;
    if (text.length <= budget) return text;
  }
  return dropLines(last, budget);
}

/**
 * Trim a rendered message to the budget by removing whole content lines from
 * the bottom up. The brand header (first 4 lines) and footer (last 4) are
 * never touched, and a `<code>` block is always removed as a unit, so every
 * surviving line stays well-formed Telegram HTML.
 */
function dropLines(text, budget) {
  if (text.length <= budget) return text;
  const lines = text.split('\n');
  if (lines.length <= 8) return text;
  const head = lines.slice(0, 4);
  const tail = lines.slice(-4);
  let body = lines.slice(4, -4);
  const render = () => [...head, ...body, ...tail].join('\n');
  while (body.length && render().length > budget) {
    const dropped = body.pop();
    // Keep <code> blocks intact: if the closing half went, remove the rest too.
    if (dropped.includes('</code>') && !dropped.includes('<code>')) {
      while (body.length) {
        const prev = body.pop();
        if (prev.includes('<code>')) break;
      }
    }
  }
  return render();
}

/** Density-driven item caps (same policy, tighter as the budget shrinks). */
export function caps(density) {
  if (density === 'minimal') return { developments: 2, watch: 3, events: 3, global: 3, para: 180 };
  if (density === 'compact') return { developments: 3, watch: 4, events: 4, global: 4, para: 280 };
  return { developments: 5, watch: 6, events: 6, global: 6, para: 420 };
}

/**
 * Label the parts of a message that had to be split, so a reader can tell that
 * "part 2 of 2" continues the same story. Applied AFTER chunk balancing, so
 * tags stay well-formed.
 */
export function labelChunks(chunks) {
  if (chunks.length < 2) return chunks;
  return chunks.map((c, i) => `${c}\n\n<i>part ${i + 1} of ${chunks.length}</i>`);
}

/** Pad a cell for the monospace dashboard blocks (`<code>` renders aligned). */
export function pad(text, width) {
  const s = String(text ?? '');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Monospace block: values only — tags are added around it, never inside. */
export function codeBlock(lines) {
  return `<code>${esc(lines.join('\n'))}</code>`;
}
