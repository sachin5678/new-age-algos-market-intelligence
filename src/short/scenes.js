/**
 * Scene renderer — Market → Short factory stage 4.
 *
 * Builds the HTML for each 1080×1920 (9:16) scene using the central theme +
 * baseCss (§27: no hard-coded colors/fonts — everything comes from theme).
 *
 * Scene kinds:
 *   hook  — category + impact chips, big headline
 *   fact  — numbered badge, the fact in large type
 *   why   — "WHY IT MATTERS" label, market relevance
 *   cta   — brand, handle, subscribe pill
 *
 * Layout: logical 540×960 viewport at scale 2 → 1080×1920 output. The bottom
 * ~330 logical px are reserved for the burned-in caption band (captions sit
 * at 30% from the bottom), so no scene element may enter that zone — the
 * poster's padding-bottom enforces it.
 */

import { theme, baseCss, esc, VISUAL_DEFAULTS } from '../visual/theme.js';

export const SHORT_DIMS = Object.freeze({ width: 1080, height: 1920, scale: 2 });

const IMPACT_LABEL = {
  positive: 'POSITIVE',
  negative: 'NEGATIVE',
  mixed: 'MIXED',
  neutral: 'NEUTRAL',
  unclear: 'DEVELOPING',
};

/** Scene-specific layout CSS (appended after baseCss, so it wins on cascade). */
export function shortCss() {
  const c = theme.colors;
  const t = theme.type;

  return `
.poster{padding:26px 26px 330px}
.sh{display:flex;flex-direction:column;flex:1}
.sh-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sh-kicker{font-size:${t.meta - 1}px;font-weight:800;letter-spacing:.18em;
  color:${c.accent};text-transform:uppercase}
.sh-rule{height:3px;margin-top:10px;border-radius:3px;
  background:linear-gradient(90deg,${c.accent},rgba(76,141,255,0))}
.sh-body{display:flex;flex-direction:column;justify-content:center;gap:14px;
  flex:1;margin-top:24px}
.sh-body .sample{align-self:flex-start}
.sh-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.sh-cat{display:inline-block;background:${c.card};border:1px solid ${c.borderStrong};
  border-radius:8px;padding:5px 12px;font-size:${t.meta + 2}px;font-weight:800;
  letter-spacing:.12em;color:${c.accent};text-transform:uppercase}
.sh-badge{display:inline-flex;align-items:center;gap:8px;
  background:linear-gradient(135deg,${c.accent},rgba(76,141,255,.55));
  color:${c.text};border-radius:8px;padding:5px 14px;font-size:${t.meta + 3}px;
  font-weight:800;letter-spacing:.14em;text-transform:uppercase}
.sh-label{font-size:${t.section + 3}px;font-weight:800;letter-spacing:.22em;
  color:${c.warning};text-transform:uppercase}
.sh-text{font-weight:800;line-height:1.16;letter-spacing:.005em;color:${c.text};
  text-wrap:balance}
.sh-hook{font-size:40px}
.sh-fact{font-size:31px;font-weight:750}
.sh-why{font-size:28px;font-weight:700;line-height:1.3}
.sh-foot{margin-top:auto;padding-top:14px}
.sh-foot-row{display:flex;align-items:center;justify-content:space-between;gap:8px;
  margin-top:10px}
.sh-handle{font-size:${t.body + 3}px;font-weight:800;letter-spacing:.1em;color:${c.text}}
.sh-meta{font-size:${t.meta}px;font-weight:600;letter-spacing:.1em;color:${c.muted};
  text-transform:uppercase}
.sh-src{font-size:${t.meta - 1}px;font-weight:600;color:${c.muted};margin-top:6px;
  letter-spacing:.04em}
.sh-quote{display:block;width:44px;height:6px;border-radius:3px;background:${c.accent};
  margin-bottom:16px}

/* CTA scene */
.sh-cta{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;
  gap:18px;flex:1;margin-top:20px}
.sh-cta .big{font-size:52px;font-weight:800;letter-spacing:.06em;line-height:1.06;
  color:${c.text}}
.sh-cta .tag{font-size:${t.body + 5}px;font-weight:600;color:${c.muted};
  letter-spacing:.08em}
.sh-cta .pill{display:inline-flex;align-items:center;gap:10px;margin-top:10px;
  background:${c.accent};color:${c.background};border-radius:12px;
  padding:14px 26px;font-size:${t.headline + 5}px;font-weight:800;letter-spacing:.14em;
  text-transform:uppercase}
.sh-cta .handle{font-size:${t.headline + 2}px;font-weight:700;color:${c.text};
  letter-spacing:.06em;margin-top:6px}
`;
}

function header(meta) {
  return `
<div class="sh-top">
  <span class="brand"><span class="bolt">⚡</span>${esc(theme.brand.name)}</span>
  <span class="sh-kicker">SHORTS</span>
</div>
<div class="sh-rule"></div>`;
}

function footer(meta) {
  const date = meta.date ?? '';
  return `
<div class="sh-foot">
  <div class="sh-foot-row">
    <span class="sh-handle">${esc(meta.handle ?? '@newageAlgos')}</span>
    <span class="sh-meta">${esc(date)}</span>
  </div>
  ${meta.source ? `<div class="sh-src">Source: ${esc(meta.source)}</div>` : ''}
</div>`;
}

function body(scene, meta) {
  if (scene.kind === 'hook') {
    const impact = IMPACT_LABEL[meta.impact] ? meta.impact : 'unclear';
    const chips = [
      meta.category ? `<span class="sh-cat">${esc(meta.category)}</span>` : '',
      `<span class="impact i-${impact}">${IMPACT_LABEL[impact]}</span>`,
    ]
      .filter(Boolean)
      .join('');
    return `
<div class="sh-body">
  <div class="sh-chips">${chips}</div>
  <div class="sh-text sh-hook">${esc(scene.text)}</div>
  ${meta.sample ? '<span class="sample">SAMPLE / TEST DATA</span>' : ''}
</div>`;
  }

  if (scene.kind === 'fact') {
    return `
<div class="sh-body">
  <span class="sh-badge">FACT ${scene.n} / ${scene.of}</span>
  <div class="sh-text sh-fact">${esc(scene.text)}</div>
</div>`;
  }

  if (scene.kind === 'why') {
    return `
<div class="sh-body">
  <span class="sh-quote"></span>
  <span class="sh-label">Why it matters</span>
  <div class="sh-text sh-why">${esc(scene.text)}</div>
</div>`;
  }

  // cta
  return `
<div class="sh-cta">
  <div class="big">${esc(theme.brand.name)}</div>
  <div class="tag">${esc(theme.brand.tagline)}</div>
  <span class="pill">Subscribe</span>
  <div class="handle">${esc(scene.text || meta.handle || '@newageAlgos')}</div>
</div>`;
}

/**
 * Full HTML document for one scene.
 * @param {{kind: string, text: string}} scene
 * @param {object} meta — category, impact, date, source, handle, sample
 */
export function renderSceneHtml(scene, meta = {}, dims = SHORT_DIMS) {
  const scale = dims.scale ?? VISUAL_DEFAULTS.scale;
  const vw = Math.round(dims.width / scale);
  const vh = Math.round(dims.height / scale);
  const css = baseCss({ vw, vh }) + shortCss();
  const poster = `<div class="poster" style="width:${vw}px;min-height:${vh}px">
<div class="sh">
  ${header(meta)}
  ${body(scene, meta)}
  ${footer(meta)}
</div>
</div>`;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${css}</style></head><body>${poster}</body></html>`
  );
}
