/**
 * Reusable visual components (§26) — every section of every template is built
 * from these. Pure HTML-string functions over the §19 contract; all dynamic
 * values pass through esc(); missing data renders "N/A" (§21), never a guess.
 *
 *   Header, MarketCard, GlobalCueCard, NewsCard, StockCard, SectorCard,
 *   RiskCard (catalysts/risks), ViewCard, Footer + small helpers
 */

import { esc, theme, VISUAL_DEFAULTS } from './theme.js';

const NA = '<span class="na">N/A</span>';

/** "▲ +0.62%" / "▼ -0.31%" — direction indicator from real pct only. */
export function delta(pct, { suffix = '%' } = {}) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '';
  const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '•';
  const sign = pct > 0 ? '+' : '';
  return `<span class="${cls}">${arrow} ${sign}${pct.toFixed(2)}${suffix}</span>`;
}

/** Indian-format number with 2 decimals, or N/A. */
export function num(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NA;
  return value.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

export function fmtDateLong(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(d).toUpperCase();
}

export function fmtDay(d) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(d).toUpperCase();
}

export function fmtTime(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d) + ' IST';
}

export function fmtDateShort(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

// ----------------------------------------------------------------- header

/**
 * Header — strong but minimal (§4): brand line, accent rule, title,
 * date/day/time. On a non-trading day the title switches to WEEK AHEAD and a
 * MARKET CLOSED chip appears (§13).
 */
export function Header({ title, calendar, now = new Date(), kicker = null }) {
  const closed = calendar?.closed ? calendar : null;
  const displayTitle = closed ? 'WEEK AHEAD' : title;
  return `
<div class="hd">
  ${calendar?.sample ? '<span class="sample">SAMPLE / TEST DATA</span>' : ''}
  <div class="brand"><span class="bolt">⚡</span>${esc(theme.brand.name)}</div>
  <div class="hd-title">${esc(displayTitle)}${closed ? `<span class="closed-chip">${esc(closed.closedLabel ?? 'MARKET CLOSED')}</span>` : ''}</div>
  <div class="rule"></div>
  <div class="hd-date">${esc(fmtDay(now))} • ${esc(fmtDateLong(now))} • ${esc(fmtTime(now))}</div>
  ${kicker ? `<div class="sec-note">${esc(kicker)}</div>` : ''}
</div>`;
}

// ----------------------------------------------------------- market pulse

/** MarketCard group (§4 section 1 / §9): index cards, positive/negative. */
export function MarketPulse({ market = {} }) {
  const cells = [
    ['NIFTY 50', market.nifty],
    ['BANK NIFTY', market.banknifty],
    ['SENSEX', market.sensex],
  ]
    .map(([label, row]) => {
      const changeBits =
        row && (row.pct_change != null || row.change != null)
          ? [row.pct_change != null ? delta(row.pct_change) : '', row.change != null && row.pct_change == null ? `<span class="${row.change >= 0 ? 'up' : 'down'}">${row.change >= 0 ? '+' : ''}${num(row.change)}</span>` : ''].filter(Boolean).join(' ')
          : '';
      return `
  <div class="card">
    <div class="k">${esc(label)}</div>
    <div class="v">${row ? num(row.value) : NA}</div>
    <div class="d">${changeBits || (row ? '' : NA)}</div>
  </div>`;
    })
    .join('');
  return `
<section class="sec" data-sec="pulse">
  <h2 class="sec-h"><span class="ico">📊</span>MARKET PULSE</h2>
  <div class="grid pulse">${cells}</div>
</section>`;
}

// ------------------------------------------------------------ global cues

/** GlobalCueCard grid (§4 section 2) — groups only where data exists. */
export function GlobalCues({ groups = [] }) {
  if (!groups.length) {
    return `
<section class="sec" data-sec="global">
  <h2 class="sec-h"><span class="ico">🌍</span>GLOBAL CUES</h2>
  <div class="sec-note">Data unavailable</div>
</section>`;
  }
  const body = groups
    .map(
      (g) => `
  <div>
    <div class="cue-group">${esc(g.group)}</div>
    <div class="grid cues">
      ${g.items
        .map(
          (it) => `
      <div class="cue">
        <div class="k">${esc(it.name)}</div>
        <div class="v">${it.value != null ? num(it.value) : NA}</div>
        <div class="d">${it.pct_change != null ? delta(it.pct_change) : ''}</div>
      </div>`
        )
        .join('')}
    </div>
  </div>`
    )
    .join('');
  return `
<section class="sec" data-sec="global">
  <h2 class="sec-h"><span class="ico">🌍</span>GLOBAL CUES</h2>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${body}</div>
</section>`;
}

// --------------------------------------------------------------- stories

const STATUS_CLASS = {
  Confirmed: 'b-confirmed',
  Reported: 'b-reported',
  'Awaiting official confirmation': 'b-awaiting',
  Unconfirmed: 'b-unconfirmed',
};

const IMPACT_TEXT = {
  positive: 'POSITIVE',
  negative: 'NEGATIVE',
  mixed: 'MIXED',
  neutral: 'NEUTRAL',
};

/** Source line: hyperlink ONLY with a valid URL (§11), else plain name. */
export function sourceLine(d) {
  const name = d.source_name ? esc(d.source_name) : 'Source unavailable';
  const link = d.source_url ? `<a href="${esc(d.source_url)}">${name}</a>` : name;
  let when = '';
  if (d.published_at && Number.isFinite(Date.parse(d.published_at))) {
    when = ` • ${new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(d.published_at))} IST`;
  }
  const statusClass = STATUS_CLASS[d.status] ?? 'b-reported';
  return `<span>${link}${when}</span><span class="badge ${statusClass}">${esc(d.status)}</span>`;
}

/**
 * NewsCard (§4 section 3 / §10): rank, category, headline, summary,
 * why-it-matters, impact + source with status badge. Highly scannable.
 */
export function NewsCard({ story, cap = { summary: 170, why: 120 } }) {
  const s = story;
  const impact = s.impact
    ? `<span class="impact i-${s.impact}">${IMPACT_TEXT[s.impact] ?? esc(s.impact)}</span>`
    : '';
  return `
<article class="story">
  <div class="top">
    <span class="rank">${String(s.rank).padStart(2, '0')}</span>
    <span class="cat">${esc(s.category)}</span>
    ${s.updated ? '<span class="upd">UPDATED</span>' : ''}
    ${impact}
  </div>
  <h3>${esc(s.headline)}</h3>
  ${s.summary ? `<p class="sum">${esc(truncate(s.summary, cap.summary))}</p>` : ''}
  ${s.why_it_matters ? `<p class="why"><b>WHY IT MATTERS</b> — ${esc(truncate(s.why_it_matters, cap.why))}</p>` : ''}
  <div class="src">${sourceLine(s)}</div>
</article>`;
}

/** Word-safe truncation with ellipsis (never mid-number when avoidable). */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const word = head.lastIndexOf(' ');
  return `${(word > max * 0.5 ? head.slice(0, word) : head).trim()}…`;
}

