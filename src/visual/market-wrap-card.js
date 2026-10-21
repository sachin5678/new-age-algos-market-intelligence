/**
 * The post-market card — what the channel actually posts.
 *
 * One image, one screen, no scrolling through a report: the benchmark line,
 * the day's top 3 gainers and top 3 losers from the NIFTY 500, and the single
 * biggest news of the day. The layout follows the market-wrap cards readers
 * already know (flag + title + date, a one-line session headline, index rows
 * with a direction dot, section rules, a story block, the movers list).
 *
 * Rules inherited from the rest of the product:
 *   - a section with no data is OMITTED, never filled with a placeholder;
 *   - every dynamic string is escaped;
 *   - the card is content-sized — a quiet day renders a shorter card instead
 *     of a slab of empty background.
 */

import { baseCss, esc, theme, VISUAL_DEFAULTS } from './theme.js';

/** Output-pixel ceiling for the card. */
export const CARD_MAX_HEIGHT = 1600;

/** Output-pixel floor for the card (never shorter than 4:5). */
export const CARD_MIN_HEIGHT = 1080;

/** Longest headline the card prints — a headline, not an article. */
const MAX_HEADLINE_CHARS = 140;

/** Cut at a word boundary and mark the cut. */
function trimWords(text, max) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

const fmtPrice = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
const fmtPct = (p) => (Number.isFinite(Number(p)) ? `${Number(p) > 0 ? '+' : ''}${Number(p).toFixed(2)}%` : '—');
const dirClass = (p) => (Number(p) > 0 ? 'up' : Number(p) < 0 ? 'down' : 'flat');

/** "22,811.35" without trailing zeros for index rows. */
const fmtIndex = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');

/** Round to the nearest whole number (index points). */
const fmtPts = (n) => Math.abs(Math.round(Number(n))).toLocaleString('en-IN');

/** "21 Oct 2026" in IST. */
function istDate(now) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
    .format(now)
    .toUpperCase();
}

/** "15:45 IST" in IST. */
function istTime(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')} IST`;
}

/**
 * The session headline, derived from the numbers — never invented.
 *
 * "NIFTY 50 FALLS 207 POINTS | INDIACEM LEADS THE TAPE"
 */
export function sessionHeadline(indices = [], gainers = [], losers = []) {
  const nifty = indices.find((i) => /^nifty\s*50$/i.test(String(i.name ?? ''))) ?? indices[0];
  let left = 'SESSION CLOSE';
  if (nifty && Number.isFinite(Number(nifty.pct_change))) {
    const pct = Number(nifty.pct_change);
    const value = Number(nifty.value);
    const name = String(nifty.name ?? 'NIFTY 50').toUpperCase();
    // Points are derivable from the value and the move — no extra fetch.
    const prev = pct !== -100 ? value / (1 + pct / 100) : null;
    const points = Number.isFinite(prev) ? value - prev : null;
    if (pct > 0) left = `${name} GAINS ${fmtPts(points)} POINTS`;
    else if (pct < 0) left = `${name} FALLS ${fmtPts(points)} POINTS`;
    else left = `${name} ENDS FLAT`;
  }
  const leader = gainers[0]?.symbol ? String(gainers[0].symbol).toUpperCase() : losers[0]?.symbol ? String(losers[0].symbol).toUpperCase() : null;
  const right = gainers[0]?.symbol
    ? `${leader} LEADS THE TAPE`
    : losers[0]?.symbol
      ? `${leader} TOP LOSER`
      : null;
  return right ? `${left} | ${right}` : left;
}

/**
 * Two or three factual one-liners for the reader — every number comes from
 * the data, nothing is editorialised.
 */
export function keyHighlights(indices = [], gainers = [], losers = [], story = null) {
  const out = [];
  const nifty = indices.find((i) => /^nifty\s*50$/i.test(String(i.name ?? ''))) ?? indices[0];
  if (nifty && Number.isFinite(Number(nifty.pct_change))) {
    const pct = Number(nifty.pct_change);
    out.push(
      `NIFTY 50 closed ${Math.abs(pct).toFixed(2)}% ${pct < 0 ? 'lower' : 'higher'} at ${fmtIndex(nifty.value)}`
    );
  }
  const gainer = gainers[0];
  const loser = losers[0];
  if (gainer) {
    out.push(`${String(gainer.symbol).toUpperCase()} led the index, up ${Math.abs(Number(gainer.pct)).toFixed(2)}%`);
  }
  if (loser) {
    out.push(`${String(loser.symbol).toUpperCase()} lagged, down ${Math.abs(Number(loser.pct)).toFixed(2)}%`);
  }
  if (story?.why) out.push(String(story.why));
  return out.slice(0, 4);
}

/**
 * The card's data, ready to render.
 * @param {object} ctx  { indices, gainers, losers, story }
 */
