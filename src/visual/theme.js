/**
 * Central visual theme — brand, colors, fonts, spacing and the full CSS for
 * the image/PDF briefing templates. NOTHING else in src/visual/ hard-codes a
 * color, font family or spacing value (§27).
 *
 * Dimensions: VISUAL_WIDTH × VISUAL_HEIGHT are OUTPUT pixels (default
 * 1080 × 1350). The layout is authored in a logical viewport of
 * width/scale × height/scale (default 540 × 675) and rendered with
 * deviceScaleFactor = scale (default 2) so the spec's typography sizes
 * (13–16px body) are honored literally while remaining readable on a phone
 * (26–32 output px). Alert template defaults to 1080 × 1080 (square).
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
  height: 1350,
  alertWidth: 1080,
  alertHeight: 1080,
  scale: 2,
  dir: 'artifacts/briefings',
  pdfMaxBytes: 25 * 1024 * 1024,
  pngMaxBytes: 8 * 1024 * 1024,
};

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
      scale: num(env.VISUAL_SCALE, VISUAL_DEFAULTS.scale),
    };
  }
  return {
    width: num(env.VISUAL_WIDTH, VISUAL_DEFAULTS.width),
    height: num(env.VISUAL_HEIGHT, VISUAL_DEFAULTS.height),
    scale: num(env.VISUAL_SCALE, VISUAL_DEFAULTS.scale),
  };
}

/**
 * The single source of truth for brand + design tokens.
 * §27: do not scatter colors/typography through the code.
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
  radius: 10, // 8–14px range from the spec — not everything round
  type: Object.freeze({
    // logical px — spec §7 ranges, lower/mid bound for a dense poster
    brand: 15,
    title: 30,
    section: 14,
    headline: 17,
    body: 13,
    meta: 11,
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
 * Full stylesheet for a poster (fixed canvas) + shared card/section classes.
 * `vw`/`vh` are LOGICAL px (output / scale).
 */
