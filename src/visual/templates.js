/**
 * Visual templates: three deterministic layouts over the briefing contract.
 *
 *   premarket — 🟦 Pre-Market Intelligence   (dynamic height, 1080×900..1600)
 *   closing   — ⬛ Market Close              (dynamic height, 1080×900..1600)
 *   alert     — 🟥 Breaking Market Alert     (fixed 1080×1080)
 *
 * plus renderPdfHtml — the optional A4 PDF (4 pages, selectable text,
 * clickable source links) which carries MORE detail than the image.
 *
 * THE LAYOUT MODEL
 * ----------------
 * A template no longer emits one monolithic HTML blob. It emits a PLAN: an
 * ordered list of independent, self-contained fragments.
 *
 *   buildPagePlan()  ->  { headerVariants, sections[], footerHtml }
 *   render.js         ->  measures every fragment in one Chromium pass,
 *                         packs them into pages <= VISUAL_HEIGHT, and picks the
 *                         smallest page height that contains each page.
 *
 * That is the whole answer to "content-first layout": nothing is ever squeezed
 * to fit a fixed canvas, and no canvas is ever stretched to hold nothing. A
 * section that has no data does not exist (PART 7/12) — it is never a dash.
 *
 * Editorial text is never truncated here or anywhere below it: length is
 * decided in data.js by cutting on sentence boundaries.
 */

import { esc, theme, baseCss, VISUAL_DEFAULTS } from './theme.js';
import {
  Header,
  MarketPulse,
  GlobalCues,
  Story,
  Takeaway,
  Agenda,
  StockWatch,
  SectorWatch,
  CatalystsRisks,
  ViewCard,
  Footer,
  MiniTable,
  Poster,
} from './components.js';

/** Poster inner padding (logical px) — part of every page-height calculation. */
export const PAGE_PAD = 18 + 16;
/** Gap between stacked fragments (logical px). */
export const FRAG_GAP = 9;

