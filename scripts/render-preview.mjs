/**
 * Preview / local render command (§31):
 *
 *   npm run render:premarket   → artifacts/preview/premarket*.png (+ .pdf)
 *   npm run render:closing     → artifacts/preview/closing*.png
 *   npm run render:alert       → artifacts/preview/alert.png
 *   node scripts/render-preview.mjs premarket --sample --json
 *
 * Flags:
 *   --sample   force the labelled fixtures (PART 31) instead of live data
 *   --quiet    the PART 32 edge case: previous session without any overnight
 *   --json     machine-readable output (includes the whole briefing contract)
 *
 * Data order: live store/inbox first, fixtures only when asked or empty.
 * Sample data is never used by the production pipeline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store/index.js';
import { createProviders } from '../src/providers/index.js';
import { runProviders } from '../src/providers/base.js';
import { buildVisualBriefing, buildAlertBriefing } from '../src/visual/data.js';
import {
  buildPagePlan,
  renderAlertHtml,
  renderPdfHtml,
} from '../src/visual/templates.js';
import {
  renderPlanPages,
  renderFittedPng,
  renderPdf,
  validateImage,
  validatePdf,
} from '../src/visual/render.js';
import { visualDimensions, VISUAL_DEFAULTS } from '../src/visual/theme.js';
import { VisualDeliver } from '../src/visual/deliver.js';
import { sampleData, quietOvernightSample, SAMPLE_NOW } from './sample-visual-data.mjs';

const PREVIEW_DIR = path.join(process.cwd(), 'artifacts', 'preview');

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const type = (positional[0] ?? 'premarket').toLowerCase();
  if (!['premarket', 'closing', 'alert'].includes(type)) {
    console.error(`Unknown type "${type}" — use premarket | closing | alert`);
    process.exit(2);
  }
  return {
    type,
    json: argv.includes('--json'),
    forceSample: argv.includes('--sample'),
    quiet: argv.includes('--quiet'),
  };
}

/** Latest data from the local store/providers; falls back to labelled fixtures. */
async function collectData({ type, forceSample, quiet }) {
  const cfg = loadConfig();
  let snapshots = [];
  let events = [];

  if (!forceSample) {
    try {
      const providers = createProviders({
        settings: cfg.settings,
        feeds: cfg.feeds,
        officialSources: cfg.officialSources,
        categorizer: null,
        extractor: null,
      });
      const briefingProviders = providers.filter((p) => ['market', 'global'].includes(p.kind));
      const collected = await runProviders(briefingProviders, { mode: type, now: new Date() }, null);
      snapshots = collected.items.filter((i) => i?.kind === 'snapshot').map((i) => i.snapshot ?? i);
    } catch {
      snapshots = [];
    }

    try {
      const store = openStore({ driver: 'sqlite', dbPath: cfg.settings.paths.db });
      const lookback = type === 'alert' ? 72 : 96;
      const since = new Date(Date.now() - lookback * 3600 * 1000).toISOString();
      events = store.listRecentEvents(since, 150);
      store.close?.();
    } catch {
      events = [];
    }
  }

  if (forceSample || (!snapshots.length && !events.length)) {
    const fixture = quiet ? quietOvernightSample() : sampleData();
    // A closing report is published just after the bell. Stamping one with the
    // pre-market clock (08:30 IST) makes the preview read like a wrong date —
    // only the preview clock moves; the fixture's data is unchanged.
    const now =
      type === 'closing'
        ? new Date(
            Date.UTC(
              fixture.now.getUTCFullYear(),
              fixture.now.getUTCMonth(),
              fixture.now.getUTCDate(),
              10,
              15,
              0
            )
          )
        : fixture.now;
    return { cfg, snapshots: fixture.snapshots, events: fixture.events, usingSample: true, now };
  }

  return { cfg, snapshots, events, usingSample: false, now: new Date() };
}

