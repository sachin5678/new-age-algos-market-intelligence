/**
 * Visual templates (§3): three deterministic layouts over the §19 contract.
 *
 *   premarket — 1080×1350 🟦 Pre-Market Intelligence
 *   closing   — 1080×1350 ⬛ Market Close
 *   alert     — 1080×1080 🟥 Breaking Market Alert
 *
 * Plus renderPdfHtml — the optional A4 PDF (4 pages, selectable text,
 * clickable source links) which may carry MORE detail than the image.
 *
 * All layout lives here; components come from components.js, all styling from
 * theme.js. Sections without data are omitted or show N/A — never fabricated.
 */

import { esc, theme, baseCss, VISUAL_DEFAULTS } from './theme.js';
import {
  Header,
  MarketPulse,
  StockWatch,
  SectorWatch,
  ViewCard,
  Footer,
  Poster,
  delta,
  num,
  fmtTime,
  fmtDateShort,
  truncate,
  sourceLine,
} from './components.js';

const IMPACT_TEXT = {
  positive: 'POSITIVE',
  negative: 'NEGATIVE',
  mixed: 'MIXED',
  neutral: 'NEUTRAL',
};

const doc = (css, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<style>${css}</style></head><body>${body}</body></html>`;

/** Section heading used by templates for blocks without a dedicated component. */
export function secTitle(ico, text) {
  return `<h2 class="sec-h"><span class="ico">${ico}</span>${esc(text)}</h2>`;
}

/** Mini stat card row — label, value, optional delta (breadth / flows / movers). */
export function MiniStats({ title, items = [] }) {
  const rows = items
    .map(
      (it) => `
    <div class="row">
      <span class="sym" style="font-size:12px">${esc(it.label)}</span>
      <span class="num">${it.value ?? 'N/A'}${
        typeof it.pct === 'number' ? ` &nbsp;${delta(it.pct)}` : ''
      }</span>
    </div>`
    )
    .join('');
  return `
<section class="sec" data-sec="${esc(title.toLowerCase().replace(/\s+/g, '-'))}">
  <div class="lbl-mini">${esc(title)}</div>
  ${rows || '<div class="sec-note">Data unavailable</div>'}
</section>`;
}

const fmtPct = (p) => (typeof p === 'number' ? `${p > 0 ? '+' : ''}${p.toFixed(2)}%` : 'N/A');

/** Compact global cues: 3-col grid of mini cards — no group headers, max 3. */
function CompactGlobalCues({ groups = [] }) {
  const items = groups.flatMap((g) =>
    (g.items ?? []).map((it) => ({
      group: g.group,
      name: it.name,
      value: it.value,
      pct: it.pct_change,
    }))
  );
  if (!items.length) return '';
  const cards = items
    .slice(0, 3)
    .map(
      (it) => `
    <div class="cue-mini">
      <span class="cue-name">${esc(`${it.group} · ${it.name}`)}</span>
      <span class="cue-val">${it.value != null ? num(it.value) : 'N/A'}</span>
      ${typeof it.pct === 'number' ? `<span class="cue-delta ${it.pct >= 0 ? 'up' : 'down'}">${delta(it.pct)}</span>` : ''}
    </div>`
    )
    .join('');
  return `
<section class="sec" data-sec="global">
  ${secTitle('🌍', 'GLOBAL CUES')}
  <div class="cue-grid">${cards}</div>
</section>`;
}

// ------------------------------------------------------------ PRE-MARKET

/**
 * Pre-market poster (§4): header, market pulse, global cues, what matters
 * today (ranked by the existing importance engine), stocks, sectors,
 * catalysts/risks, view, footer.
 */
export function renderPreMarketHtml(brief = {}, { width, height, scale } = {}) {
  const dims = {
    width: width ?? VISUAL_DEFAULTS.width,
    height: height ?? VISUAL_DEFAULTS.height,
    scale: scale ?? VISUAL_DEFAULTS.scale,
  };
  const now = new Date(brief.generated_at ?? Date.now());
  const stories = (brief.top_developments ?? []).slice(0, 3);

  const storiesBlock = stories.length
    ? `<section class="sec" data-sec="developments">
    ${secTitle('🔥', 'WHAT MATTERS TODAY')}
    ${stories
      .map((s) => `
    <article class="story" style="padding:2px 4px 1px">
      <div class="top" style="gap:1px;font-size:7px">
        <span class="rank">${String(s.rank).padStart(2, '0')}</span>
        <span class="cat">${esc(s.category)}</span>
      </div>
      <h3 style="font-size:13px;line-height:1.0;margin-top:0;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden">${esc(s.headline)}</h3>
      ${s.summary ? `<p class="sum" style="font-size:10px;line-height:1.1;margin-top:0;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden">${esc(truncate(s.summary, 70))}</p>` : ''}
      ${s.why_it_matters ? `<p class="why" style="font-size:8px;color:${theme.colors.muted};line-height:1.05;margin-top:0;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden">${esc(truncate(s.why_it_matters, 50))}</p>` : ''}
      <div class="src" style="font-size:7px;margin-top:0">${sourceLine(s)}</div>
    </article>`
      )
      .join('')}
  </section>`
    : `<section class="sec" data-sec="developments">
    ${secTitle('🔥', 'WHAT MATTERS TODAY')}
    <div class="sec-note">No material developments in the freshness window</div>
  </section>`;

  const watchBlock = () => {
    const stocks = (brief.stocks_to_watch ?? []).slice(0, 2);
    const sectors = (brief.sectors_to_watch ?? []).slice(0, 2);
    if (!stocks.length && !sectors.length) return '';
    const stockRows = stocks
      .map((s) => `<div class="row"><span class="sym">${esc(s.symbol)}</span><span class="why">${esc(truncate(s.reason, 40))}</span></div>`)
      .join('');
    const sectorChips = sectors
      .map((s) => `<span class="chip">${esc(s.sector)}<span class="sub"> ${esc(truncate(s.reason, 20))}</span></span>`)
      .join('');
    return `
<section class="sec" data-sec="watch">
  ${secTitle('📈🏭', 'STOCKS / SECTORS')}
  <div class="cols">
    <div>${stockRows || '<div class="sec-note">—</div>'}</div>
    <div class="chips">${sectorChips || '<div class="sec-note">—</div>'}</div>
  </div>
</section>`;
  };

  const catalystsRisksBlock = () => {
    const cats = brief.catalysts ?? [];
    const risks = brief.risks ?? [];
    if (!cats.length && !risks.length) return '';
    const col = (title, items, cls) => `
  <div class="${cls}">
    <div class="lbl-mini">${esc(title)}</div>
    ${items.length ? items.slice(0, 3).map((i) => `<div class="bul">${esc(truncate(i, 60))}</div>`).join('') : '<div class="sec-note">—</div>'}
  </div>`;
    return `
<section class="sec" data-sec="catalysts">
  <div class="two">
    ${col('CATALYSTS', cats, 'cats')}
    ${col('RISKS', risks, 'risks')}
  </div>
</section>`;
  };

  const body = `
${Header({ title: 'PRE-MARKET INTELLIGENCE', calendar: brief.calendar, now })}
${MarketPulse({ market: brief.market ?? {} })}
${CompactGlobalCues({ groups: brief.global ?? [] })}
${storiesBlock}
${watchBlock()}
${catalystsRisksBlock()}
${ViewCard({ view: brief.view })}
${Footer({ sources: brief.sources ?? [], now, sample: brief.sample })}`;

  return doc(baseCssFor(dims), Poster({ body, ...dims }));
}

// ---------------------------------------------------------------- CLOSING

/** Closing poster (§18): close, breadth, flows, gainers/losers, sectors, drivers. */
export function renderClosingHtml(brief = {}, { width, height, scale } = {}) {
  const dims = {
    width: width ?? VISUAL_DEFAULTS.width,
    height: height ?? VISUAL_DEFAULTS.height,
    scale: scale ?? VISUAL_DEFAULTS.scale,
  };
  const now = new Date(brief.generated_at ?? Date.now());
  const stories = (brief.top_developments ?? []).slice(0, 2);

  const breadth = brief.breadth ?? null;
  const flows = brief.flows ?? null;
  const statsBlock = `
<div class="cols">
  ${
    breadth
      ? MiniStats({
          title: 'MARKET BREADTH',
          items: [
            { label: 'ADVANCES', value: breadth.advances ? num(breadth.advances.value) : 'N/A' },
            { label: 'DECLINES', value: breadth.declines ? num(breadth.declines.value) : 'N/A' },
          ],
        })
      : ''
  }
  ${
    flows
      ? MiniStats({
          title: 'FII / DII',
          items: [
            ...(flows.fii ? [{ label: 'FII', value: num(flows.fii.value), pct: flows.fii.pct_change }] : []),
            ...(flows.dii ? [{ label: 'DII', value: num(flows.dii.value), pct: flows.dii.pct_change }] : []),
          ],
        })
      : ''
  }
</div>`;

  const moversBlock = () => {
    const g = brief.movers?.gainers ?? [];
    const l = brief.movers?.losers ?? [];
    if (!g.length && !l.length) return '';
    const col = (title, rows, cls) => `
  <div>
    <div class="lbl-mini">${title}</div>
    ${
      rows.length
        ? rows
            .map(
              (r) =>
                `<div class="row"><span class="sym" style="font-size:12px">${esc(
                  truncate(r.name, 16)
                )}</span><span class="num ${cls}">${fmtPct(r.pct_change)}</span></div>`
            )
            .join('')
        : '<div class="sec-note">Data unavailable</div>'
    }
  </div>`;
    return `
<section class="sec" data-sec="movers">
  <div class="two">
    ${col('TOP GAINERS', g, 'up')}
    ${col('TOP LOSERS', l, 'down')}
  </div>
</section>`;
  };

  const sectorBlock = () => {
    const rows = brief.sector_performance ?? [];
    if (!rows.length) return '';
    const chips = rows
      .map(
        (r) =>
          `<span class="chip">${esc(r.name)}<span class="sub"> ${fmtPct(r.pct_change)}</span></span>`
      )
      .join('');
    return `
<section class="sec" data-sec="sectors">
  ${secTitle('🏭', 'SECTOR PERFORMANCE')}
  <div class="chips">${chips}</div>
</section>`;
  };

  const driverBlock = brief.key_driver
    ? `
<section class="sec" data-sec="driver">
  <div class="view"><span class="lbl">📣 WHAT DROVE THE MARKET</span>${esc(
    truncate(brief.key_driver.headline, 150)
  )}${brief.key_driver.summary ? `<br><span style="opacity:.9">${esc(truncate(brief.key_driver.summary, 170))}</span>` : ''}</div>
</section>`
    : '';

  const watchBlock = () => {
    const stocks = brief.watch_next?.stocks ?? [];
    const sectors = brief.watch_next?.sectors ?? [];
    if (!stocks.length && !sectors.length) return '';
    return `
<section class="sec" data-sec="watch-next">
  ${secTitle('👀', "TOMORROW'S WATCH")}
  <div class="chips">
    ${stocks.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}
    ${sectors.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}
  </div>
</section>`;
  };

  const storiesBlock = stories.length
    ? `<section class="sec" data-sec="developments">
    ${secTitle('📰', 'KEY DEVELOPMENTS')}
    ${stories
      .map((s) => `
    <article class="story" style="padding:2px 4px 1px">
      <div class="top" style="gap:1px;font-size:7px">
        <span class="rank">${String(s.rank).padStart(2, '0')}</span>
        <span class="cat">${esc(s.category)}</span>
      </div>
      <h3 style="font-size:13px;line-height:1.0;margin-top:0;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden">${esc(s.headline)}</h3>
      ${s.summary ? `<p class="sum" style="font-size:10px;line-height:1.1;margin-top:0;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden">${esc(truncate(s.summary, 70))}</p>` : ''}
      ${s.why_it_matters ? `<p class="why" style="font-size:8px;color:${theme.colors.muted};line-height:1.05;margin-top:0;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden">${esc(truncate(s.why_it_matters, 50))}</p>` : ''}
      <div class="src" style="font-size:7px;margin-top:0">${sourceLine(s)}</div>
    </article>`
      )
      .join('')}
  </section>`
    : '';

  const catalystsRisksBlock = () => {
    const cats = brief.catalysts ?? [];
    const risks = brief.risks ?? [];
    if (!cats.length && !risks.length) return '';
    const col = (title, items, cls) => `
  <div class="${cls}">
    <div class="lbl-mini">${esc(title)}</div>
    ${items.length ? items.slice(0, 3).map((i) => `<div class="bul">${esc(truncate(i, 60))}</div>`).join('') : '<div class="sec-note">—</div>'}
  </div>`;
    return `
<section class="sec" data-sec="catalysts">
  <div class="two">
    ${col('CATALYSTS', cats, 'cats')}
    ${col('RISKS', risks, 'risks')}
  </div>
</section>`;
  };

  const body = `
${Header({ title: 'MARKET CLOSE', calendar: brief.calendar, now })}
${MarketPulse({ market: brief.market ?? {} })}
${statsBlock}
${moversBlock()}
${sectorBlock()}
${driverBlock}
${storiesBlock}
${watchBlock()}
${catalystsRisksBlock()}
${ViewCard({ view: brief.view, label: 'NEW AGE ALGOS VIEW' })}
${Footer({ sources: brief.sources ?? [], now, sample: brief.sample })}`;

  return doc(baseCssFor(dims), Poster({ body, ...dims }));
}

// ----------------------------------------------------------------- ALERT

/** Breaking alert poster (§17): 1080×1080 single-story card. */
export function renderAlertHtml(brief = {}, { width, height, scale } = {}) {
  const dims = {
    width: width ?? VISUAL_DEFAULTS.alertWidth,
    height: height ?? VISUAL_DEFAULTS.alertHeight,
    scale: scale ?? VISUAL_DEFAULTS.scale,
  };
  const now = new Date(brief.generated_at ?? Date.now());
  const statusLabel = brief.status_label ?? 'REPORTED';
  const statusClass = brief.status_class ?? 'b-reported';
  const impact = brief.impact
    ? `<span class="impact i-${brief.impact}">${String(brief.impact).toUpperCase()}</span>`
    : '';

  const body = `
<div class="hd">
  ${brief.sample ? '<span class="sample">SAMPLE / TEST DATA</span>' : ''}
  <div class="al-head">
    <span class="al-kicker">🚨 MARKET ALERT</span>
    <span class="brand" style="font-size:13px"><span class="bolt">⚡</span>${esc(
      theme.brand.name
    )}</span>
  </div>
  <div class="rule" style="margin-top:6px"></div>
  <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
    <span class="al-cat">${esc(brief.category ?? 'MARKET')}</span>
    <span class="badge ${statusClass}">${esc(statusLabel)}</span>
    ${impact}
  </div>
  <h1 class="al-headline">${esc(brief.headline ?? 'Market alert')}</h1>
  ${
    brief.summary
      ? `<p class="al-sum">${esc(truncate(brief.summary, 300))}</p>`
      : ''
  }
  ${
    brief.why_it_matters
      ? `<div class="lbl-mini">WHY IT MATTERS</div>
  <p class="al-sum" style="font-size:13px">${esc(truncate(brief.why_it_matters, 220))}</p>`
      : ''
  }
  ${
    (brief.stocks?.length || brief.sectors?.length)
      ? `<div class="lbl-mini">AFFECTED</div>
  <div class="chips">
    ${(brief.stocks ?? []).map((s) => `<span class="chip">${esc(String(s).toUpperCase())}</span>`).join('')}
    ${(brief.sectors ?? []).map((s) => `<span class="chip">${esc(String(s).toUpperCase())}</span>`).join('')}
  </div>`
      : ''
  }
  ${
    brief.source_name
      ? `<div class="src" style="display:flex;justify-content:space-between;margin-top:12px;font-size:11px;color:${theme.colors.muted}">
    <span>${
      brief.source_url
        ? `<a href="${esc(brief.source_url)}" style="color:${theme.colors.muted}">${esc(brief.source_name)}</a>`
        : esc(brief.source_name)
    }${
      brief.published_at && Number.isFinite(Date.parse(brief.published_at))
        ? ' • ' + esc(fmtTime(new Date(brief.published_at)))
        : ''
    }</span>
    <span>${esc(fmtDateShort(now))}</span>
  </div>`
      : ''
  }
</div>
${Footer({ sources: brief.source_name ? [{ name: brief.source_name }] : [], now, sample: brief.sample })}`;

  return doc(baseCssFor(dims), Poster({ body, ...dims }));
}

// ------------------------------------------------------------------- PDF

const pdfDoc = (css, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body class="pdf">${body}</body></html>`;

const pdfFooter = (now, sample) => `
<div class="ft">
  ⚡ ${esc(theme.brand.name)} • ${esc(theme.brand.tagline)} — Generated ${esc(
    fmtDateShort(now)
  )} • ${esc(fmtTime(now))}${sample ? ' • SAMPLE / TEST DATA' : ''}<br>
  <span style="color:${theme.colors.warning}">For informational purposes only. Not investment advice.</span>
</div>`;

/**
 * A4 portrait PDF (§15): 4 pages — executive summary, market & global,
 * developments, stocks/sectors/risks/view. Text selectable, links clickable.
 */
export function renderPdfHtml(brief = {}, { type = 'premarket' } = {}) {
  const now = new Date(brief.generated_at ?? Date.now());
  const isClosing = type === 'closing';
  const title = isClosing ? 'MARKET CLOSE' : 'PRE-MARKET INTELLIGENCE';
  const developments = brief.top_developments ?? [];
  const status = brief.calendar?.closed
    ? brief.calendar.closedLabel ?? 'MARKET CLOSED'
    : brief.calendar?.kind === 'holiday'
      ? 'NSE HOLIDAY'
      : 'TRADING DAY';

  const pulseTable = ['nifty', 'banknifty', 'sensex']
    .map((k) => {
      const row = brief.market?.[k];
      const label = k === 'nifty' ? 'NIFTY 50' : k === 'banknifty' ? 'BANK NIFTY' : 'SENSEX';
      return `<tr><td>${label}</td><td class="n">${row ? num(row.value) : 'N/A'}</td><td class="n">${
        row ? (row.pct_change != null ? fmtPct(row.pct_change) : 'N/A') : 'N/A'
      }</td></tr>`;
    })
    .join('');

  const globalRows = (brief.global ?? [])
    .flatMap((g) =>
      g.items.map(
        (it) =>
          `<tr><td>${esc(g.group)}</td><td>${esc(it.name)}</td><td class="n">${
            it.value != null ? num(it.value) : 'N/A'
          }</td><td class="n">${it.pct_change != null ? fmtPct(it.pct_change) : 'N/A'}</td></tr>`
      )
    )
    .join('');

  const storyHtml = (s) => `
<article class="story">
  <div class="dim">${String(s.rank).padStart(2, '0')} • ${esc(s.category)}${
    s.updated ? ' • UPDATED' : ''
  } • ${esc(s.status)}</div>
  <h3>${esc(s.headline)}</h3>
  ${s.summary ? `<p>${esc(s.summary)}</p>` : ''}
  ${s.why_it_matters ? `<p><b>WHY IT MATTERS:</b> ${esc(s.why_it_matters)}</p>` : ''}
  <div class="src">Source: ${
    s.source_url
      ? `<a href="${esc(s.source_url)}">${esc(s.source_name ?? 'unknown')}</a>`
      : esc(s.source_name ?? 'unknown')
  }${s.published_at && Number.isFinite(Date.parse(s.published_at)) ? ` • ${esc(fmtTime(new Date(s.published_at)))}` : ''}</div>
</article>`;

  const stockRows = (brief.stocks_to_watch ?? [])
    .map((s) => `<tr><td><b>${esc(s.symbol)}</b></td><td>${esc(s.reason)}</td></tr>`)
    .join('');
  const sectorRows = (brief.sectors_to_watch ?? [])
    .map((s) => `<tr><td><b>${esc(s.sector)}</b></td><td>${esc(s.reason)}</td></tr>`)
    .join('');

  const listBlock = (title, items) =>
    items.length
      ? `<h2>${title}</h2><ul style="margin-left:14pt">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
      : '';

  const sourceLinks = (brief.sources ?? [])
    .map((s) => (s.url ? `<a href="${esc(s.url)}">${esc(s.name)}</a>` : esc(s.name)))
    .join(' • ');

  return pdfDoc(
    baseCssFor({ width: 0, height: 0, scale: 1 }),
    `
<section class="page">
  <div class="brand" style="font-size:16pt">⚡ ${esc(theme.brand.name)}</div>
  <div class="rule" style="margin-top:4pt"></div>
  <h1>${esc(title)}</h1>
  <div class="dim">${esc(brief.calendar?.weekday ?? '')} • ${esc(
    brief.calendar?.dateLong ?? brief.date ?? ''
  )} • ${esc(brief.calendar?.time ?? '')} • ${esc(status)}</div>
  <h2>EXECUTIVE SUMMARY</h2>
  ${
    brief.view
      ? `<div class="view"><span class="lbl">🎯 NEW AGE ALGOS VIEW</span>${esc(brief.view)}</div>`
      : '<p class="dim">No AI-produced view available for this briefing.</p>'
  }
  <h2>MARKET PULSE</h2>
  <table>${pulseTable}</table>
  <h2>TODAY'S TOP DEVELOPMENTS</h2>
  ${
    developments.length
      ? developments
          .slice(0, 3)
          .map((d) => `<p><b>${String(d.rank).padStart(2, '0')} • ${esc(d.headline)}</b></p>`)
          .join('')
      : '<p class="dim">No material developments in the freshness window.</p>'
  }
  ${pdfFooter(now, brief.sample)}
</section>

<section class="page">
  <h2>MARKET &amp; GLOBAL CUES</h2>
  <table>
    <tr><td><b>INDEX</b></td><td class="n"><b>VALUE</b></td><td class="n"><b>CHANGE</b></td></tr>
    ${pulseTable}
  </table>
  ${
    isClosing && brief.breadth
      ? `<h2>MARKET BREADTH</h2><table>
      <tr><td>ADVANCES</td><td class="n">${brief.breadth.advances ? num(brief.breadth.advances.value) : 'N/A'}</td></tr>
      <tr><td>DECLINES</td><td class="n">${brief.breadth.declines ? num(brief.breadth.declines.value) : 'N/A'}</td></tr>
    </table>`
      : ''
  }
  ${
    isClosing && brief.flows
      ? `<h2>FII / DII</h2><table>
      ${brief.flows.fii ? `<tr><td>FII</td><td class="n">${num(brief.flows.fii.value)}</td></tr>` : ''}
      ${brief.flows.dii ? `<tr><td>DII</td><td class="n">${num(brief.flows.dii.value)}</td></tr>` : ''}
    </table>`
      : ''
  }
  ${
    globalRows
      ? `<h2>GLOBAL CUES</h2><table>
    <tr><td><b>GROUP</b></td><td><b>INSTRUMENT</b></td><td class="n"><b>VALUE</b></td><td class="n"><b>CHANGE</b></td></tr>
    ${globalRows}</table>`
      : '<p class="dim">Global data unavailable.</p>'
  }
  ${
    isClosing && brief.sector_performance?.length
      ? `<h2>SECTOR PERFORMANCE</h2><table>${brief.sector_performance
          .map(
            (r) =>
              `<tr><td>${esc(r.name)}</td><td class="n">${fmtPct(r.pct_change)}</td></tr>`
          )
          .join('')}</table>`
      : ''
  }
  ${pdfFooter(now, brief.sample)}
</section>

<section class="page">
  <h2>TOP DEVELOPMENTS</h2>
  ${
    developments.length
      ? developments.map(storyHtml).join('')
      : '<p class="dim">No material developments in the freshness window.</p>'
  }
  ${
    isClosing && brief.key_driver
      ? `<h2>WHAT DROVE THE MARKET</h2><p>${esc(brief.key_driver.headline)}</p>`
      : ''
  }
  ${pdfFooter(now, brief.sample)}
</section>

<section class="page">
  <h2>STOCKS TO WATCH</h2>
  ${stockRows ? `<table>${stockRows}</table>` : '<p class="dim">No stocks surfaced by fresh events.</p>'}
  <h2>SECTORS TO WATCH</h2>
  ${sectorRows ? `<table>${sectorRows}</table>` : '<p class="dim">No sectors surfaced by fresh events.</p>'}
  <div class="cols">
    <div>${listBlock('KEY CATALYSTS', brief.catalysts ?? [])}</div>
    <div>${listBlock('KEY RISKS', brief.risks ?? [])}</div>
  </div>
  ${
    brief.view
      ? `<div class="view"><span class="lbl">🎯 NEW AGE ALGOS VIEW</span>${esc(brief.view)}</div>`
      : ''
  }
  ${sourceLinks ? `<h2>SOURCES</h2><p class="src">${sourceLinks}</p>` : ''}
  ${pdfFooter(now, brief.sample)}
</section>`
  );
}

// ----------------------------------------------------------------- helper

/** Layout CSS for a template at its logical dimensions. */
function baseCssFor(dims) {
  const scale = dims.scale || VISUAL_DEFAULTS.scale;
  return baseCss({
    vw: Math.round(dims.width / scale),
    vh: Math.round(dims.height / scale),
    alert: dims.height <= dims.width, // square alert template gets tighter padding
  });
}
