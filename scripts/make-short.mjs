#!/usr/bin/env node
/**
 * Market → Short factory CLI (free, local).
 *
 *   npm run short                    → newest store event → artifacts/shorts/run-<ts>/short.mp4
 *   npm run recap                    → today's market recap (top gainers/losers + charts)
 *   npm run short -- --lang hinglish → Hinglish voiceover (English visuals)
 *   npm run short -- --lang hindi    → Hindi voiceover (Devanagari captions)
 *   npm run short -- --event <id>    → a specific event
 *   npm run short -- --demo          → labelled SAMPLE data (no store/Yahoo needed)
 *   npm run short -- --ai            → force a fresh (free-tier) AI verdict
 *   npm run short -- --notify        → also send the MP4 to the Telegram
 *                                       content queue (needs bot env vars)
 *   npm run short -- --upload        → publish to YouTube (free Data API v3,
 *                                       one-time auth via youtube-auth.mjs)
 *   npm run short -- --upload-all    → publish every finished run not yet up
 *   npm run short -- --json          → machine-readable summary
 *
 * Flags: --type story|recap   --lang en|hinglish|hindi
 *        --voice <id>  --rate <+N%>  --out <dir>
 * Everything downstream of the data is deterministic and free:
 * Yahoo Finance (recap numbers, no key), Gemini free tier (optional
 * Hinglish rewrite), edge-tts (voice), headless Chrome (scenes), ffmpeg (video).
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadDotEnv, PROJECT_ROOT } from '../src/config.js';
import { marketCalendar } from '../src/visual/data.js';
import { openStore } from '../src/store/index.js';
import { createOpenAIService, fallbackVerdict } from '../src/ai/openaiService.js';
import { makeShort } from '../src/short/index.js';
import { demoRecap } from '../src/short/recap.js';
import { fetchMovers, fetchIndexPulse } from '../src/short/marketData.js';
import { normalizeLang } from '../src/short/lang.js';
import {
  uploadShort,
  uploadAllUnsent,
  loadRegistry,
  defaultRegistryFile,
} from '../src/youtube.js';

/** Labelled sample so the factory can be exercised without a live store. */
const DEMO_EVENT = {
  event_id: 'evt_demo_short',
  sample: true,
  title:
    'Nifty prediction today: Oversold conditions raise rebound chances; how RBI policy will impact',
  description:
    'Nifty 50 slipped below the rising trendline drawn from the swing lows of June 2024 and April 2025.',
  url: 'https://www.livemint.com/market/',
  source: 'Livemint',
  category: 'RBI',
  importance_level: 'HIGH',
  published_at: new Date().toISOString(),
  detected_at: new Date().toISOString(),
  ai_verdict: {
    event_type: 'market preview',
    headline: 'Nifty oversold ahead of RBI policy — rebound chances are rising',
    summary:
      'Nifty 50 is oversold and sitting below its rising trendline, while traders wait for the RBI policy decision.',
    facts: [
      'Nifty 50 slipped below the rising trendline from the June 2024 and April 2025 swing lows.',
      'Oversold conditions are raising the odds of a rebound from current levels.',
      'The RBI policy decision is the next big catalyst traders are watching.',
    ],
    market_relevance:
      'A rebound attempt into the RBI policy would keep the broad market range intact, while a breakdown would extend the correction.',
    impact: 'mixed',
  },
};