// ----------------------------------------------------- stocks / sectors

/** StockCard rows (§4 section 4) — symbol + the real reason it surfaced. */
export function StockWatch({ stocks = [] }) {
  if (!stocks.length) return '';
  return `
<section class="sec" data-sec="stocks">
  <h2 class="sec-h"><span class="ico">📈</span>STOCKS TO WATCH</h2>
  ${stocks
    .map(
      (s) => `
  <div class="row"><span class="sym">${esc(s.symbol)}</span><span class="why">${esc(s.reason)}</span></div>`
    )
    .join('')}
</section>`;
}

/** SectorCard (§4 section 5). */
export function SectorWatch({ sectors = [] }) {
  if (!sectors.length) return '';
  const chips = sectors
    .map(
      (s) =>
        `<span class="chip">${esc(s.sector)}<span class="sub"> — ${esc(truncate(s.reason, 46))}</span></span>`
    )
    .join('');
  return `
<section class="sec" data-sec="sectors">
  <h2 class="sec-h"><span class="ico">🏭</span>SECTORS TO WATCH</h2>
  <div class="chips">${chips}</div>
</section>`;
}

// ------------------------------------------------ catalysts / risks (§4 §6)

/** RiskCard two-column block — bullets only from real data; empty → omitted. */
export function CatalystsRisks({ catalysts = [], risks = [] }) {
  if (!catalysts.length && !risks.length) return '';
  const col = (title, items, cls) => `
  <div class="${cls}">
    <div class="lbl-mini">${title}</div>
    ${items.length ? items.map((i) => `<div class="bul">${esc(i)}</div>`).join('') : '<div class="sec-note">—</div>'}
  </div>`;
  return `
<section class="sec" data-sec="catalysts">
  <div class="two">
    ${col('KEY CATALYSTS', catalysts, 'cats')}
    ${col('KEY RISKS', risks, 'risks')}
  </div>
</section>`;
}

// ---------------------------------------------------------------- view

/** ViewCard (§4 section 7) — interpretation, only when the AI produced one. */
export function ViewCard({ view, label = 'NEW AGE ALGOS VIEW' }) {
  if (!view) return '';
  return `
<section class="sec" data-sec="view">
  <div class="view"><span class="lbl">🎯 ${esc(label)}</span>${esc(view)}</div>
</section>`;
}

// --------------------------------------------------------------- footer

/** Footer (§4) — brand, generated timestamp, real sources, disclaimer. */
export function Footer({ sources = [], now = new Date(), sample = false }) {
  const names = sources.map((s) => esc(s.name)).filter(Boolean);
  return `
<footer class="ft">
  <div class="line1">
    <span class="bname">⚡ ${esc(theme.brand.name)}</span>
    <span class="btag">${esc(theme.brand.tagline)}</span>
  </div>
  <div class="meta">
    ${sample ? '<b>SAMPLE / TEST DATA — not production output.</b> ' : ''}
    Generated: <b>${esc(fmtDateShort(now))} • ${esc(fmtTime(now))}</b>${
      names.length ? `<br>Sources: <b>${names.slice(0, 8).join(' • ')}</b>` : ''
    }
    <br><span class="disc">For informational purposes only. Not investment advice.</span>
  </div>
</footer>`;
}

/** Poster shell — fixes the logical viewport the renderer screenshots. */
export function Poster({ body, width, height, scale = VISUAL_DEFAULTS.scale }) {
  const vw = Math.round(width / scale);
  const vh = Math.round(height / scale);
  return `<div class="poster" style="width:${vw}px;min-height:${vh}px">${body}</div>`;
}
