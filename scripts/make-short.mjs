#!/usr/bin/env node
/**
 * Market → Short factory CLI (free, local).
 *
 *   npm run short                    → newest store event → artifacts/shorts/run-<ts>/short.mp4
 *   npm run short -- --event <id>    → a specific event
 *   npm run short -- --demo          → labelled SAMPLE event (no store needed)
 *   npm run short -- --ai            → force a fresh (free-tier) AI verdict
 *   npm run short -- --notify        → also send the MP4 to the Telegram
 *                                       content queue (needs bot env vars)
 *   npm run short -- --json          → machine-readable summary
 *
 * Flags: --voice <id>  --rate <+N%>  --out <dir>
 * Everything downstream of the verdict is deterministic and free:
 * edge-tts (voice), headless Chrome (scenes), ffmpeg (video).
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadDotEnv, PROJECT_ROOT } from '../src/config.js';
import { openStore } from '../src/store/index.js';
import { createOpenAIService, fallbackVerdict } from '../src/ai/openaiService.js';
import { makeShort } from '../src/short/index.js';
import { DEFAULT_VOICE } from '../src/short/voice.js';

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
    event: null,
    voice: DEFAULT_VOICE,
    rate: '+6%',
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--demo') flags.demo = true;
    else if (a === '--ai') flags.ai = true;
    else if (a === '--notify') flags.notify = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--event') flags.event = argv[++i] ?? null;
    else if (a === '--voice') flags.voice = argv[++i] ?? DEFAULT_VOICE;
    else if (a === '--rate') flags.rate = argv[++i] ?? '+6%';
    else if (a === '--out') flags.out = argv[++i] ?? null;
    else if (!a.startsWith('--')) flags.event = a;
    else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(
      [
        'Usage: node scripts/make-short.mjs [options]',
        '',
        '  (no flags)        newest store event',
        '  --event <id>      specific event id',
        '  --demo            labelled SAMPLE event',
        '  --ai              fresh AI verdict (free tier) instead of the stored one',
        '  --notify          send finished MP4 to Telegram (bot env vars required)',
        '  --json            JSON summary on stdout',
        '  --voice <id>      edge-tts voice (default en-IN-PrabhatNeural)',
        '  --rate <+N%>      speech rate (default +6%)',
        '  --out <dir>       artifacts root (default artifacts/shorts)',
      ].join('\n')
    );
    return 0;
  }

  loadDotEnv();
  const { settings } = loadConfig();
  const outRoot =
    flags.out ?? path.join(PROJECT_ROOT, 'artifacts', 'shorts');

  let event = null;
  let verdict = null;
  let store = null;

  if (flags.demo) {
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
      // Prefer events with high importance, newest first.
      recent.sort(
        (a, b) =>
          (b.importance ?? 0) - (a.importance ?? 0) ||
          Date.parse(b.detected_at ?? 0) - Date.parse(a.detected_at ?? 0)
      );
      event = recent[0];
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
    outRoot,
    voice: flags.voice,
    rate: flags.rate,
    notify: flags.notify && !settings.dryRun && !flags.demo,
    logger: console,
  });

  store?.close?.();

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('');
    console.log(`  ✅  ${summary.video}`);
    console.log(`      ${summary.durationSec}s · ${(summary.bytes / 1e6).toFixed(1)} MB · ${summary.scenes.length} scenes · ${summary.elapsedSec}s build`);
    console.log(`      title: ${summary.title}`);
    console.log(`      upload with: ${summary.video}`);
    console.log('');
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`SHORT FAILED: ${err.message}`);
    process.exit(1);
  });
