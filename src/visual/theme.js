/**
 * Central visual theme — brand, colors, fonts, spacing and the full CSS for
 * the image/PDF briefing templates. NOTHING else in src/visual/ hard-codes a
 * color, font family or spacing value.
 *
 * Dimensions: VISUAL_WIDTH × VISUAL_HEIGHT are OUTPUT pixels. The layout is
 * authored in a logical viewport of width/scale × height/scale and rendered
 * with deviceScaleFactor = scale.
 *
 *   scale = 2  →  1080 output is a 540px logical canvas. Everything below is
 *                 authored in LOGICAL px; an 18px summary is 36 output px.
 *
 * Page height is DYNAMIC: `VISUAL_HEIGHT` is now the CEILING of one page, not
 * the fixed size of the poster. render.js measures the real content and picks
 * the smallest height that contains it (rounding up by PAGE_STEP), so a thin
 * report never ships a 600px slab of empty background, and a rich one flows to
 * a second page instead of being squeezed.
 *
 * READABILITY CONTRACT — enforced by test/visual-layout.test.js:
 *   - no `-webkit-line-clamp`, no `text-overflow: ellipsis` anywhere in the CSS
 *   - no truncation helper exists in components.js, so an ellipsis cannot be
 *     produced by accident
 *   - nothing below MIN_FONT logical px except the brand tagline/disclaimer
 *
 * Fonts: Inter (preferred) embedded as base64 woff2 so rendering never needs
 * the network; Roboto / Noto Sans / Arial remain in the stack as fallback.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Output-pixel dimensions are configurable; layout derives from them. */
export const VISUAL_DEFAULTS = {
  width: 1080,
  height: 1600, // CEILING for one page (was a fixed 1350 — see PART 17/20)
  compactHeight: 1350, // compact mode: VISUAL_HEIGHT=1350
  alertWidth: 1080,
  alertHeight: 1080,
  // A light alert must not print a square with a third of it empty background —
  // the renderer measures the content and only grows to `alertHeight` if it has
  // to (§PART 17: content decides the box, not the other way round).
  alertMinHeight: 760,
  scale: 2,
  dir: 'artifacts/briefings',
  pdfMaxBytes: 25 * 1024 * 1024,
  pngMaxBytes: 8 * 1024 * 1024,
  // Page geometry (OUTPUT px)
  minPageHeight: 1080, // page 1 never renders shorter than 4:5
  pageStep: 20, // heights round up to this → at most 19px of slack
  maxPages: 8, // ADVISORY: the ideal cap for a multi-page set (see packPages)
  hardMaxPages: 10, // hard stop — beyond this a render aborts, rather than shipping an album
  maxIntrinsicHeight: 4000, // safety: a single section taller than this is broken input
};

/** Smallest font size we will put on a poster, in logical px (= 24 output px). */
export const MIN_FONT = 12;

/** Resolve visual dimensions from env (VISUAL_WIDTH / VISUAL_HEIGHT). */
export function visualDimensions(env = process.env, kind = 'briefing') {
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 200 && n <= 4096 ? Math.round(n) : fallback;
  };
  if (kind === 'alert') {
    return {
      width: num(env.VISUAL_ALERT_WIDTH, VISUAL_DEFAULTS.alertWidth),
      height: num(env.VISUAL_ALERT_HEIGHT, VISUAL_DEFAULTS.alertHeight),
      maxHeight: num(env.VISUAL_ALERT_HEIGHT, VISUAL_DEFAULTS.alertHeight),
      scale: num(env.VISUAL_SCALE, VISUAL_DEFAULTS.scale),
    };
  }
  const width = num(env.VISUAL_WIDTH, VISUAL_DEFAULTS.width);
  const maxHeight = num(env.VISUAL_HEIGHT, VISUAL_DEFAULTS.height);
  return {
    width,
    height: maxHeight,
    maxHeight,
    scale: num(env.VISUAL_SCALE, VISUAL_DEFAULTS.scale),
  };
}

/**
 * The single source of truth for brand + design tokens.
 * Colors/typography must not scatter through the code.
 */