function parseFlags(argv) {
  const flags = {
    demo: false,
    ai: false,
    notify: false,
    json: false,
    upload: false,
    uploadAll: false,
    event: null,
    voice: null, // null → voice preset comes from --lang
    rate: '+6%',
    out: null,
    lang: 'en',
    type: 'story',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--demo') flags.demo = true;
    else if (a === '--ai') flags.ai = true;
    else if (a === '--notify') flags.notify = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--upload') flags.upload = true;
    else if (a === '--upload-all') flags.uploadAll = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--event') flags.event = argv[++i] ?? null;
    else if (a === '--voice') flags.voice = argv[++i] ?? null;
    else if (a === '--rate') flags.rate = argv[++i] ?? '+6%';
    else if (a === '--out') flags.out = argv[++i] ?? null;
    else if (a === '--lang') flags.lang = argv[++i] ?? 'en';
    else if (a === '--type') flags.type = argv[++i] ?? 'story';
    else if (!a.startsWith('--')) flags.event = a;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!['story', 'recap'].includes(flags.type)) {
    throw new Error(`unknown type "${flags.type}" — use story | recap`);
  }
  flags.lang = normalizeLang(flags.lang);
  return flags;
}

/** Live recap data: Yahoo Finance movers + index pulse + store news. */
async function liveRecap({ store }) {
  const [movers, pulse] = await Promise.all([fetchMovers({}), fetchIndexPulse({})]);
  if (!movers.gainers.length && !movers.losers.length) {
    throw new Error('no mover data from Yahoo Finance — try --demo');
  }
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const events = store.listRecentEvents(since, 120);
  console.log(
    `Recap data: ${movers.gainers.length} gainers, ${movers.losers.length} losers, ` +
      `${pulse.length} indices, ${events.length} news events (failed quotes: ${movers.failed})`
  );
  return { gainers: movers.gainers, losers: movers.losers, pulse, events, date: new Date(), sample: false };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(
      [
        'Usage: node scripts/make-short.mjs [options]',
        '',
        '  (no flags)        newest store event → story short',
        '  --type recap      today\'s top gainers/losers + candle charts',
        '  --lang <l>        en (default) | hinglish | hindi — spoken narration',
        '  --event <id>      specific event id',
        '  --demo            labelled SAMPLE data',
        '  --ai              fresh AI verdict (free tier) instead of the stored one',
        '  --notify          send finished MP4 to Telegram (bot env vars required)',
        '  --upload          publish the finished MP4 to YouTube (free Data API v3)',
        '  --upload-all      publish every finished run not yet on YouTube (no render)',
        '  --json            JSON summary on stdout',
        '  --voice <id>      edge-tts voice (default: preset for --lang)',
        '  --rate <+N%>      speech rate (default +6%)',
        '  --out <dir>       artifacts root (default artifacts/shorts)',
      ].join('\n')
    );
    return 0;
  }

  loadDotEnv();
  const { settings, holidays } = loadConfig();
  const outRoot =
    flags.out ?? path.join(PROJECT_ROOT, 'artifacts', 'shorts');
  const registryFile = defaultRegistryFile(path.dirname(settings.paths.db));

  // Standalone backfill: publish finished runs that never made it to YouTube.
  if (flags.uploadAll) {
    const results = await uploadAllUnsent({ runsRoot: outRoot, registryFile });
    if (!results.length) {
      console.log('No finished runs found to upload.');
      return 0;
    }
    const count = (s) => results.filter((r) => r.status === s).length;
    if (results.some((r) => r.status === 'no-auth')) {
      console.log(
        '\n  ⚠ YouTube not authorised yet — run: node scripts/youtube-auth.mjs (one-time)\n' +
          `  ${results.length} run(s) waiting, 0 published.`
      );
      return 0;
    }
    for (const r of results) {
      const line =
        r.status === 'uploaded'
          ? `✓ ${r.run} → ${r.url}`
          : r.status === 'already'
            ? `= ${r.run} already on YouTube (${r.url})`
            : r.status === 'sample'
              ? `- ${r.run} — ${r.message}`
              : `✗ ${r.run} — ${r.message}`;
      console.log(`  ${line}`);
    }
    console.log(
      `\n  ${results.length} run(s): ${count('uploaded')} newly published, ` +
        `${count('already')} already live, ${count('sample')} sample(s), ${count('error')} failed.`
    );
    return count('error') ? 1 : 0;
  }

  let event = null;
  let verdict = null;
  let recap = null;
  let store = null;

  if (flags.type === 'recap') {
    if (flags.demo) {
      recap = demoRecap();
    } else {
      // Weekend/holiday recaps would just re-publish the previous session
      // under a new date — skip cleanly instead of uploading a duplicate.
      const cal = marketCalendar(new Date(), holidays, settings.marketHours ?? {});
      if (cal.closed) {
        console.log(
          `Market closed today (${cal.closedLabel ?? cal.kind}) — no new session to recap, skipping.`
        );
        store?.close?.();
        return 0;
      }
      store = openStore({ driver: 'sqlite', dbPath: settings.paths.db });
      recap = await liveRecap({ store });
    }
  } else if (flags.demo) {
    event = DEMO_EVENT;
    verdict = DEMO_EVENT.ai_verdict;
  } else {
    store = openStore({ driver: 'sqlite', dbPath: settings.paths.db });
    if (flags.event) {
      event = store.getEvent(flags.event);
      if (!event) throw new Error(`event not found: ${flags.event}`);
    } else {
      const recent = store.listRecentEvents(
        new Date(Date.now() - 45 * 864e5).toISOString(),
        50
      );
      if (!recent.length) throw new Error('store has no recent events — try --demo');
      // Prefer events we have never published (upload registry), newest first.
      const registry = loadRegistry(registryFile);
      const pending = recent.filter((e) => !registry.videos[`event:${e.event_id}`]);
      if (!pending.length && recent.length) {
        console.log('note: every recent event is already on YouTube — re-rendering the newest anyway');
      }
      const pool = pending.length ? pending : recent;
      // Prefer events with high importance, newest first.
      pool.sort(
        (a, b) =>
          (b.importance ?? 0) - (a.importance ?? 0) ||
          Date.parse(b.detected_at ?? 0) - Date.parse(a.detected_at ?? 0)
      );
      event = pool[0];
    }

    if (flags.ai) {
      const svc = createOpenAIService({ settings, logger: console });
      if (!svc.hasKey) throw new Error('--ai requested but no AI key configured');
      verdict = await svc.analyze(event);
      console.log(`AI verdict: ${verdict.headline}`);
    } else {
      verdict = event.ai_verdict ?? fallbackVerdict(event, 'no-stored-verdict');
    }
  }

  const summary = await makeShort({
    event,
    verdict,
    type: flags.type,
    lang: flags.lang,
    settings,
    recap,
    outRoot,
    voice: flags.voice,
    rate: flags.rate,
    notify: flags.notify && !settings.dryRun && !flags.demo,
    logger: console,
  });

  store?.close?.();

  // Publish to YouTube (free Data API v3) — samples never leave the box.
  let uploadErrored = false;
  let uploadLine = '';
  if (flags.upload) {
    const result = await uploadShort({ summary, registryFile });
    summary.upload = result;
    uploadErrored = result.status === 'error';
    uploadLine =
      result.status === 'uploaded'
        ? `  ✓ uploaded → ${result.url}`
        : result.status === 'already'
          ? `  = already on YouTube → ${result.url}`
          : result.status === 'sample'
            ? `  ⏭ ${result.message}`
            : result.status === 'no-auth'
              ? `  ⚠ ${result.message}`
              : `  ✗ upload failed: ${result.message}`;
  }

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('');
    console.log(`  ✅  ${summary.video}`);
    console.log(
      `      ${summary.type}/${summary.lang}${
        ['ai', 'lexicon'].includes(summary.langMode) ? ` (${summary.langMode})` : ''
      }` +
        ` · ${summary.durationSec}s · ${(summary.bytes / 1e6).toFixed(1)} MB · ${summary.scenes.length} scenes · ${summary.elapsedSec}s build`
    );
    console.log(`      title: ${summary.title}`);
    if (uploadLine) console.log(uploadLine);
    console.log('');
  }
  return uploadErrored ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`SHORT FAILED: ${err.message}`);
    process.exit(1);
  });
