/** Smoke test: renderer + QA on minimal and real-template HTML. */
import fs from 'node:fs';
import { renderPng, renderPdf, pngDimensions, validateImage, validatePdf } from '../src/visual/render.js';
import { baseCss } from '../src/visual/theme.js';

const html =
  '<!doctype html><html><body style="margin:0"><div class="poster" style="width:540px;height:675px;background:#0B1220;color:#fff">hello</div></body></html>';

const png = await renderPng({ html, width: 1080, height: 1350 });
console.log('PNG:', png.buffer.length, 'bytes', JSON.stringify(pngDimensions(png.buffer)), png.ms + 'ms');
fs.writeFileSync('artifacts-smoke.png', png.buffer);
console.log('QA:', JSON.stringify(validateImage({ buffer: png.buffer, width: 1080, height: 1350, html })));

const css = baseCss({ vw: 540, vh: 675, scale: 1 });
const pdfHtml =
  `<!doctype html><html><head><style>${css}</style></head><body class="pdf">` +
  '<section class="page"><h1>1</h1></section>'.repeat(4) +
  '</body></html>';
const pdf = await renderPdf({ html: pdfHtml });
console.log('PDF:', pdf.buffer.length, 'bytes', pdf.ms + 'ms', JSON.stringify(validatePdf({ buffer: pdf.buffer })));
