/**
 * Preview / local render command (§31):
 *
 *   npm run render:premarket   → artifacts/preview/premarket.png + .pdf
 *   npm run render:closing     → artifacts/preview/closing.png + .pdf
 *   npm run render:alert       → artifacts/preview/alert.png
 *   node scripts/render-preview.mjs premarket --json
 *
 * Uses the latest available data: real store events + inbox snapshots when
 * present, otherwise clearly-labelled SAMPLE/TEST fixtures (§32) — sample
 * data is never used by the production pipeline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store/index.js';
import { createProviders } from '../src/providers/index.js';
import { runProviders } from '../src/providers/base.js';
import {
  buildVisualBriefing,
  buildAlertBriefing,
} from '../src/visual/data.js';
import {
  renderPreMarketHtml,
  renderClosingHtml,
  renderAlertHtml,
  renderPdfHtml,
} from '../src/visual/templates.js';
import {
  renderPng,
  renderPdf,
  validateImage,
  validatePdf,
} from '../src/visual/render.js';
import { VisualDeliver } from '../src/visual/deliver.js';
import { sampleData } from './sample-visual-data.mjs';

const PREVIEW_DIR = path.join(process.cwd(), 'artifacts', 'preview');

function parseType(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const type = (positional[0] ?? 'premarket').toLowerCase();
  if (!['premarket', 'closing', 'alert'].includes(type)) {
    console.error(`Unknown type "${type}" — use premarket | closing | alert`);
    process.exit(2);
  }
  return { type, json: argv.includes('--json') };
}

/** Latest data from the local store/providers; falls back to labelled fixtures. */
async function collectData(type) {
  const cfg = loadConfig();
  const sample = sampleData();
  let snapshots = [];
  let events = [];
  let usingSample = false;

  try {
    const providers = createProviders({ settings: cfg.settings, feeds: cfg.feeds, officialSources: cfg.officialSources, categorizer: null, extractor: null });
    const briefingProviders = providers.filter((p) => ['market', 'global'].includes(p.kind));
    const collected = await runProviders(briefingProviders, { mode: type, now: new Date() }, null);
    snapshots = collected.items.filter((i) => i?.kind === 'snapshot').map((i) => i.snapshot ?? i);
  } catch {
    snapshots = [];
  }

  try {
    const store = openStore({ driver: 'sqlite', dbPath: cfg.settings.paths.db });
    const lookback = type === 'alert' ? 72 : 48;
    const since = new Date(Date.now() - lookback * 3600 * 1000).toISOString();
    events = store.listRecentEvents(since, 40);
    store.close?.();
  } catch {
    events = [];
  }

  if (!snapshots.length && !events.length) {
    usingSample = true;
    snapshots = sample.snapshots;
    events = sample.events;
  }

  return { cfg, snapshots, events, usingSample };
}

async function main() {
  const { type, json } = parseType(process.argv.slice(2));
  const { cfg, snapshots, events, usingSample } = await collectData(type);
  const now = new Date();
  const dims = { width: undefined, height: undefined, scale: undefined }; // theme defaults

  let brief;
  let html;
  let pdfHtml = null;

  if (type === 'alert') {
    const source =
      events.find((e) => e.importance_level === 'HIGH') ?? events[0] ?? sampleData().events[0];
    brief = buildAlertBriefing({ event: source, verdict: source?.ai_verdict ?? {}, now, sample: usingSample });
    html = renderAlertHtml(brief, dims);
  } else {
    brief = buildVisualBriefing({
      type,
      snapshots,
      events,
      now,
      holidays: cfg.holidays ?? [],
      marketHours: cfg.settings?.marketHours ?? {},
      sample: usingSample,
    });
    html = type === 'closing' ? renderClosingHtml(brief, dims) : renderPreMarketHtml(brief, dims);
    pdfHtml = renderPdfHtml(brief, { type });
  }

  const width = type === 'alert' ? 1080 : 1080;
  const height = type === 'alert' ? 1080 : 1350;

  // The exact one-line caption production would attach to this image.
  const caption = new VisualDeliver({ transport: null, env: {} })[
    type === 'alert' ? 'buildAlertCaption' : 'buildCaption'
  ](brief, type);

  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const png = await renderPng({ html, width, height, scale: 2 });
  const pngPath = path.join(PREVIEW_DIR, `${type}.png`);
  fs.writeFileSync(pngPath, png.buffer);
  const qa = validateImage({ buffer: png.buffer, width, height, html, brief });

  const out = {
    type,
    data_source: usingSample ? 'SAMPLE/TEST DATA' : 'live store/inbox',
    sample: usingSample,
    caption,
    png: { path: pngPath, bytes: png.buffer.length, ms: png.ms, qa },
    pdf: null,
  };

  if (pdfHtml) {
    const pdf = await renderPdf({ html: pdfHtml });
    const pdfPath = path.join(PREVIEW_DIR, `${type}.pdf`);
    fs.writeFileSync(pdfPath, pdf.buffer);
    out.pdf = { path: pdfPath, bytes: pdf.buffer.length, ms: pdf.ms, qa: validatePdf({ buffer: pdf.buffer }) };
  }

  if (json) {
    console.log(JSON.stringify({ ...out, briefing: brief }, null, 2));
  } else {
    console.log(`${type.toUpperCase()} preview (${out.data_source})`);
    console.log(`  PNG  ${pngPath}  ${png.buffer.length} bytes  ${png.ms}ms  QA:${qa.ok ? 'PASS' : 'FAIL ' + qa.problems.join('; ')}`);
    if (out.pdf) {
      console.log(`  PDF  ${out.pdf.path}  ${out.pdf.bytes} bytes  ${out.pdf.ms}ms  QA:${out.pdf.qa.ok ? 'PASS' : 'FAIL ' + out.pdf.qa.problems.join('; ')}`);
    }
    console.log(`  developments=${brief.top_developments?.length ?? 0} stocks=${brief.stocks_to_watch?.length ?? brief.stocks?.length ?? 0} sectors=${brief.sectors_to_watch?.length ?? 0} global_groups=${brief.global?.length ?? 0}`);
    console.log(`  caption: ${caption}`);
  }

  if (!qa.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('render-preview failed:', err.message);
    process.exit(1);
  });
}
