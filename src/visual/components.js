/**
 * Reusable visual components — every section of every template is built from
 * these. Pure HTML-string functions over the briefing contract; all dynamic
 * values pass through esc(); missing data renders "N/A", never a guess.
 *
 * EDITORIAL CONTRACT (PART 3/4/24):
 *   - a headline, a summary and a why-it-matters are NEVER truncated here.
 *     Length is controlled upstream, at the data layer, by cutting on SENTENCE
 *     boundaries. There is no truncation helper anywhere in this module — an
 *     ellipsis cannot be produced by accident if it does not exist.
 *   - SOURCE • TIME always shows a date, not just a clock: a story published
 *     yesterday must not be stamped "07:42 IST" with no day attached.
 *   - status and impact are metadata badges, not part of the prose.
 *
 * Components: Header, MarketPulse, GlobalCues, Story, Takeaway, Agenda,
 * StockWatch, SectorWatch, CatalystsRisks, ViewCard, Footer, Poster.
 */

import { esc, theme, VISUAL_DEFAULTS } from './theme.js';
import { istDateKey } from './data.js';

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
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d) + ' IST'
  );
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
 * Header — brand line, accent rule, title, date/day/time. On a non-trading day
 * the title switches to WEEK AHEAD and a MARKET CLOSED chip appears (§13).
 *
 * `page` renders the compact continuation masthead used on page 2+ so every
 * image still says what it is when it arrives detached from page 1.
 */
export function Header({ title, calendar, now = new Date(), kicker = null, page = 1, pageCount = 1 }) {
  const closed = calendar?.closed ? calendar : null;
  const displayTitle = closed ? 'WEEK AHEAD' : title;
  const chip = closed ? `<span class="closed-chip">${esc(closed.closedLabel ?? 'MARKET CLOSED')}</span>` : '';
  const isContinuation = page > 1;

  const masthead = isContinuation
    ? `
  <div class="hd-title cont">${esc(displayTitle)}${chip}</div>
  <div class="rule"></div>
  <div class="hd-date">${esc(fmtDateLong(now))} • CONTINUED</div>`
    : `
  <div class="hd-title">${esc(displayTitle)}${chip}</div>
  <div class="rule"></div>
  <div class="hd-date">${esc(fmtDay(now))} • ${esc(fmtDateLong(now))} • ${esc(fmtTime(now))}</div>
  ${kicker ? `<div class="sec-note">${esc(kicker)}</div>` : ''}`;

  return `
<div class="hd">
  ${calendar?.sample ? '<span class="sample">SAMPLE / TEST DATA</span>' : ''}
  <div class="brand"><span class="bolt">⚡</span>${esc(theme.brand.name)}${
    isContinuation ? `<span class="hd-page">PAGE ${page} / ${pageCount}</span>` : ''
  }</div>${masthead}
</div>`;
}

// ----------------------------------------------------------- market pulse