export const theme = Object.freeze({
  brand: Object.freeze({
    name: 'NEW AGE ALGOS',
    tagline: 'Data-driven • Systematic • Transparent',
  }),
  colors: Object.freeze({
    background: '#0B1220', // primary background — very dark navy
    surface: '#111827', // secondary panels
    card: '#172033', // card background
    text: '#F8FAFC', // primary text
    muted: '#94A3B8', // secondary text / metadata
    positive: '#22C55E', // market direction ONLY
    negative: '#EF4444', // market direction ONLY
    warning: '#F59E0B', // warnings / awaiting confirmation
    accent: '#4C8DFF', // restrained New Age Algos accent
    border: 'rgba(148, 163, 184, 0.16)', // subtle hairlines
    borderStrong: 'rgba(148, 163, 184, 0.30)',
  }),
  fonts: Object.freeze({
    primary: 'Inter',
    fallback: 'Roboto, "Noto Sans", Arial, sans-serif',
  }),
  spacing: Object.freeze({ xs: 4, sm: 8, md: 12, lg: 18, xl: 26 }),
  radius: 10,
  /**
   * Logical type scale. The published ranges (header 30–44, section 22–26,
   * headline 24–30, summary 17–20, metadata 13–15) are read as a floor for
   * readability, not a ceiling: at scale 2 every value doubles on screen, so
   * "small" here is 26 output px — comfortably legible on a phone.
   */
  type: Object.freeze({
    brand: 16,
    title: 34,
    section: 17,
    headline: 19,
    body: 15,
    meta: 12,
    kicker: 13,
    display: 26, // big index numbers
  }),
});