export function baseCss({ vw = 540, vh = 675, alert = false } = {}) {
  const c = theme.colors;
  const t = theme.type;
  const sp = theme.spacing;
  return `
${fontFaceCss()}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:${c.background}}
body{font-family:'${theme.fonts.primary}',${theme.fonts.fallback};color:${c.text};
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
article,section,div,h1,h2,h3,h4,h5,h6,p,span{margin:0;padding:0}

.poster{width:${vw}px;min-height:${vh}px;background:${c.background};color:${c.text};
  padding:${alert ? '16px 20px 12px' : '14px 18px 12px'};display:flex;flex-direction:column;
  position:relative;overflow:hidden}
.poster>footer{margin-top:auto}

/* header */
.brand{display:flex;align-items:center;gap:5px;font-size:${t.brand}px;font-weight:700;
  letter-spacing:.12em;color:${c.text}}
.brand .bolt{color:${c.accent}}
.rule{height:2px;background:linear-gradient(90deg,${c.accent},rgba(76,141,255,0));border-radius:2px}
.hd-title{font-size:${t.title}px;font-weight:700;letter-spacing:.02em;line-height:1.04;margin-top:4px}
.hd-date{font-size:${t.meta}px;color:${c.muted};font-weight:500;letter-spacing:.08em;
  text-transform:uppercase;margin-top:3px}
.hd{padding-bottom:6px;border-bottom:1px solid ${c.border}}
.closed-chip{display:inline-block;margin-left:6px;font-size:${t.meta - 1}px;font-weight:700;
  letter-spacing:.08em;color:${c.background};background:${c.warning};border-radius:3px;
  padding:1px 6px;vertical-align:middle}

/* sections */
.sec{margin-top:4px}
.sec-h{display:flex;align-items:center;gap:4px;font-size:${t.section}px;font-weight:700;
  letter-spacing:.12em;text-transform:uppercase;color:${c.text};margin-bottom:2px}
.sec-h .ico{font-size:${t.section}px;line-height:1}
.sec-h::after{content:'';flex:1;height:1px;background:${c.border}}
.sec-note{font-size:${t.meta - 1}px;color:${c.muted};font-weight:500;letter-spacing:.06em;
  text-transform:uppercase;margin-top:1px}

/* cards */
.card{background:${c.card};border:1px solid ${c.border};border-radius:${theme.radius}px;
  padding:6px 8px}
.card+.card{margin-top:4px}
.grid{display:grid;gap:6px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:start}

/* market pulse */
.pulse{grid-template-columns:repeat(3,1fr)}
.pulse .k{font-size:${t.meta - 1}px;color:${c.muted};font-weight:600;letter-spacing:.08em;
  text-transform:uppercase}
.pulse .v{font-size:15px;font-weight:700;margin-top:1px;font-variant-numeric:tabular-nums}
.pulse .d{font-size:${t.meta - 1}px;font-weight:600;margin-top:0;font-variant-numeric:tabular-nums}
.pulse .na{color:${c.muted};font-weight:600}
.up{color:${c.positive}}
.down{color:${c.negative}}
.flat{color:${c.muted}}

/* global cues */
.cues{grid-template-columns:repeat(3,1fr);gap:6px}
.cue{background:${c.surface};border:1px solid ${c.border};border-radius:8px;padding:6px 8px}
.cue .k{font-size:${t.meta - 1}px;color:${c.muted};font-weight:600;letter-spacing:.06em;
  text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cue .v{font-size:${t.body + 1}px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cue .d{font-size:${t.meta - 1}px;font-weight:650;font-variant-numeric:tabular-nums}
.cue-group{font-size:${t.meta - 1}px;color:${c.accent};font-weight:700;letter-spacing:.1em;
  text-transform:uppercase;margin:0 0 4px}

/* compact global cues grid — 3 cols, very tight */
.cue-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin-top:1px}
.cue-mini{display:flex;flex-direction:column;gap:0px;background:${c.surface};border:1px solid ${c.border};
  border-radius:4px;padding:2px 4px;font-size:${t.meta - 3}px;line-height:1.1}
.cue-mini .cue-name{color:${c.muted};font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cue-mini .cue-val{font-size:${t.body - 2}px;font-weight:650;font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cue-mini .cue-delta{font-size:${t.meta - 3}px;font-weight:700;font-variant-numeric:tabular-nums}

/* news items */
.story{background:${c.card};border:1px solid ${c.border};border-radius:${theme.radius}px;
  padding:5px 7px 4px;position:relative}
.story+.story{margin-top:4px}
.story .top{display:flex;align-items:baseline;gap:4px;font-size:${t.meta - 2}px;
  color:${c.muted};font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  flex-wrap:nowrap;overflow:hidden}
.story .top .impact{font-size:${t.meta - 2}px}
.story .rank{color:${c.accent};font-weight:800}
.story .cat{color:${c.accent};font-weight:700}
.story .upd{color:${c.warning};font-weight:800}
.story h3{font-size:${t.headline - 1}px;font-weight:650;line-height:1.12;margin-top:1px;
  display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.story .sum{font-size:${t.body}px;color:${c.text};opacity:.92;line-height:1.25;margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.story .why{font-size:${t.meta - 1}px;color:${c.muted};line-height:1.2;margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.story .why b{color:${c.accent};font-weight:700;letter-spacing:.06em}
.story .src{display:flex;justify-content:space-between;align-items:center;gap:5px;
  font-size:${t.meta - 2}px;color:${c.muted};margin-top:3px;letter-spacing:.03em}
.story .src a{color:${c.muted};text-decoration:none;border-bottom:1px dotted ${c.borderStrong}}
.badge{font-size:${t.meta - 2}px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  padding:1px 4px;border-radius:3px;white-space:nowrap}
.b-confirmed{background:rgba(34,197,94,.16);color:${c.positive}}
.b-reported{background:rgba(76,141,255,.16);color:${c.accent}}
.b-awaiting{background:rgba(245,158,11,.16);color:${c.warning}}
.b-unconfirmed{background:rgba(239,68,68,.14);color:${c.negative}}
.impact{font-size:${t.meta - 1}px;font-weight:800;letter-spacing:.08em;padding:1px 6px;
  border-radius:4px;text-transform:uppercase}
.i-positive{background:rgba(34,197,94,.16);color:${c.positive}}
.i-negative{background:rgba(239,68,68,.16);color:${c.negative}}
.i-mixed{background:rgba(245,158,11,.16);color:${c.warning}}
.i-neutral,.i-unclear{background:rgba(148,163,184,.16);color:${c.muted}}

/* list rows (stocks / sectors / gainers …) */
.row{display:flex;align-items:baseline;gap:5px;padding:3px 0;font-size:${t.body - 1}px;
  border-bottom:1px solid ${c.border}}
.row:last-child{border-bottom:none}
.row .sym{font-weight:700;letter-spacing:.04em;white-space:nowrap}
.row .why{color:${c.muted};font-size:${t.meta - 1}px;line-height:1.2;
  display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.row .num{margin-left:auto;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;
  font-size:${t.body - 2}px}
.chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:3px}
.chip{background:${c.surface};border:1px solid ${c.border};border-radius:5px;
  padding:2px 6px;font-size:${t.meta - 2}px;font-weight:600;color:${c.text};letter-spacing:.04em}
.chip .sub{color:${c.muted};font-weight:500}

/* two-column catalyst / risk lists */
.two{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.bul{font-size:${t.meta - 1}px;color:${c.text};line-height:1.25;padding:1px 0 1px 9px;
  position:relative}
.bul::before{content:'';position:absolute;left:0;top:6px;width:4px;height:4px;border-radius:50%;
  background:${c.accent}}
.risks .bul::before{background:${c.warning}}
.bul b{font-weight:700;letter-spacing:.04em}

/* view */
.view{background:linear-gradient(180deg,rgba(76,141,255,.10),rgba(76,141,255,.03));
  border:1px solid rgba(76,141,255,.35);border-left:3px solid ${c.accent};
  border-radius:${theme.radius}px;padding:3px 6px;font-size:${t.body - 2}px;line-height:1.25}
.view .lbl{font-size:${t.meta - 2}px;font-weight:800;letter-spacing:.1em;color:${c.accent};
  text-transform:uppercase;display:block;margin-bottom:0}

/* footer */
.ft{margin-top:4px;padding-top:3px;border-top:1px solid ${c.border}}
.ft .line1{display:flex;justify-content:space-between;align-items:baseline;gap:4px}
.ft .bname{font-size:${t.body - 2}px;font-weight:800;letter-spacing:.1em}
.ft .btag{font-size:${t.meta - 2}px;color:${c.muted};letter-spacing:.06em}
.ft .meta{font-size:${t.meta - 2}px;color:${c.muted};margin-top:1px;line-height:1.3}
.ft .meta b{color:${c.text};font-weight:600}
.ft .disc{color:${c.warning};font-weight:600}
.sample{display:inline-block;background:${c.warning};color:${c.background};font-weight:800;
  font-size:${t.meta - 2}px;letter-spacing:.08em;padding:1px 4px;border-radius:3px;
  margin-bottom:2px}

/* alert template specifics */
.al-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.al-kicker{font-size:${t.section}px;font-weight:800;letter-spacing:.16em;color:${c.negative};
  text-transform:uppercase}
.al-cat{display:inline-block;background:${c.card};border:1px solid ${c.borderStrong};
  border-radius:6px;padding:3px 9px;font-size:${t.meta}px;font-weight:700;letter-spacing:.1em;
  color:${c.accent};text-transform:uppercase}
.al-headline{font-size:${Math.min(t.title, 26)}px;font-weight:700;line-height:1.2;margin-top:10px}
.al-sum{font-size:${t.body + 2}px;line-height:1.5;margin-top:8px;color:${c.text};opacity:.94}
.lbl-mini{font-size:${t.meta}px;font-weight:800;letter-spacing:.14em;color:${c.accent};
  text-transform:uppercase;margin-top:10px}

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
.pdf .story{background:${c.surface};border:1px solid ${c.border};border-radius:6pt;
  padding:7pt 9pt;margin-bottom:7pt;page-break-inside:avoid}
.pdf .view{font-size:10.5pt;margin-top:8pt}
.pdf .ft{margin-top:auto;border-top:1px solid ${c.border};padding-top:6pt;font-size:8.5pt;
  color:${c.muted}}
.pdf .cols{gap:10mm}
`;
}