export function buildMarketWrapCard(ctx = {}, { now = new Date() } = {}) {
  const indices = (ctx.indices ?? []).filter((i) => i && Number.isFinite(Number(i.value))).slice(0, 3);
  const gainers = (ctx.gainers ?? []).filter((m) => m && Number.isFinite(Number(m.pct))).slice(0, 3);
  const losers = (ctx.losers ?? []).filter((m) => m && Number.isFinite(Number(m.pct))).slice(0, 3);
  const story = ctx.story ?? null;

  const cleanStory = story
    ? {
        headline: trimWords(String(story.headline ?? story.t ?? '').trim(), MAX_HEADLINE_CHARS),
        why: trimWords(String(story.relevance ?? '').trim(), 160),
        source: String(story.source ?? '').trim(),
        url: story.url ?? null,
      }
    : null;

  return {
    date: istDate(now),
    time: istTime(now),
    headline: sessionHeadline(indices, gainers, losers),
    highlights: keyHighlights(indices, gainers, losers, cleanStory),
    indices,
    gainers,
    losers,
    story: cleanStory,
  };
}

// ------------------------------------------------------------------ markup

const indexRow = (i) => `
  <div class="ix-row">
    <span class="ix-dot"></span>
    <span class="ix-name">${esc(String(i.name ?? '').toUpperCase())}</span>
    <span class="ix-val">${esc(fmtIndex(i.value))}</span>
    <span class="ix-pct ${dirClass(i.pct_change)}"><i class="cdot ${dirClass(i.pct_change)}"></i>${esc(fmtPct(i.pct_change))}</span>
  </div>`;

const highlightRow = (h, i) => `
  <div class="hl-row">
    <span class="hl-ico">${['📌', '🚀', '📉', '💡'][i] ?? '•'}</span>
    <span class="hl-text">${esc(h)}</span>
  </div>`;

const moverRow = (m, kind) => `
  <div class="mv-row">
    <span class="mv-dot ${kind}"></span>
    <span class="mv-sym">${esc(String(m.symbol ?? '').toUpperCase())}</span>
    <span class="mv-pct ${kind}">${esc(fmtPct(m.pct))}</span>
    <span class="mv-name">${esc(String(m.name ?? ''))}</span>
  </div>`;

const storyBlock = (s) => {
  if (!s || !s.headline) return '';
  const source = s.source
    ? s.url
      ? `<a href="${esc(s.url)}">${esc(s.source)}</a>`
      : esc(s.source)
    : '';
  return `
  <div class="nw-story">
    <div class="nw-headline">${esc(s.headline)}</div>
    ${s.why ? `<div class="nw-why">${esc(s.why)}</div>` : ''}
    ${source ? `<div class="nw-src">${source}</div>` : ''}
  </div>`;
};

/**
 * The card document.
 *
 * `exact: false` is the measuring pass (the poster grows to its natural
 * height); `exact: true` renders the canvas that was measured.
 */