/** MarketCard group (§4 section 1 / §9): index cards, positive/negative. */
export function MarketPulse({ market = {}, heading = 'MARKET PULSE', ico = '📊', note = null }) {
  const cells = [
    ['NIFTY 50', market.nifty],
    ['BANK NIFTY', market.banknifty],
    ['SENSEX', market.sensex],
  ]
    .map(([label, row]) => {
      const changeBits =
        row && (row.pct_change != null || row.change != null)
          ? [
              row.pct_change != null ? delta(row.pct_change) : '',
              row.change != null && row.pct_change == null
                ? `<span class="${row.change >= 0 ? 'up' : 'down'}">${row.change >= 0 ? '+' : ''}${num(
                    row.change
                  )}</span>`
                : '',
            ]
              .filter(Boolean)
              .join(' ')
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
  <h2 class="sec-h"><span class="ico">${ico}</span>${esc(heading)}${
    note ? `<span class="sec-note" style="margin-left:auto">${esc(note)}</span>` : ''
  }</h2>
  <div class="grid pulse">${cells}</div>
</section>`;
}

// ------------------------------------------------------------ global cues

/** GlobalCueCard grid (§4 section 2) — groups only where data exists. */
export function GlobalCues({ groups = [], heading = 'OVERNIGHT / GLOBAL CUES', ico = '🌍', note = null }) {
  if (!groups.length) {
    return `
<section class="sec" data-sec="global">
  <h2 class="sec-h"><span class="ico">${ico}</span>${esc(heading)}</h2>
  <div class="note-box">No global snapshot was available for this window — the section is omitted rather than shown empty.</div>
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
  <h2 class="sec-h"><span class="ico">${ico}</span>${esc(heading)}${
    note ? `<span class="sec-note" style="margin-left:auto">${esc(note)}</span>` : ''
  }</h2>
  <div class="cue-groups">${body}</div>
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

/**
 * Publication stamp (PART 24): "LiveMint • 06:17 IST" when the story is from
 * today, otherwise the date — "The Economic Times • 04 Oct 2026". A clock
 * without a day is actively misleading on a pre-market page.
 */
export function publishedLabel(publishedAt, now = new Date()) {
  if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) return null;
  const d = new Date(publishedAt);
  if (istDateKey(d) === istDateKey(now)) return fmtTime(d);
  return fmtDateShort(d);
}

/**
 * SOURCE • TIME line + status/impact badges.
 * Supporting outlets from a deduplicated cluster are shown as a second line so
 * one event never becomes four cards (PART 23).
 */
export function sourceLine(d, now = new Date()) {
  const name = d.source_name ? esc(d.source_name) : 'Source unavailable';
  const link = d.source_url ? `<a href="${esc(d.source_url)}">${name}</a>` : name;
  const when = publishedLabel(d.published_at, now);
  const statusClass = STATUS_CLASS[d.status] ?? 'b-reported';
  const impact = d.impact
    ? `<span class="impact i-${d.impact}">${IMPACT_TEXT[d.impact] ?? esc(d.impact)}</span>`
    : '';
  const supporting = (d.supporting_sources ?? [])
    .map((s) => esc(s.name))
    .filter(Boolean)
    .join(' • ');
  return `<span>${link}${when ? ` • ${esc(when)}` : ''}</span><span class="badges">${impact}<span class="badge ${statusClass}">${esc(
    d.status
  )}</span></span>${
    supporting ? `<span class="also">Also covered by: ${supporting}</span>` : ''
  }`;
}

/**
 * Story (PART 4) — the editorial card.
 *
 * 01 | CATEGORY | 🌙 OVERNIGHT
 * full headline, wrapping
 * 2–4 sentence summary
 * WHY IT MATTERS
 * SOURCE • TIME   [status]
 *
 * Auto height by construction: there is no clamp, no max-height, no
 * line-clamp anywhere in `.story` (test/visual-layout.test.js asserts it).
 */
export function Story({ story, now = new Date() }) {
  const s = story;
  const tag = s.tag ?? { label: '', emoji: '' };
  return `
<article class="story">
  <div class="top">
    <span class="rank">${String(s.rank ?? 1).padStart(2, '0')}</span>
    <span class="cat">${esc(s.category)}</span>
    ${tag.label ? `<span class="tag">${esc(tag.emoji)} ${esc(tag.label)}</span>` : ''}
    ${s.updated ? '<span class="upd">↻ UPDATED</span>' : ''}
  </div>
  <h3>${esc(s.headline)}</h3>
  ${s.summary ? `<div class="sum">${esc(s.summary)}</div>` : ''}
  ${
    s.why_it_matters
      ? `<div class="why"><span class="why-l">Why it matters</span><p>${esc(s.why_it_matters)}</p></div>`
      : ''
  }
  <div class="src">${sourceLine(s, now)}</div>
</article>`;
}

/** Legacy alias kept so older call sites keep working. */
export const NewsCard = Story;

// ------------------------------------------------------- section scaffold

/** A titled section that renders nothing when its content is empty. */
export function Section({ key = null, title, ico = '', note = null, body = '', empty = null }) {
  if (!body || (Array.isArray(body) && !body.length)) {
    if (!empty) return '';
    body = `<div class="note-box">${esc(empty)}</div>`;
  }
  return `
<section class="sec"${key ? ` data-sec="${esc(key)}"` : ''}>
  <h2 class="sec-h"><span class="ico">${ico}</span>${esc(title)}${
    note ? `<span class="sec-note" style="margin-left:auto">${esc(note)}</span>` : ''
  }</h2>
  ${body}
</section>`;
}

/**
 * Takeaway — the editorial SYNTHESIS block (PART 6): WHAT DROVE THE MARKET for
 * a close, WHAT HAPPENED YESTERDAY for a pre-market. Deliberately styled
 * differently from a story card so a reader never confuses the two.
 */
export function Takeaway({ label, text, ico = '🧭' }) {
  if (!text) return '';
  return `
<section class="sec" data-sec="takeaway">
  <div class="takeaway"><span class="lbl">${esc(ico)} ${esc(label)}</span><p>${esc(text)}</p></div>
</section>`;
}

/**
 * Agenda — KEEP AN EYE ON TODAY (PART 11 section 4): one row per theme, so it
 * reads as a plan rather than a repeat of the news list.
 */
export function Agenda({ rows = [] }) {
  if (!rows.length) return '';
  return `
<section class="sec" data-sec="agenda">
  <h2 class="sec-h"><span class="ico">👀</span>KEEP AN EYE ON TODAY</h2>
  <div class="agenda">
    ${rows
      .map(
        (r) => `
    <div class="item">
      <div class="a-h"><span class="emo">${esc(r.tag?.emoji ?? '🔵')}</span>${esc(r.label)}</div>
      <div class="a-b">${esc(r.text)}</div>
    </div>`
      )
      .join('')}
  </div>
</section>`;
}

/** Full-width numbered body list — used for secondary developments. */
export function StoryList({ stories = [], now = new Date() }) {
  if (!stories.length) return '';
  return stories.map((s) => Story({ story: s, now })).join('');
}

// ----------------------------------------------------- stocks / sectors

/** StockCard rows (§4 section 4) — symbol + the real reason it surfaced. */
export function StockWatch({ stocks = [], heading = 'STOCKS TO WATCH', ico = '📈' }) {
  if (!stocks.length) return '';
  return `
<section class="sec" data-sec="stocks">
  ${heading ? `<h2 class="sec-h"><span class="ico">${ico}</span>${esc(heading)}</h2>` : ''}
  ${stocks
    .map(
      (s) => `
  <div class="row watch"><span class="sym">${esc(s.symbol)}</span><span class="why">${esc(s.reason)}</span></div>`
    )
    .join('')}
</section>`;
}

/** SectorCard (§4 section 5) — reason is never clipped. */
export function SectorWatch({ sectors = [], heading = 'SECTORS TO WATCH', ico = '🏭' }) {
  if (!sectors.length) return '';
  return `
<section class="sec" data-sec="sectors">
  ${heading ? `<h2 class="sec-h"><span class="ico">${ico}</span>${esc(heading)}</h2>` : ''}
  <div class="chip-list">
    ${sectors
      .map(
        (s) => `
    <span class="chip"><b>${esc(s.sector)}</b><span class="sub">${esc(s.reason)}</span></span>`
      )
      .join('')}
  </div>
</section>`;
}

// ------------------------------------------------ catalysts / risks (§4 §6)

/**
 * Two-column catalyst / risk block. An EMPTY column is omitted entirely —
 * never a decorative "—" (PART 7). If both are empty the section disappears.
 */
export function CatalystsRisks({ catalysts = [], risks = [], heading = null }) {
  if (!catalysts.length && !risks.length) return '';
  const col = (title, items, cls) =>
    items.length
      ? `
  <div class="${cls}">
    <div class="col-head">${title}</div>
    ${items.map((i) => `<div class="bul">${esc(i)}</div>`).join('')}
  </div>`
      : '';
  return `
<section class="sec" data-sec="catalysts"${heading ? ` data-heading="${esc(heading)}"` : ''}>
  <div class="two">
    ${col('TODAY’S CATALYSTS', catalysts, 'cats')}
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

// ------------------------------------------------------------- mini table

/**
 * MiniTable — MARKET BREADTH / FII-DII (PART 7 sections 5-6). Rows are
 * `label | value` pairs; every value comes from a real snapshot.
 */
export function MiniTable({ label, ico = '', rows = [] }) {
  const live = rows.filter((r) => r && (r.value != null || r.text));
  if (!live.length) return '';
  return `
<div class="minitable">
  <div class="lbl-mini">${ico ? `${ico} ` : ''}${esc(label)}</div>
  ${live
    .map(
      (r) => `
  <div class="row"><span class="sym">${esc(r.label)}</span>${
        r.text
          ? `<span class="num ${r.cls ?? ''}">${esc(r.text)}</span>`
          : `<span class="num ${typeof r.value === 'number' && r.value < 0 ? 'down' : r.pos ? 'up' : ''}">${num(
              r.value
            )}</span>`
      }</div>`
    )
    .join('')}
</div>`;
}

// --------------------------------------------------------------- footer

/** Footer (§4) — brand, generated timestamp, real sources, disclaimer. */
export function Footer({ sources = [], now = new Date(), sample = false, page = 1, pageCount = 1 }) {
  const names = sources.map((s) => esc(s.name)).filter(Boolean);
  return `
<footer class="ft">
  <div class="line1">
    <span class="bname">⚡ ${esc(theme.brand.name)}</span>
    <span class="btag">${esc(theme.brand.tagline)}${pageCount > 1 ? ` • PAGE ${page} / ${pageCount}` : ''}</span>
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

/**
 * Poster shell — the logical viewport the renderer screenshots.
 *
 * `exact` renders a page whose height was already measured: the height is set
 * literally (not as a min-height) so `margin-top:auto` on the footer has zero
 * slack and no slab of empty background can appear behind it.
 */
export function Poster({ body, width, height, scale = VISUAL_DEFAULTS.scale, exact = false }) {
  const vw = Math.round(width / scale);
  const vh = Math.round(height / scale);
  const style = exact ? `width:${vw}px;height:${vh}px` : `width:${vw}px;min-height:${vh}px`;
  return `<div class="poster" style="${style}">${body}</div>`;
}