const doc = (css, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<style>${css}</style></head><body>${body}</body></html>`;

const noteBox = (text) => `<div class="note-box">${esc(text)}</div>`;

/** Every fragment is a direct `.frag` child of `.poster` — see theme.js. */
const wrapFrag = (key, html) => `<div class="frag" data-frag="${esc(key)}">${html}</div>`;

/** Titled heading fragment — `keepWithNext` stops an orphaned heading. */
const heading = (key, title, ico = '', keepWithNext = true) => ({
  key,
  html: wrapFrag(key, `<h2 class="sec-h"><span class="ico">${ico}</span>${esc(title)}</h2>`),
  keepWithNext,
});

const frag = (key, html, opts = {}) => (html ? [{ key, html: wrapFrag(key, html), ...opts }] : []);

// ---------------------------------------------------------------------------
// PRE-MARKET
// ---------------------------------------------------------------------------

/**
 * Pre-market plan (PART 11):
 *   HEADER → MARKET SNAPSHOT → 🌅 OVERNIGHT / GLOBAL CUES → WHAT HAPPENED
 *   YESTERDAY → 🌙 OVERNIGHT DEVELOPMENTS → 👀 KEEP AN EYE ON TODAY →
 *   STOCKS TO WATCH → SECTORS TO WATCH → TODAY'S CATALYSTS → RISKS →
 *   NEW AGE ALGOS VIEW → SOURCES
 *
 * Windows (PART 10): the previous session's stories and last night's stories
 * are different buckets with different labels; neither is dropped just because
 * it is older than an intraday freshness cut (PART 25/30).
 */
function premarketSections(brief, now) {
  const out = [];
  const add = (key, html) => out.push(...frag(key, html));

  // 1 — market snapshot. At 08:30 IST the Indian index values ARE the previous
  // session's close, so the heading says so rather than implying live prints.
  add(
    'pulse',
    MarketPulse({
      market: brief.market,
      heading: 'MARKET SNAPSHOT',
      ico: '📊',
      note: brief.previous_session ? 'PREVIOUS SESSION CLOSE' : null,
    })
  );

  // 2 — overnight / global cues. Empty → omitted, never a decorative box.
  if (brief.global?.length) {
    add(
      'global',
      GlobalCues({
        groups: brief.global,
        heading: 'OVERNIGHT / GLOBAL CUES',
        ico: '🌅',
        note: 'AS OF 08:30 IST',
      })
    );
  }

  const yestStories = (brief.developments ?? []).filter((d) => d.bucket === 'session' || d.bucket === 'earlier');
  const overnight = (brief.developments ?? []).filter((d) => d.bucket === 'overnight' || d.bucket === 'updated');

  // 3 — what happened yesterday: the SYNTHESIS first (why the session moved),
  // then the individual stories from it (what happened). They answer different
  // questions, so they are labelled differently (PART 6).
  if (brief.previous_session?.synthesis || yestStories.length) {
    add(
      'yesterday',
      `<section class="sec" data-sec="yesterday">
         <h2 class="sec-h"><span class="ico">📊</span>${
           brief.previous_session?.label ?? 'YESTERDAY’S SESSION'
         }</h2>
         ${
           brief.previous_session?.synthesis
             ? `<div class="takeaway"><span class="lbl">WHAT HAPPENED YESTERDAY</span><p>${esc(
                 brief.previous_session.synthesis
               )}</p></div>`
             : ''
         }
       </section>`
    );
    for (const [i, d] of yestStories.entries()) {
      add(`ystory-${i}`, Story({ story: d, now }));
    }
  }

  // 4 — overnight developments. PART 32: an empty overnight is stated plainly
  // and the briefing continues with everything else.
  out.push(heading('h-overnight', 'OVERNIGHT DEVELOPMENTS', '🌙'));
  if (overnight.length) {
    for (const [i, d] of overnight.entries()) add(`story-ov-${i}`, Story({ story: d, now }));
  } else {
    add('ov-empty', noteBox('No major new overnight developments identified in this window.'));
  }

  // 5 — agenda. Falls back to snapshot-derived rows so the section is never
  // blank even on a news-free morning (PART 32).
  if (brief.keep_an_eye?.length) add('agenda', Agenda({ rows: brief.keep_an_eye }));

  // 6/7 — watch lists
  add('stocks', StockWatch({ stocks: brief.stocks_to_watch }));
  add('sectors', SectorWatch({ sectors: brief.sectors_to_watch }));

  // 8 — catalysts + risks (empty columns omitted entirely)
  add('catalysts', CatalystsRisks({ catalysts: brief.catalysts, risks: brief.risks }));

  // 9 — interpretation
  add('view', ViewCard({ view: brief.view }));

  return out;
}

// ---------------------------------------------------------------------------
// MARKET CLOSE
// ---------------------------------------------------------------------------

/**
 * Market-close plan (PART 7), in the published order:
 *   HEADER → MARKET PULSE → WHAT DROVE THE MARKET → KEY DEVELOPMENTS →
 *   MARKET BREADTH → FII/DII → TOP GAINERS → TOP LOSERS → SECTOR MOVEMENT →
 *   TOMORROW'S WATCH → CATALYSTS → RISKS → VIEW → SOURCES
 *
 * WHAT DROVE THE MARKET is a synthesis of measured numbers (data.js
 * sessionSynthesis); KEY DEVELOPMENTS are the individual events. They are
 * structurally incapable of repeating each other (PART 6).
 */
function closingSections(brief, now) {
  const out = [];
  const add = (key, html) => out.push(...frag(key, html));

  add(
    'pulse',
    MarketPulse({ market: brief.market, heading: 'MARKET PULSE', ico: '📊', note: 'TODAY’S CLOSE' })
  );

  add('driver', Takeaway({ label: 'WHAT DROVE THE MARKET', text: brief.driver, ico: '🧭' }));

  out.push(heading('h-dev', 'KEY DEVELOPMENTS', '📰'));
  const developments = brief.developments ?? [];
  if (developments.length) {
    for (const [i, d] of developments.entries()) add(`story-${i}`, Story({ story: d, now }));
  } else {
    add('dev-empty', noteBox('No individual developments were recorded for this session.'));
  }

  // 5 — breadth
  const breadthRows = [];
  if (brief.breadth?.advances?.value != null) {
    breadthRows.push({ label: 'ADVANCES', value: brief.breadth.advances.value, pos: brief.breadth.advances.value > (brief.breadth.declines?.value ?? 0) });
  }
  if (brief.breadth?.declines?.value != null) {
    breadthRows.push({ label: 'DECLINES', value: brief.breadth.declines.value, cls: brief.breadth.declines.value > (brief.breadth.advances?.value ?? 0) ? 'down' : '' });
  }
  if (breadthRows.length) {
    add('breadth', `<div class="minitable-wrap">${MiniTable({ label: 'MARKET BREADTH', ico: '↔️', rows: breadthRows })}</div>`);
  }

  // 6 — FII / DII
  const flowRows = [];
  if (brief.flows?.fii?.value != null) {
    flowRows.push({ label: 'FII', value: brief.flows.fii.value, cls: brief.flows.fii.value >= 0 ? 'up' : 'down' });
  }
  if (brief.flows?.dii?.value != null) {
    flowRows.push({ label: 'DII', value: brief.flows.dii.value, cls: brief.flows.dii.value >= 0 ? 'up' : 'down' });
  }
  if (flowRows.length) {
    add('flows', `<div class="minitable-wrap">${MiniTable({ label: 'INSTITUTIONAL FLOWS', ico: '🏦', rows: flowRows })}</div>`);
  }

  // 7/8 — movers
  const gainers = brief.movers?.gainers ?? [];
  const losers = brief.movers?.losers ?? [];
  if (gainers.length) {
    add(
      'gainers',
      `<section class="sec" data-sec="gainers">
         <h2 class="sec-h"><span class="ico">📈</span>TOP GAINERS</h2>
         <div class="rows">${gainers
           .map((g) => `<div class="row"><span class="sym">${esc(g.name)}</span><span class="num up">${
             g.value != null ? esc(String(g.value)) : ''
           }<span class="sub"> ${esc(`${g.pct_change > 0 ? '+' : ''}${Number(g.pct_change).toFixed(2)}%`)}</span></span></div>`)
           .join('')}</div>
       </section>`
    );
  }
  if (losers.length) {
    add(
      'losers',
      `<section class="sec" data-sec="losers">
         <h2 class="sec-h"><span class="ico">📉</span>TOP LOSERS</h2>
         <div class="rows">${losers
           .map((g) => `<div class="row"><span class="sym">${esc(g.name)}</span><span class="num down">${
             g.value != null ? esc(String(g.value)) : ''
           }<span class="sub"> ${esc(`${Number(g.pct_change).toFixed(2)}%`)}</span></span></div>`)
           .join('')}</div>
       </section>`
    );
  }

  // 9 — sector movement
  const sectors = brief.sector_performance ?? [];
  if (sectors.length) {
    add(
      'sectorperf',
      `<section class="sec" data-sec="sectorperf">
         <h2 class="sec-h"><span class="ico">🏭</span>SECTOR MOVEMENT</h2>
         <div class="rows">${sectors
           .map(
             (s) =>
               `<div class="row"><span class="sym">${esc(s.name)}</span><span class="num ${
                 s.pct_change > 0 ? 'up' : s.pct_change < 0 ? 'down' : 'flat'
               }">${esc(`${s.pct_change > 0 ? '+' : ''}${Number(s.pct_change).toFixed(2)}%`)}</span></div>`
           )
           .join('')}</div>
       </section>`
    );
  }

  // 10 — tomorrow's watch (one group heading; the sub-blocks stay unlabelled so
  // the page doesn't shout the same idea twice)
  out.push(heading('h-watch', 'TOMORROW’S WATCH', '🔭'));
  add('watch-stocks', StockWatch({ stocks: brief.stocks_to_watch, heading: '' }));
  add('watch-sectors', SectorWatch({ sectors: brief.sectors_to_watch, heading: '' }));
  if (!brief.stocks_to_watch?.length && !brief.sectors_to_watch?.length) {
    add('watch-empty', noteBox('No watch-list candidates surfaced from today’s stories.'));
  }

  // 11/12 — catalysts + risks
  add('catalysts', CatalystsRisks({ catalysts: brief.catalysts, risks: brief.risks }));

  // 13 — interpretation
  add('view', ViewCard({ view: brief.view }));

  return out;
}

// ---------------------------------------------------------------------------
// PLAN
// ---------------------------------------------------------------------------

const TITLES = {
  premarket: 'PRE-MARKET INTELLIGENCE',
  closing: 'MARKET CLOSE',
};

const KICKERS = {
  premarket: 'GLOBAL OVERNIGHT • SESSION RECAP • TODAY’S AGENDA',
  closing: null,
};

/**
 * Build the pagination plan for a briefing.
 *
 * Returns two header variants — page 1 gets the full masthead, later pages get
 * a compact continuation masthead so a photo arriving on its own still says
 * what it is. Their heights are measured like any other fragment.
 */
export function buildPagePlan(brief, { type = 'premarket', now = new Date() } = {}) {
  const title = TITLES[type] ?? TITLES.premarket;
  const sections = type === 'closing' ? closingSections(brief, now) : premarketSections(brief, now);

  const header = (page, pageCount) =>
    Header({
      title,
      calendar: brief.calendar,
      now,
      kicker: page === 1 ? (KICKERS[type] ?? null) : null,
      page,
      pageCount,
    });
  const footer = (page, pageCount) =>
    Footer({
      sources: brief.sources ?? [],
      now,
      sample: Boolean(brief.sample),
      page,
      pageCount,
    });

  return {
    type,
    now,
    title,
    cap: brief.imageCap ?? 3, // current card budget — the packer may ask for less
    sample: Boolean(brief.sample),
    calendar: brief.calendar ?? null,
    sources: brief.sources ?? [],
    // Measurement placeholders. The page counter sits in the brand rows and can
    // push them onto a second line, so the placeholder is deliberately the
    // widest string we will ever render ("PAGE 99 / 99"): measured height is
    // then always >= the real one, which means the render can only ever have
    // slack — never an overflow.
    header1: { key: '__header1', html: wrapFrag('__header1', header(1, 99)) },
    headerN: { key: '__headerN', html: wrapFrag('__headerN', header(2, 99)) },
    footer: { key: '__footer', html: wrapFrag('__footer', footer(1, 99)) },
    // Built at render time, when the real pageCount is finally known.
    renderHeader: (page, pageCount) => wrapFrag(page === 1 ? '__header1' : '__headerN', header(page, pageCount)),
    renderFooter: (page, pageCount) => wrapFrag('__footer', footer(page, pageCount)),
    sections,
  };
}

/**
 * Pack fragments into pages of at most `maxContent` logical px.
 *
 * `keepWithNext` prevents a section heading being stranded at the foot of a
 * page with its first card on the next one.
 *
 * The page cap is ADVISORY: content is never discarded and never clipped, so
 * when a plan is larger than the cap the packer keeps going rather than
 * inflating the final page past the ceiling. `renderPlanPages` warns when that
 * happens, and a hard safety limit aborts the render instead of producing an
 * absurd image.
 */
export function packPages({
  header1Key,
  headerNKey,
  sections,
  heights,
  maxContent,
  maxPages = VISUAL_DEFAULTS.maxPages,
  hardMaxPages = 12,
}) {
  const pages = [];
  let current = null;

  const newPage = (headerKey) => {
    current = { headerKey, keys: [], used: heights[headerKey] ?? 0 };
    pages.push(current);
  };

  newPage(header1Key);

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const h = heights[s.key] ?? 0;
    const gap = current.keys.length ? FRAG_GAP : 0;
    const next = sections[i + 1];

    // LOOKAHEAD: a `keepWithNext` heading is only placed if the block it
    // introduces also fits. Testing the heading alone would strand it at the
    // foot of a page — the classic orphaned section title.
    const withNext =
      s.keepWithNext && next ? FRAG_GAP + (heights[next.key] ?? 0) : 0;

    // The previous fragment is itself a heading that must travel with `s`; if
    // we break now it would be left alone, so `s` goes on this page regardless.
    const lastIsOrphanHeading =
      current.keys.length > 0 &&
      current.keys[current.keys.length - 1].keepWithNext;

    // Never break on the FIRST section of a page either — a block taller than
    // a whole page must still be placed, or it would spin out empty pages.
    if (current.keys.length > 0 && !lastIsOrphanHeading && current.used + gap + h + withNext > maxContent) {
      if (pages.length >= hardMaxPages) {
        throw new Error(
          `plan needs more than ${hardMaxPages} pages — refusing to render an unreadable ${hardMaxPages}-image set`
        );
      }
      newPage(headerNKey);
    }
    current.keys.push(s);
    current.used += current.keys.length > 1 ? FRAG_GAP + h : h;
  }

  void maxPages;
  return pages;
}

/**
 * Render ONE page of a plan to a full HTML document.
 *
 * `exact: true` pins the poster to the measured height so the footer's
 * `margin-top:auto` has zero slack — this is what removes the empty lower area.
 */
export function renderPageDoc(plan, page, { height, width, scale, pageIndex = 1, pageCount = 1 }) {
  const headerHtml = pageIndex === 1 ? plan.header1.html : plan.renderHeader(pageIndex, pageCount);
  const footerHtml = plan.renderFooter(pageIndex, pageCount);
  const body = headerHtml + page.keys.map((s) => s.html).join('') + footerHtml;
  return doc(
    baseCss({ vw: Math.round(width / scale), vh: Math.round(height / scale) }),
    Poster({ body, width, height, scale, exact: true })
  );
}

/** Content height of a packed page (padding + fragments + inter-fragment gaps). */
export function packedContentHeight(page, heights) {
  const keys = [page.headerKey, ...page.keys.map((s) => s.key), '__footer'];
  if (!keys.length) return PAGE_PAD;
  let sum = 0;
  for (const k of keys) sum += heights[k] ?? 0;
  return PAGE_PAD + sum + FRAG_GAP * (keys.length - 1);
}

// ---------------------------------------------------------------------------
// SINGLE-DOCUMENT RENDERERS (tests, previews, alert)
// ---------------------------------------------------------------------------

/** Assemble a plan's fragments into a single document (no pagination). */
function singleDoc(plan, dims, sections) {
  const { width, height, scale = VISUAL_DEFAULTS.scale } = dims;
  const vw = Math.round(width / scale);
  const vh = Math.round(height / scale);
  const body = plan.header1.html + sections.join('') + plan.footer.html;
  return doc(baseCss({ vw, vh }), Poster({ body, width, height, scale, exact: false }));
}

/** All fragments of a plan, in measurement order. */
export function planFragments(plan) {
  return [plan.header1, plan.headerN, plan.footer, ...plan.sections];
}

export function renderPreMarketHtml(brief, dims = {}, opts = {}) {
  const plan = buildPagePlan(brief, { type: 'premarket', now: opts.now ?? new Date() });
  return singleDoc(plan, dims, plan.sections.map((s) => s.html));
}

export function renderClosingHtml(brief, dims = {}, opts = {}) {
  const plan = buildPagePlan(brief, { type: 'closing', now: opts.now ?? new Date() });
  return singleDoc(plan, dims, plan.sections.map((s) => s.html));
}

// ---------------------------------------------------------------------------
// BREAKING ALERT (fixed 1080×1080)
// ---------------------------------------------------------------------------

const IMPACT_TEXT = { positive: 'POSITIVE', negative: 'NEGATIVE', mixed: 'MIXED', neutral: 'NEUTRAL' };

export function renderAlertHtml(brief, dims = {}) {
  const { width = VISUAL_DEFAULTS.alertWidth, height = VISUAL_DEFAULTS.alertHeight, scale = VISUAL_DEFAULTS.scale } = dims;
  // `exact: false` is the measuring pass: the poster grows to its natural height
  // so renderFittedPng can size the final canvas to the content.
  const exact = dims.exact !== false;
  const vw = Math.round(width / scale);
  const vh = Math.round(height / scale);
  const impact = brief.impact
    ? `<span class="impact i-${brief.impact}">${IMPACT_TEXT[brief.impact] ?? esc(brief.impact)}</span>`
    : '';
  const statusClass = {
    Confirmed: 'b-confirmed',
    Reported: 'b-reported',
    'Awaiting official confirmation': 'b-awaiting',
    Unconfirmed: 'b-unconfirmed',
  }[brief.status];
  const when = brief.published_at ? new Date(brief.published_at) : null;
  const sourceName = brief.source_name ? esc(brief.source_name) : 'Source unavailable';
  const link = brief.source_url ? `<a href="${esc(brief.source_url)}">${sourceName}</a>` : sourceName;

  const body = `
  ${brief.sample ? '<span class="sample">SAMPLE / TEST DATA</span>' : ''}
  <div class="al-head">
    <span class="al-kicker">⚡ BREAKING MARKET ALERT</span>
    <span class="al-cat">${esc(brief.category)}</span>
  </div>
  <div class="rule" style="margin-top:8px"></div>
  <div class="al-headline">${esc(brief.headline)}</div>
  ${brief.summary ? `<div class="al-sum">${esc(brief.summary)}</div>` : ''}
  ${brief.why_it_matters ? `<div class="why"><span class="why-l">Why it matters</span><p>${esc(brief.why_it_matters)}</p></div>` : ''}
  <div class="lbl-mini">AFFECTED</div>
  <div class="chips">
    ${brief.stocks.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}
    ${brief.sectors.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}
  </div>
  <div class="lbl-mini">IMPACT / CONFIRMATION</div>
  <div class="badges-row">${impact}<span class="badge ${statusClass}">${esc(brief.status_label)}</span></div>
  <div class="al-src">
    <span>${link}${when ? ` • ${esc(brief.published_at.slice(11, 16))} IST` : ''}</span>
    <span>Impact: <b>${esc(IMPACT_TEXT[brief.impact] ?? '—')}</b></span>
  </div>
  <div class="ft">
    <div class="line1">
      <span class="bname">⚡ ${esc(theme.brand.name)}</span>
      <span class="btag">${esc(theme.brand.tagline)}</span>
    </div>
    <div class="meta">
      Generated: <b>${esc(brief.date)}</b><br>
      <span class="disc">For informational purposes only. Not investment advice.</span>
    </div>
  </div>`;

  return doc(
    baseCss({ vw, vh, alert: true }) +
      `.badges-row{display:flex;gap:8px;margin-top:6px}` +
      `.al-src{margin-top:auto;padding-top:10px;border-top:1px solid ${theme.colors.border};` +
      `display:flex;justify-content:space-between;gap:10px;font-size:${theme.type.meta}px;color:${theme.colors.muted}}` +
      `.al-src a{color:${theme.colors.muted}}`,
    Poster({ body, width, height, scale, exact })
  );
}

// ---------------------------------------------------------------------------
// PDF (A4, 4 pages, full text)
// ---------------------------------------------------------------------------

const pdfRow = (label, row) =>
  row
    ? `<tr><td>${esc(label)}</td><td class="n">${row.value != null ? row.value.toLocaleString('en-IN') : 'N/A'}</td><td class="n">${
        row.pct_change != null ? `${row.pct_change > 0 ? '+' : ''}${row.pct_change.toFixed(2)}%` : '—'
      }</td></tr>`
    : '';

const pdfStory = (s) => `
<div class="story">
  <div class="dim">${String(s.rank).padStart(2, '0')} • ${esc(s.category)}${
    s.tag?.label ? ` • ${esc(s.tag.emoji)} ${esc(s.tag.label)}` : ''
  }</div>
  <h3>${esc(s.headline)}</h3>
  ${s.summary ? `<div class="sum">${esc(s.summary)}</div>` : ''}
  ${
    s.why_it_matters
      ? `<div class="why"><span class="why-l">Why it matters</span>${esc(s.why_it_matters)}</div>`
      : ''
  }
  <div class="src">${esc(s.source_name ?? 'Source unavailable')}${
    s.published_at ? ` • ${esc(s.published_at.slice(0, 16).replace('T', ' '))}` : ''
  } • ${esc(s.status)}${s.supporting_sources?.length ? ` • also: ${esc(s.supporting_sources.map((x) => x.name).join(', '))}` : ''}</div>
</div>`;

const pdfPage = (title, body, sources = [], now = new Date()) => `
<div class="page">
  <div class="brand"><span class="bolt">⚡</span>${esc(theme.brand.name)}</div>
  <h1>${esc(title)}</h1>
  <div class="dim">${esc(now.toISOString().slice(0, 16).replace('T', ' '))} UTC</div>
  ${body}
  <div class="ft">⚡ ${esc(theme.brand.name)} — ${
    sources.length ? `Sources: ${esc(sources.map((s) => s.name).join(', '))}. ` : ''
  }For informational purposes only. Not investment advice.</div>
</div>`;

/** 4-page A4 PDF: Executive / Market+Global / Developments / Stocks-Sectors. */
export function renderPdfHtml(brief, dims = {}) {
  const now = new Date();
  const width = dims.width ?? VISUAL_DEFAULTS.width;
  const vw = Math.round(width / (dims.scale ?? VISUAL_DEFAULTS.scale));

  const p1 = [
    brief.driver ? `<div class="takeaway"><span class="lbl">WHAT DROVE THE MARKET</span><p>${esc(brief.driver)}</p></div>` : '',
    `<h2>Market pulse</h2><table>${pdfRow('NIFTY 50', brief.market.nifty)}${pdfRow('BANK NIFTY', brief.market.banknifty)}${pdfRow('SENSEX', brief.market.sensex)}</table>`,
    brief.keep_an_eye?.length
      ? `<h2>Keep an eye on today</h2>${brief.keep_an_eye
          .map((r) => `<p><b>${esc(r.tag?.emoji ?? '')} ${esc(r.label)}</b> — ${esc(r.text)}</p>`)
          .join('')}`
      : '',
    brief.view ? `<div class="view"><span class="lbl">🎯 NEW AGE ALGOS VIEW</span>${esc(brief.view)}</div>` : '',
  ].join('');

  const p2 = [
    `<h2>Global cues</h2>${
      brief.global?.length
        ? brief.global
            .map(
              (g) =>
                `<p><b>${esc(g.group)}</b><br>${g.items
                  .map((i) => `${esc(i.name)}: ${i.value ?? 'N/A'}${i.pct_change != null ? ` (${i.pct_change > 0 ? '+' : ''}${i.pct_change.toFixed(2)}%)` : ''}`)
                  .join(' • ')}</p>`
            )
            .join('')
        : '<p>No global snapshot available for this window.</p>'
    }`,
    brief.breadth
      ? `<h2>Breadth</h2><table>${pdfRow('ADVANCES', brief.breadth.advances)}${pdfRow('DECLINES', brief.breadth.declines)}</table>`
      : '',
    brief.flows ? `<h2>FII / DII</h2><table>${pdfRow('FII', brief.flows.fii)}${pdfRow('DII', brief.flows.dii)}</table>` : '',
    brief.sector_performance?.length
      ? `<h2>Sector movement</h2><table>${brief.sector_performance
          .map(
            (s) =>
              `<tr><td>${esc(s.name)}</td><td class="n">${s.pct_change > 0 ? '+' : ''}${Number(s.pct_change).toFixed(2)}%</td></tr>`
          )
          .join('')}</table>`
      : '',
  ].join('');

  // The PDF is the record: it reads from the wide list, not the image's cut.
  const pdfDevelopments = brief.developments_full ?? brief.developments ?? [];
  const p3 = pdfDevelopments.length
    ? `<h2>Detailed developments</h2>${pdfDevelopments.map(pdfStory).join('')}`
    : '<h2>Detailed developments</h2><p>No individual developments recorded for this window.</p>';

  const p4 = [
    `<h2>Stocks to watch</h2>${
      brief.stocks_to_watch?.length
        ? brief.stocks_to_watch.map((s) => `<p><b>${esc(s.symbol)}</b> — ${esc(s.reason)}</p>`).join('')
        : '<p>None.</p>'
    }`,
    `<h2>Sectors to watch</h2>${
      brief.sectors_to_watch?.length
        ? brief.sectors_to_watch.map((s) => `<p><b>${esc(s.sector)}</b> — ${esc(s.reason)}</p>`).join('')
        : '<p>None.</p>'
    }`,
    brief.catalysts?.length ? `<h2>Catalysts</h2>${brief.catalysts.map((c) => `<p>• ${esc(c)}</p>`).join('')}` : '',
    brief.risks?.length ? `<h2>Risks</h2>${brief.risks.map((c) => `<p>• ${esc(c)}</p>`).join('')}` : '',
  ].join('');

  const title = TITLES[brief.type] ?? TITLES.premarket;
  return doc(
    baseCss({ vw, vh: 0 }),
    `<div class="pdf">` +
      pdfPage(`${title} — Executive`, p1, brief.sources, now) +
      pdfPage(`${title} — Market & Global`, p2, brief.sources, now) +
      pdfPage(`${title} — Detailed developments`, p3, brief.sources, now) +
      pdfPage(`${title} — Stocks, sectors & watch`, p4, brief.sources, now) +
      `</div>`
  );
}