export function renderMarketWrapCardHtml(card, dims = {}) {
  const { width = VISUAL_DEFAULTS.width, height = CARD_MAX_HEIGHT, scale = VISUAL_DEFAULTS.scale } = dims;
  const exact = dims.exact !== false;
  const vw = Math.round(width / scale);
  const vh = Math.round(height / scale);
  const c = theme.colors;
  const t = theme.type;

  const body = `
  <div class="nw-top">
    <span class="nw-mark"></span>
    <span class="nw-title">MARKET CLOSING WRAP</span>
    <span class="nw-sep">|</span>
    <span class="nw-date">${esc(card.date)}</span>
  </div>
  <div class="nw-rule"></div>
  <div class="nw-headline"><span class="nw-hl-ico">${card.headline.includes('FALLS') ? '📉' : card.headline.includes('GAINS') ? '📈' : '📊'}</span>${esc(card.headline)}</div>
  ${card.indices.length ? `<div class="nw-ix">${card.indices.map(indexRow).join('')}</div>` : ''}
  ${card.highlights.length ? `<div class="nw-rule"></div><div class="nw-sec"><span class="nw-sec-ico">📊</span>KEY HIGHLIGHTS</div><div class="nw-hl">${card.highlights.map(highlightRow).join('')}</div>` : ''}
  <div class="nw-rule"></div>
  ${card.story ? `<div class="nw-sec"><span class="nw-sec-ico">📰</span>BIGGEST NEWS</div>${storyBlock(card.story)}` : ''}
  ${card.gainers.length || card.losers.length ? `<div class="nw-rule"></div><div class="nw-sec"><span class="nw-sec-ico">🔥</span>TOP MOVERS <span class="nw-sec-note">NIFTY 500</span></div>` : ''}
  ${card.gainers.length ? `<div class="nw-movers">${card.gainers.map((m) => moverRow(m, 'up')).join('')}</div>` : ''}
  ${card.losers.length ? `<div class="nw-movers">${card.losers.map((m) => moverRow(m, 'down')).join('')}</div>` : ''}
  <div class="nw-rule"></div>
  <div class="nw-foot">
    <div class="nw-brand">⚡ ${esc(theme.brand.name)}</div>
    <div class="nw-tag">${esc(theme.brand.tagline)}</div>
    <div class="nw-disc">For informational purposes only. Not investment advice.</div>
  </div>`;

  const css =
    baseCss({ vw, vh }) +
    `.poster{padding:20px 22px 16px}
     .nw-top{display:flex;align-items:center;gap:8px}
     .nw-mark{width:10px;height:10px;border-radius:2px;background:${c.accent};flex:0 0 auto}
     .nw-title{font-size:${t.kicker + 1}px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${c.text}}
     .nw-sep{font-size:${t.kicker}px;color:${c.muted}}
     .nw-date{font-size:${t.kicker}px;font-weight:700;letter-spacing:.1em;color:${c.muted}}
     .nw-rule{height:1px;background:${c.borderStrong};margin:10px 0;width:40%}
     .nw-headline{display:flex;align-items:flex-start;gap:7px;font-size:${t.section}px;font-weight:700;
       line-height:1.3;letter-spacing:.01em;margin-bottom:10px}
     .nw-hl-ico{font-size:${t.section - 1}px;line-height:1.15}
     .nw-ix{display:flex;flex-direction:column;gap:6px}
     .ix-row{display:flex;align-items:center;gap:8px;font-size:${t.body + 1}px}
     .ix-dot{width:7px;height:7px;background:${c.accent};transform:rotate(45deg);border-radius:1px;flex:0 0 auto}
     .ix-name{font-weight:700;letter-spacing:.06em;color:${c.text}}
     .ix-val{font-weight:700;font-variant-numeric:tabular-nums}
     .ix-pct{display:flex;align-items:center;gap:6px;margin-left:auto;font-weight:800;
       font-variant-numeric:tabular-nums}
     .cdot{width:9px;height:9px;border-radius:50%;display:inline-block}
     .cdot.up{background:${c.positive}} .cdot.down{background:${c.negative}} .cdot.flat{background:${c.muted}}
     .nw-sec{display:flex;align-items:center;gap:7px;font-size:${t.section}px;font-weight:800;letter-spacing:.1em;
       text-transform:uppercase;margin:2px 0 7px}
     .nw-sec-ico{font-size:${t.section - 1}px;line-height:1}
     .nw-sec-note{font-size:${t.meta}px;font-weight:700;letter-spacing:.08em;color:${c.muted}}
     .nw-hl{display:flex;flex-direction:column;gap:6px;margin-bottom:4px}
     .hl-row{display:flex;align-items:flex-start;gap:8px;font-size:${t.body}px;line-height:1.4}
     .hl-ico{font-size:${t.body}px;line-height:1.2;flex:0 0 auto}
     .hl-text{color:${c.text};opacity:.93}
     .nw-story{background:${c.card};border:1px solid ${c.border};border-left:3px solid ${c.accent};
       border-radius:${theme.radius}px;padding:10px 13px}
     .nw-story .nw-headline{font-size:${t.body + 2}px;font-weight:700;line-height:1.3;margin:0}
     .nw-why{margin-top:7px;font-size:${t.body}px;line-height:1.5;color:${c.text};opacity:.92}
     .nw-src{margin-top:7px;font-size:${t.meta}px;color:${c.muted};font-weight:700;letter-spacing:.05em}
     .nw-src a{color:${c.accent};text-decoration:none}
     .nw-movers{display:flex;flex-direction:column;gap:5px;margin-bottom:8px}
     .mv-row{display:flex;align-items:baseline;gap:8px;font-size:${t.body + 1}px}
     .mv-dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;align-self:center}
     .mv-dot.up{background:${c.positive}} .mv-dot.down{background:${c.negative}}
     .mv-sym{font-weight:800;letter-spacing:.05em;min-width:96px}
     .mv-pct{font-weight:800;font-variant-numeric:tabular-nums;min-width:62px}
     .mv-pct.up{color:${c.positive}} .mv-pct.down{color:${c.negative}}
     .mv-name{color:${c.muted};font-size:${t.body}px}
     .nw-foot{margin-top:14px}
     .nw-brand{font-size:${t.body}px;font-weight:800;letter-spacing:.1em}
     .nw-tag{font-size:${t.meta}px;color:${c.muted};margin-top:3px;letter-spacing:.05em}
     .nw-disc{font-size:${t.meta}px;color:${c.warning};margin-top:3px}`;

  const style = exact ? `width:${vw}px;height:${vh}px` : `width:${vw}px;min-height:0;height:auto`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${css}</style></head><body>` +
    `<div class="poster" style="${style}">${body}</div></body></html>`
  );
}