async function main() {
  const { type, json, forceSample, quiet } = parseArgs(process.argv.slice(2));
  const { cfg, snapshots, events, usingSample, now } = await collectData({ type, forceSample, quiet });
  const dims = visualDimensions(process.env, type);

  let brief;
  let html = null;
  let pdfHtml = null;
  const pages = [];

  if (type === 'alert') {
    const source =
      events.find((e) => e.importance_level === 'HIGH') ?? events[0] ?? sampleData().events[0];
    brief = buildAlertBriefing({ event: source, verdict: source?.ai_verdict ?? {}, now, sample: usingSample });
    // Same content-fitted sizing the production deliverer uses — the preview
    // must not promise a height the real alert will not print.
    const fitted = await renderFittedPng({
      renderHtml: (d) => renderAlertHtml(brief, d),
      dims,
      min: VISUAL_DEFAULTS.alertMinHeight,
      max: dims.height,
      pageStep: VISUAL_DEFAULTS.pageStep,
    });
    html = fitted.html;
    pages.push({
      buffer: fitted.buffer,
      width: fitted.width,
      height: fitted.height,
      html,
      path: path.join(PREVIEW_DIR, 'alert.png'),
      ms: fitted.ms,
    });
  } else {
    brief = buildVisualBriefing({
      type,
      snapshots,
      events,
      now,
      holidays: cfg.holidays ?? [],
      marketHours: cfg.settings?.marketHours ?? {},
      sample: usingSample,
      imageCap: 3,
    });
    pdfHtml = renderPdfHtml(brief, { type });

    let plan = buildPagePlan(brief, { type, now });
    const rendered = await renderPlanPages({
      plan,
      dims,
      replan: (cap) => {
        brief = buildVisualBriefing({
          type,
          snapshots,
          events,
          now,
          holidays: cfg.holidays ?? [],
          marketHours: cfg.settings?.marketHours ?? {},
          sample: usingSample,
          imageCap: cap,
        });
        plan = buildPagePlan(brief, { type, now });
        return plan;
      },
    });
    for (const p of rendered.pages) {
      const suffix = rendered.pages.length > 1 ? `-p${p.index + 1}` : '';
      // The quiet-edge-case run gets its own file names so it cannot clobber
      // the standard preview set (and vice versa).
      const tag = quiet ? '-quiet' : '';
      pages.push({
        buffer: p.buffer,
        width: p.width,
        height: p.height,
        html: p.html,
        path: path.join(PREVIEW_DIR, `${type}${tag}${suffix}.png`),
        content: p.content,
      });
    }
  }

  // The exact caption production would attach to page 1.
  const deliver = new VisualDeliver({ transport: null, env: {} });
  const caption =
    type === 'alert'
      ? deliver.buildAlertCaption()
      : deliver.buildCaption(brief, type, { page: 1, pageCount: pages.length });

  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  const pngEntries = [];
  for (const p of pages) {
    fs.writeFileSync(p.path, p.buffer);
    const qa = validateImage({
      buffer: p.buffer,
      width: p.width,
      height: p.height,
      html: p.html,
      brief,
    });
    pngEntries.push({ path: p.path, bytes: p.buffer.length, width: p.width, height: p.height, qa });
  }

  const out = {
    type,
    data_source: usingSample ? 'SAMPLE/TEST DATA' : 'live store/inbox',
    sample: usingSample,
    now: now.toISOString(),
    expected_sample_now: usingSample ? SAMPLE_NOW.toISOString() : null,
    caption,
    pages: pngEntries,
    pdf: null,
  };

  if (pdfHtml) {
    const pdf = await renderPdf({ html: pdfHtml });
    const pdfPath = path.join(PREVIEW_DIR, `${type}${quiet ? '-quiet' : ''}.pdf`);
    fs.writeFileSync(pdfPath, pdf.buffer);
    out.pdf = { path: pdfPath, bytes: pdf.buffer.length, ms: pdf.ms, qa: validatePdf({ buffer: pdf.buffer }) };
  }

  if (json) {
    console.log(JSON.stringify({ ...out, briefing: brief }, null, 2));
  } else {
    console.log(`${type.toUpperCase()} preview (${out.data_source}${quiet ? ', quiet overnight' : ''})`);
    for (const p of pngEntries) {
      console.log(
        `  PNG  ${p.path}  ${p.width}×${p.height}  ${p.bytes} bytes  QA:${
          p.qa.ok ? 'PASS' : 'FAIL ' + p.qa.problems.join('; ')
        }`
      );
    }
    if (out.pdf) {
      console.log(
        `  PDF  ${out.pdf.path}  ${out.pdf.bytes} bytes  QA:${
          out.pdf.qa.ok ? 'PASS' : 'FAIL ' + out.pdf.qa.problems.join('; ')
        }`
      );
    }
    console.log(
      `  developments=${brief.top_developments?.length ?? 0} keep_an_eye=${brief.keep_an_eye?.length ?? 0}` +
        ` stocks=${brief.stocks_to_watch?.length ?? 0} sectors=${brief.sectors_to_watch?.length ?? 0}` +
        ` global_groups=${brief.global?.length ?? 0} driver=${brief.driver ? 'yes' : 'no'}`
    );
    console.log(`  windows=${JSON.stringify(brief.windows ?? {})}`);
    console.log(`  caption: ${caption.replace(/\n/g, ' | ')}`);
  }

  if (pngEntries.some((p) => !p.qa.ok)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('render-preview failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