/** HTML-escape for embedding dynamic values (decode stale entities first). */
export function esc(value) {
  return String(value ?? '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m) => m) // keep real entities intact
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --------------------------------------------------------------- FONTS

/** Base64 @font-face rules for Inter 400/500/600/700 (no network at render). */
export function fontFaceCss() {
  let dir;
  try {
    const entry = require.resolve('@fontsource/inter');
    dir = path.join(path.dirname(entry), 'files');
    if (!fs.existsSync(dir)) dir = path.join(path.dirname(entry), '..', 'files');
  } catch {
    return ''; // font package missing → system fallback stack still works
  }
  const rules = [];
  for (const weight of [400, 500, 600, 700]) {
    const file = path.join(dir, `inter-latin-${weight}-normal.woff2`);
    if (!fs.existsSync(file)) continue;
    const b64 = fs.readFileSync(file).toString('base64');
    rules.push(
      `@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};` +
        `font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`
    );
  }
  return rules.join('\n');
}

// --------------------------------------------------------------- CSS

/**
 * Full stylesheet for a poster. `vw`/`vh` are LOGICAL px (output / scale).
 *
 * Editorial, not dashboard: text blocks flow, cards only where a card aids
 * scanning, and NOTHING is clamped to a line or clipped with an ellipsis.
 */
export function baseCss({ vw = 540, vh = 800, alert = false } = {}) {
  const c = theme.colors;
  const t = theme.type;
  return `
${fontFaceCss()}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:${c.background}}
body{font-family:'${theme.fonts.primary}',${theme.fonts.fallback};color:${c.text};
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
article,section,div,h1,h2,h3,h4,h5,h6,p,span{margin:0;padding:0}

.poster{width:${vw}px;min-height:${vh}px;background:${c.background};color:${c.text};
  padding:${alert ? '20px 24px 16px' : '18px 22px 16px'};display:flex;flex-direction:column;
  position:relative;overflow:hidden}
/* Fragments are indivisible blocks: they never shrink to make a fixed canvas
   fit (that is how content gets squashed), and the gap between them is the
   only vertical rhythm the page has. */
.poster > .frag{flex-shrink:0;min-width:0}
.poster > .frag + .frag{margin-top:9px}
/* The footer is always last; the auto margin absorbs the rounding slack so the
   page bottom reads as padding rather than as an empty band. */
.poster > .frag:last-child{margin-top:auto}

/* header */
.brand{display:flex;align-items:center;gap:6px;font-size:${t.brand}px;font-weight:700;
  letter-spacing:.12em;color:${c.text}}
.brand .bolt{color:${c.accent}}
.rule{height:2px;background:linear-gradient(90deg,${c.accent},rgba(76,141,255,0));border-radius:2px}
.hd-title{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;
  font-size:${t.title}px;font-weight:700;letter-spacing:.02em;line-height:1.05;margin-top:6px}
.hd-title.cont{font-size:${Math.round(t.title * 0.62)}px}
.hd-date{font-size:${t.meta}px;color:${c.muted};font-weight:600;letter-spacing:.08em;
  text-transform:uppercase;margin-top:5px}
.hd{padding-bottom:8px;border-bottom:1px solid ${c.border}}
.closed-chip{display:inline-block;font-size:${t.meta}px;font-weight:700;letter-spacing:.08em;
  color:${c.background};background:${c.warning};border-radius:4px;padding:2px 7px}
.hd-page{margin-left:auto;font-size:${t.meta}px;color:${c.muted};font-weight:700;letter-spacing:.1em}

/* sections */
.sec-h{display:flex;align-items:center;gap:7px;font-size:${t.section}px;font-weight:700;
  letter-spacing:.1em;text-transform:uppercase;color:${c.text};margin-bottom:6px}
.sec-h .ico{font-size:${t.section}px;line-height:1}
.sec-h::after{content:'';flex:1;height:1px;background:${c.borderStrong}}
.sec-note{font-size:${t.meta}px;color:${c.muted};font-weight:600;letter-spacing:.05em}

/* cards */
.card{background:${c.card};border:1px solid ${c.border};border-radius:${theme.radius}px;padding:9px 11px}
.grid{display:grid;gap:8px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}

/* market pulse */
.pulse{grid-template-columns:repeat(3,1fr)}
.pulse .k{font-size:${t.meta}px;color:${c.muted};font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.pulse .v{font-size:${t.display}px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums;
  line-height:1.1}
.pulse .d{font-size:${t.body - 2}px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}
.pulse .na{color:${c.muted};font-weight:600}
.up{color:${c.positive}}
.down{color:${c.negative}}
.flat{color:${c.muted}}

/* global cues — grouped columns, never ellipsised */
.cue-groups{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.cue-group{font-size:${t.meta}px;color:${c.accent};font-weight:800;letter-spacing:.1em;
  text-transform:uppercase;margin-bottom:4px}
.cue{display:flex;align-items:baseline;gap:6px;padding:4px 0;
  border-bottom:1px solid ${c.border}}
.cue:last-child{border-bottom:none}
.cue .k{font-size:${t.body - 2}px;color:${c.muted};font-weight:700;letter-spacing:.04em;
  text-transform:uppercase;white-space:nowrap}
.cue .v{font-size:${t.body}px;font-weight:700;font-variant-numeric:tabular-nums;margin-left:auto}
.cue .d{font-size:${t.meta}px;font-weight:700;font-variant-numeric:tabular-nums;min-width:62px;text-align:right}

/* editorial story — the centrepiece. Auto height, wraps, NEVER clamped. */
.story{background:${c.card};border:1px solid ${c.border};border-left:3px solid ${c.accent};
  border-radius:${theme.radius}px;padding:10px 13px 11px}
.story+.story{margin-top:9px}
.story .top{display:flex;align-items:center;gap:8px;font-size:${t.kicker}px;color:${c.muted};
  font-weight:700;letter-spacing:.08em;text-transform:uppercase;flex-wrap:wrap;line-height:1.3}
.story .rank{color:${c.accent};font-weight:800;font-variant-numeric:tabular-nums}
.story .cat{color:${c.accent};font-weight:800}
.story .tag{color:${c.text};background:${c.surface};border:1px solid ${c.borderStrong};
  border-radius:4px;padding:1px 6px;font-size:${t.meta}px;letter-spacing:.06em}
.story .upd{color:${c.warning};font-weight:800}
.story h3{font-size:${t.headline}px;font-weight:700;line-height:1.24;margin-top:7px;
  white-space:normal;overflow-wrap:break-word}
.story .sum{font-size:${t.body}px;color:${c.text};opacity:.94;line-height:1.5;margin-top:7px;
  white-space:normal;overflow-wrap:break-word}
.story .why{margin-top:8px;padding:7px 10px;background:${c.surface};
  border-left:2px solid ${c.accent};border-radius:0 6px 6px 0}
.story .why .why-l{display:block;font-size:${t.meta}px;font-weight:800;letter-spacing:.1em;
  color:${c.accent};text-transform:uppercase;margin-bottom:3px}
.story .why p{font-size:${t.body - 1}px;color:${c.text};opacity:.9;line-height:1.45}
.story .src{display:flex;justify-content:space-between;align-items:center;gap:8px;
  font-size:${t.meta}px;color:${c.muted};margin-top:9px;letter-spacing:.03em;flex-wrap:wrap}
.story .src a{color:${c.muted};text-decoration:none;border-bottom:1px dotted ${c.borderStrong}}
.story .src .badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.story .src .also{flex-basis:100%;font-size:${t.meta}px;color:${c.muted};opacity:.85;
  letter-spacing:.02em;line-height:1.4}
.badge{font-size:${t.meta}px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  padding:2px 6px;border-radius:4px;white-space:nowrap}
.b-confirmed{background:rgba(34,197,94,.16);color:${c.positive}}
.b-reported{background:rgba(76,141,255,.16);color:${c.accent}}
.b-awaiting{background:rgba(245,158,11,.16);color:${c.warning}}
.b-unconfirmed{background:rgba(239,68,68,.14);color:${c.negative}}
.impact{font-size:${t.meta}px;font-weight:800;letter-spacing:.08em;padding:2px 7px;
  border-radius:4px;text-transform:uppercase}
.i-positive{background:rgba(34,197,94,.16);color:${c.positive}}
.i-negative{background:rgba(239,68,68,.16);color:${c.negative}}
.i-mixed{background:rgba(245,158,11,.16);color:${c.warning}}
.i-neutral,.i-unclear{background:rgba(148,163,184,.16);color:${c.muted}}

/* synthesis block (WHAT DROVE THE MARKET / SESSION TAKEAWAY) */
.takeaway{background:linear-gradient(180deg,rgba(76,141,255,.10),rgba(76,141,255,.03));
  border:1px solid rgba(76,141,255,.35);border-left:3px solid ${c.accent};
  border-radius:${theme.radius}px;padding:11px 14px}
.takeaway .lbl{font-size:${t.meta}px;font-weight:800;letter-spacing:.12em;color:${c.accent};
  text-transform:uppercase;display:block;margin-bottom:6px}
.takeaway p{font-size:${t.body}px;line-height:1.55;color:${c.text};opacity:.95}

/* agenda rows (KEEP AN EYE ON TODAY) */
/* Two-up so a five-item agenda costs half a screen, not most of one. */
.agenda{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.agenda .item{background:${c.surface};border:1px solid ${c.border};border-radius:8px;padding:8px 11px}
.agenda .a-h{display:flex;align-items:center;gap:7px;font-size:${t.kicker}px;font-weight:800;
  letter-spacing:.07em;text-transform:uppercase;color:${c.text}}
.agenda .a-h .emo{font-size:${t.kicker}px}
.agenda .a-b{font-size:${t.body - 1}px;color:${c.text};opacity:.88;line-height:1.45;margin-top:4px}

/* list rows (stocks / sectors / gainers) */
.rows{display:flex;flex-direction:column}
.row{display:flex;align-items:baseline;gap:10px;padding:6px 0;font-size:${t.body};
  border-bottom:1px solid ${c.border}}
.row:last-child{border-bottom:none}
.row .sym{font-weight:800;letter-spacing:.05em;white-space:nowrap;min-width:104px}
.row .why{color:${c.muted};font-size:${t.meta}px;line-height:1.4;white-space:normal}
/* Watch rows: symbol column is a fixed track so reasons line up, and a grouped
   row ("HDFC BANK · ICICI BANK") is allowed to wrap instead of shoving the
   reason off to a ragged position. */
.row.watch .sym{flex:0 0 44%;white-space:normal;min-width:0;line-height:1.3}
.row.watch .why{flex:1 1 auto}
.row .num{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;
  font-size:${t.body - 1}px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}
.chip{background:${c.surface};border:1px solid ${c.border};border-radius:6px;
  padding:5px 9px;font-size:${t.meta}px;font-weight:700;color:${c.text};letter-spacing:.04em}
.chip .sub{color:${c.muted};font-weight:600}
.chip-list{display:flex;flex-direction:column;gap:5px;margin-top:5px}
.chip-list .chip{display:flex;gap:8px;align-items:baseline}
.chip-list .chip .sub{white-space:normal;line-height:1.4}

/* two-column catalyst / risk lists */
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.bul{font-size:${t.meta}px;color:${c.text};line-height:1.45;padding:3px 0 3px 12px;
  position:relative}
.bul::before{content:'';position:absolute;left:0;top:9px;width:5px;height:5px;border-radius:50%;
  background:${c.accent}}
.risks .bul::before{background:${c.warning}}
.col-head{font-size:${t.kicker}px;font-weight:800;letter-spacing:.12em;color:${c.accent};
  text-transform:uppercase;margin-bottom:4px}

/* mini stat tables (breadth / flows) */
.minitable{background:${c.card};border:1px solid ${c.border};border-radius:${theme.radius}px;
  padding:9px 11px}
.minitable .lbl-mini{margin-bottom:4px}
.row .num.up{color:${c.positive}}
.row .num.down{color:${c.negative}}

/* view */
.view{background:linear-gradient(180deg,rgba(76,141,255,.10),rgba(76,141,255,.03));
  border:1px solid rgba(76,141,255,.35);border-left:3px solid ${c.accent};
  border-radius:${theme.radius}px;padding:9px 13px;font-size:${t.body}px;line-height:1.5}
.view .lbl{font-size:${t.meta}px;font-weight:800;letter-spacing:.1em;color:${c.accent};
  text-transform:uppercase;display:block;margin-bottom:5px}

/* empty-state note (never a decorative dash) */
.note-box{background:${c.surface};border:1px dashed ${c.borderStrong};border-radius:8px;
  padding:9px 12px;font-size:${t.body - 1}px;color:${c.muted};line-height:1.45}

/* footer */
.ft{margin-top:12px;padding-top:8px;border-top:1px solid ${c.border}}
.ft .line1{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
.ft .bname{font-size:${t.body - 1}px;font-weight:800;letter-spacing:.1em;white-space:nowrap}
.ft .btag{font-size:${t.meta}px;color:${c.muted};letter-spacing:.06em;white-space:nowrap;
  margin-left:auto;text-align:right}
.ft .meta{font-size:${t.meta}px;color:${c.muted};margin-top:4px;line-height:1.45}
.ft .meta b{color:${c.text};font-weight:600}
.ft .disc{color:${c.warning};font-weight:600}
.sample{display:inline-block;background:${c.warning};color:${c.background};font-weight:800;
  font-size:${t.meta}px;letter-spacing:.08em;padding:2px 6px;border-radius:4px;margin-bottom:4px}

/* alert template specifics */
.al-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.al-kicker{font-size:${t.section}px;font-weight:800;letter-spacing:.16em;color:${c.negative};
  text-transform:uppercase}
.al-cat{display:inline-block;background:${c.card};border:1px solid ${c.borderStrong};
  border-radius:6px;padding:4px 10px;font-size:${t.meta}px;font-weight:700;letter-spacing:.1em;
  color:${c.accent};text-transform:uppercase}
.al-headline{font-size:26px;font-weight:700;line-height:1.3;margin-top:12px;
  white-space:normal;overflow-wrap:break-word}
.al-sum{font-size:${t.body + 1}px;line-height:1.6;margin-top:10px;color:${c.text};opacity:.94;
  white-space:normal}
.lbl-mini{font-size:${t.kicker}px;font-weight:800;letter-spacing:.14em;color:${c.accent};
  text-transform:uppercase;margin-top:12px;margin-bottom:4px}

/* PDF (A4 flow — text selectable, links clickable) */
@page{size:A4;margin:0;background:${c.background}}
html,body{background:${c.background};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pdf{background:${c.background};color:${c.text};font-family:'${theme.fonts.primary}',${theme.fonts.fallback};
  font-size:10pt;line-height:1.5;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
/* Each page paints its OWN opaque background (not just the propagated body
   background) so every A4 page is navy even in viewers that skip canvas fills. */
.pdf .page{width:210mm;min-height:297mm;padding:14mm 15mm;page-break-after:always;
  display:flex;flex-direction:column;background:${c.background};
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.pdf .page:last-child{page-break-after:auto}
.pdf h1{font-size:22pt;letter-spacing:.02em}
.pdf h2{font-size:13pt;letter-spacing:.12em;text-transform:uppercase;margin:10pt 0 6pt;
  padding-bottom:3pt;border-bottom:1px solid ${c.border}}
.pdf h3{font-size:11.5pt;margin:8pt 0 3pt}
.pdf .dim{color:${c.muted};font-size:9pt;letter-spacing:.08em;text-transform:uppercase}
.pdf table{width:100%;border-collapse:collapse;font-size:9.5pt}
.pdf td{padding:4pt 6pt;border-bottom:1px solid ${c.border}}
.pdf td.n{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.pdf a{color:${c.accent};text-decoration:none}
.pdf .src{font-size:8.5pt;color:${c.muted}}
.pdf .story{background:${c.surface};border:1px solid ${c.border};border-left:3pt solid ${c.accent};
  border-radius:6pt;padding:7pt 9pt;margin-bottom:7pt;page-break-inside:avoid}
.pdf .story h3{font-size:11.5pt;line-height:1.3;margin:4pt 0 3pt}
.pdf .story .sum{font-size:10pt;line-height:1.5;margin-bottom:4pt}
.pdf .story .why{background:rgba(76,141,255,.08);border-left:2pt solid ${c.accent};
  border-radius:0 4pt 4pt 0;padding:5pt 7pt;margin-top:4pt}
.pdf .story .why .why-l{font-size:8.5pt;font-weight:800;letter-spacing:.1em;color:${c.accent};
  text-transform:uppercase;display:block;margin-bottom:2pt}
.pdf .view{font-size:10.5pt;margin-top:8pt}
.pdf .takeaway{margin-top:6pt}
.pdf .ft{margin-top:auto;border-top:1px solid ${c.border};padding-top:6pt;font-size:8.5pt;
  color:${c.muted}}
.pdf .cols{gap:10mm}
`;
}
