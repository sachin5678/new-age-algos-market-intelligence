/** Diagnostic: per-section rendered heights (logical px) via headless Chrome. */
import { loadConfig } from '../src/config.js';
import { buildVisualBriefing, buildAlertBriefing } from '../src/visual/data.js';
import { renderPreMarketHtml, renderClosingHtml, renderAlertHtml } from '../src/visual/templates.js';
import { sampleData } from './sample-visual-data.mjs';

const type = process.argv[2] ?? 'premarket';
const cfg = loadConfig();
const sample = sampleData();
const now = new Date();

let brief;
let html;
if (type === 'alert') {
  brief = buildAlertBriefing({ event: sample.events[0], verdict: sample.events[0].ai_verdict, now, sample: true });
  html = renderAlertHtml(brief, {});
} else {
  brief = buildVisualBriefing({
    type,
    snapshots: sample.snapshots,
    events: sample.events,
    now,
    holidays: cfg.holidays,
    marketHours: cfg.settings.marketHours,
    sample: true,
  });
  html = type === 'closing' ? renderClosingHtml(brief, {}) : renderPreMarketHtml(brief, {});
}

const { findBrowser } = await import('../src/visual/render.js');
const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({ executablePath: findBrowser(process.env), headless: true });
const page = await browser.newPage();
const dims = type === 'alert' ? { w: 540, h: 540 } : { w: 540, h: 675 };
await page.setViewport({ width: dims.w, height: dims.h, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts?.ready);

const report = await page.evaluate(() => {
  const poster = document.querySelector('.poster');
  const kids = [...poster.children];
  return {
    posterHeight: poster.scrollHeight,
    children: kids.map((el) => ({
      tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
      sec: el.dataset?.sec ?? el.className ?? '',
      h: Math.round(el.getBoundingClientRect().height),
      secH: [...(el.querySelectorAll?.(':scope > .sec, :scope > div > .sec') ?? [])].map(
        (s) => `${s.dataset.sec ?? '?'}:${Math.round(s.getBoundingClientRect().height)}`
      ),
    })),
  };
});
console.log(JSON.stringify(report, null, 1));
console.log(`\nBUDGET: ${dims.h}px | POSTER: ${report.posterHeight}px | OVER: ${report.posterHeight - dims.h}px`);
await browser.close();
