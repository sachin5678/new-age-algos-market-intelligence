/**
 * Technical chart renderer — deterministic SVG from OHLC candles.
 *
 * The SVG is embedded directly in the scene HTML and rasterized by the
 * existing headless-Chrome renderer, so charts share the exact theme
 * (§27: colors come from theme only) and need no chart library, no
 * network, and no AI image generation.
 */

import { theme } from '../visual/theme.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Safe fixed-point for anything that reaches visible text (QA bans NaN). */
const fmt = (v, d = 2) => (isNum(v) ? v.toFixed(d) : '—');

/**
 * Candlestick chart.
 * @param {object} args
 * @param {Array<{o,h,l,c}>} args.candles
 * @param {number} [args.width]  logical px (scene space)
 * @param {number} [args.height]
 * @returns {string} inline <svg> markup
 */
export function candleChartSvg({ candles, width = 488, height = 190 } = {}) {
  const data = (Array.isArray(candles) ? candles : []).filter(
    (k) => k && isNum(k.o) && isNum(k.h) && isNum(k.l) && isNum(k.c)
  );
  if (data.length < 2) return '';

  const c = theme.colors;
  const padL = 4;
  const padR = 54; // price label gutter
  const padT = 8;
  const padB = 8;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  let min = Infinity;
  let max = -Infinity;
  for (const k of data) {
    if (k.l < min) min = k.l;
    if (k.h > max) max = k.h;
  }
  if (!(max > min)) {
    max = min + 1;
  }
  const span = max - min;
  const y = (v) => padT + ((max - v) / span) * plotH;

  const slot = plotW / data.length;
  const bodyW = Math.max(1.5, Math.min(slot * 0.62, 14));
  const last = data[data.length - 1];
  const lastUp = last.c >= last.o;

  const parts = [];
  // frame + grid
  parts.push(
    `<rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="${c.card}" stroke="${c.border}"/>`
  );
  for (const frac of [0.25, 0.5, 0.75]) {
    const gy = padT + plotH * frac;
    parts.push(
      `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${c.border}" stroke-dasharray="3 5"/>`
    );
  }

  // candles
  data.forEach((k, i) => {
    const cx = padL + slot * i + slot / 2;
    const up = k.c >= k.o;
    const color = up ? c.positive : c.negative;
    const yH = y(k.h);
    const yL = y(k.l);
    const yO = y(k.o);
    const yC = y(k.c);
    const top = Math.min(yO, yC);
    const h = Math.max(1.2, Math.abs(yC - yO));
    parts.push(
      `<line x1="${cx.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${color}" stroke-width="1.2"/>`
    );
    parts.push(
      `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="1"/>`
    );
  });

  // last-close marker + price label
  const yLast = y(last.c);
  parts.push(
    `<line x1="${padL}" y1="${yLast.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${yLast.toFixed(1)}" stroke="${c.accent}" stroke-width="1" stroke-dasharray="5 4" opacity="0.85"/>`
  );
  parts.push(
    `<rect x="${(padL + plotW + 4).toFixed(1)}" y="${(yLast - 9).toFixed(1)}" width="46" height="18" rx="4" fill="${c.accent}"/>`
  );
  parts.push(
    `<text x="${(padL + plotW + 27).toFixed(1)}" y="${(yLast + 4).toFixed(1)}" font-family="Arial" font-size="11" font-weight="700" fill="${c.background}" text-anchor="middle">${fmt(last.c, last.c >= 1000 ? 0 : 2)}</text>`
  );

  // high / low labels
  parts.push(
    `<text x="${padL + 4}" y="${padT + 10}" font-family="Arial" font-size="10" fill="${c.muted}">H ${fmt(max, max >= 1000 ? 0 : 2)}</text>`
  );
  parts.push(
    `<text x="${padL + 4}" y="${height - padB - 3}" font-family="Arial" font-size="10" fill="${c.muted}">L ${fmt(min, min >= 1000 ? 0 : 2)}</text>`
  );
  // period caption
  parts.push(
    `<text x="${(padL + plotW).toFixed(1)}" y="${height - padB - 3}" font-family="Arial" font-size="10" fill="${c.muted}" text-anchor="end">${data.length} sessions</text>`
  );

  return `<svg class="sh-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}
