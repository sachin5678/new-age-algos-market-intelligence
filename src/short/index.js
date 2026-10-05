/**
 * Market → Short factory — orchestrator.
 *
 *   event + verdict ──▶ script.js    (scenes + narration, deterministic)
 *                    ──▶ voice.js     (free edge-tts → mp3 + srt + timings)
 *                    ──▶ scenes.js    (HTML → headless Chrome → 1080×1920 PNGs)
 *                    ──▶ captions.js  (word timings → styled ASS)
 *                    ──▶ assemble.js  (free ffmpeg → short.mp4)
 *                    ──▶ qa.js        (gate before anything leaves the box)
 *                    ──▶ optional Telegram "content ready" notification
 *
 * Everything is free and local: no paid API, no SaaS render farm. AI script
 * material comes from the pipeline's existing (free-tier) verdict; the
 * factory itself never calls a model.
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildShort, DEFAULT_HASHTAGS } from './script.js';
import { buildRecapShort } from './recap.js';
import { rewriteNarration, voiceForLang, normalizeLang } from './lang.js';
import { synthSpeech, parseSrt, estimateWordTimings, matchSegments } from './voice.js';
import { buildCaptionChunks, buildAss } from './captions.js';
import { renderSceneHtml, SHORT_DIMS } from './scenes.js';
import {
  findTool,
  ffprobeInfo,
  renderSegments,
  concatSegments,
  burnAndMux,
} from './assemble.js';
import { validateShort } from './qa.js';
import { renderPng, validateImage } from '../visual/render.js';
import { fmtDateShort } from '../visual/components.js';

export { buildShort } from './script.js';
export { buildRecapShort } from './recap.js';
export { SHORT_DIMS } from './scenes.js';

const TAIL_SEC = 0.7; // hold on the outro after the last spoken word
const MIN_SCENE_SEC = 0.8;

/** Clamp tiny scene durations to MIN_SCENE_SEC without changing the total. */
function normalizeDurations(durs) {
  const out = durs.map((d) => Math.max(d, MIN_SCENE_SEC));
  const total = out.reduce((a, b) => a + b, 0);
  const target = durs.reduce((a, b) => a + b, 0);
  let diff = total - target;
  if (Math.abs(diff) < 1e-6) return out;
  // Take the surplus/deficit from the longest scenes (never below minimum).
  const order = out.map((d, i) => [d, i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (Math.abs(diff) < 1e-6) break;
    if (diff > 0) {
      const canTake = Math.max(0, out[i] - MIN_SCENE_SEC);
      const take = Math.min(canTake, diff);
      out[i] -= take;
      diff -= take;
    } else {
      out[i] += -diff;
      diff = 0;
    }
  }
  return out;
}

/**
 * Produce one short from an event + verdict (type "story") or from recap
 * market data (type "recap").
 *
 * @param {object} args
 * @param {object} [args.event]    store event (story type)
 * @param {object} [args.verdict]  AI/rules verdict (story type)
 * @param {'story'|'recap'} [args.type]
 * @param {'en'|'hinglish'|'hindi'} [args.lang] spoken narration language
 * @param {object} [args.settings] loadConfig() settings (AI access for lang)
 * @param {object} [args.recap]    {gainers, losers, pulse, events, date, sample}
 * @param {string} args.outRoot  artifacts/shorts
 * @param {string} [args.voice]  explicit edge-tts voice id (overrides lang preset)
 * @param {string} [args.rate]   TTS rate like "+6%"
 * @param {boolean} [args.notify] send "content ready" to Telegram (Bot API)
 * @param {object} [args.logger]
 * @returns {Promise<object>} summary
 */
export async function makeShort({
  event,
  verdict,
  type = 'story',
  lang = 'en',
  settings = null,
  recap = null,
  outRoot,
  voice = null,
  rate = '+6%',
  notify = false,
  handle = '@newageAlgos',
  logger = console,
} = {}) {
  const started = Date.now();
  const L = normalizeLang(lang);
  const resolvedVoice = voiceForLang(L, voice);
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(outRoot, `run-${runId}`);
  fs.mkdirSync(dir, { recursive: true });

  const log = (phase, msg, extra = {}) => logger.info?.(`SHORT ${phase}`, msg, extra) ?? void 0;

  // 1 ── script -----------------------------------------------------------
  let short;
  let langMode = 'template';
  if (type === 'recap') {
    if (!recap) throw new Error('recap data required for type=recap');
    short = buildRecapShort({ ...recap, lang: L, handle });
  } else {
    short = buildShort({ event, verdict, handle });
    const re = await rewriteNarration({ scenes: short.scenes, lang: L, settings });
    langMode = re.mode;
    if (re.mode !== 'en') {
      short = {
        ...short,
        scenes: re.scenes,
        narration: re.scenes.map((s) => s.speech).join(' '),
      };
    }
  }
  if (!short.narration) throw new Error('empty narration — nothing to synthesize');
  log('SCRIPT', `${short.scenes.length} scenes, ${short.narration.split(/\s+/).length} words`, {
    type,
    lang: L,
    langMode,
  });

  // 2 ── voice ------------------------------------------------------------
  const audio = path.join(dir, 'voice.mp3');
  await synthSpeech({ text: short.narration, outFile: audio, voice: resolvedVoice, rate });
  const cues = parseSrt(fs.readFileSync(audio.replace(/\.mp3$/, '.srt'), 'utf8'));
  const words = estimateWordTimings(cues);
  const audioInfo = ffprobeInfo(audio);
  if (!(audioInfo.duration > 1)) throw new Error('TTS produced no usable audio');
  log('VOICE', `${resolvedVoice} → ${audioInfo.duration.toFixed(1)}s, ${words.length} words`);

  // 3 ── scene timing -----------------------------------------------------
  const boundaries = matchSegments(short.scenes, words).map((t) => t.start);
  const rawDurs = boundaries.map((b, i) =>
    i + 1 < boundaries.length ? boundaries[i + 1] - b : audioInfo.duration + TAIL_SEC - b
  );
  const durs = normalizeDurations(rawDurs);
  log('TIMING', `scenes: ${durs.map((d) => d.toFixed(1)).join(' + ')}s`);

  // 4 ── scene PNGs -------------------------------------------------------
  const meta = {
    category: short.category,
    impact: short.impact,
    importance: short.importance,
    source: short.source,
    handle: short.handle,
    date: fmtDateShort(
      new Date(
        type === 'recap'
          ? recap.date ?? Date.now()
          : event.published_at ?? event.detected_at ?? Date.now()
      )
    ),
    sample: type === 'recap' ? Boolean(recap.sample) : Boolean(event.sample),
  };
  const scenes = [];
  for (let i = 0; i < short.scenes.length; i += 1) {
    const scene = short.scenes[i];
    const html = renderSceneHtml(scene, meta, SHORT_DIMS);
    const { buffer } = await renderPng({ html, ...SHORT_DIMS });
    const qa = validateImage({ buffer, width: SHORT_DIMS.width, height: SHORT_DIMS.height, html });
    if (!qa.ok) throw new Error(`scene ${i} (${scene.kind}) failed QA: ${qa.problems.join('; ')}`);
    const png = path.join(dir, `scene-${String(i).padStart(2, '0')}-${scene.kind}.png`);
    fs.writeFileSync(png, buffer);
    scenes.push({ png, dur: durs[i], kind: scene.kind });
  }
  log('SCENES', `${scenes.length} PNGs rendered`);

  // 5 ── captions ---------------------------------------------------------
  const chunks = buildCaptionChunks(words);
  const ass = path.join(dir, 'captions.ass');
  fs.writeFileSync(ass, buildAss(chunks, SHORT_DIMS), 'utf8');
  log('CAPTIONS', `${chunks.length} caption chunks`);

  // 6 ── assemble ---------------------------------------------------------
  const ffmpeg = findTool('ffmpeg');
  const segs = renderSegments({ ffmpeg, scenes, outDir: dir });
  const base = path.join(dir, 'base.mp4');
  concatSegments({ ffmpeg, segments: segs, outFile: base, cwd: dir });
  const video = path.join(dir, 'short.mp4');
  burnAndMux({ ffmpeg, base, audio, ass, out: video, cwd: dir });

  // 7 ── QA gate ----------------------------------------------------------
  const probe = ffprobeInfo(video);
  const gate = validateShort({ file: video, probe });
  if (!gate.ok) throw new Error(`short failed QA: ${gate.problems.join('; ')}`);
  log('QA', `ok — ${probe.duration.toFixed(1)}s, ${(probe.size / 1e6).toFixed(1)} MB`);

  // 8 ── metadata for the upload step -------------------------------------
  const metaFile = path.join(dir, 'meta.json');
  const summary = {
    ok: true,
    runId,
    type,
    lang: L,
    langMode,
    dir,
    video,
    durationSec: Number(probe.duration.toFixed(2)),
    bytes: probe.size,
    scenes: scenes.map((s) => ({ kind: s.kind, dur: Number(s.dur.toFixed(2)), png: s.png })),
    eventId: type === 'recap' ? null : (event.event_id ?? null),
    sample: type === 'recap' ? Boolean(recap.sample) : Boolean(event.sample),
    uploadKey:
      type === 'recap'
        ? `recap:${new Date(recap.date ?? Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}`
        : event.event_id
          ? `event:${event.event_id}`
          : null,
    title: short.title,
    description: short.description,
    hashtags: short.hashtags,
    voice: resolvedVoice,
    elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
    qa: gate.problems,
  };
  fs.writeFileSync(metaFile, JSON.stringify(summary, null, 2), 'utf8');

  // 9 ── optional "content ready" notification ----------------------------
  if (notify) {
    summary.notified = await notifyContentReady({ video, caption: short.title });
  }

  return summary;
}

/**
 * Free Telegram Bot API notify: send the finished short to the content
 * queue chat. Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 */
export async function notifyContentReady({
  video,
  caption,
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
} = {}) {
  if (!token || !chatId) return { sent: false, reason: 'missing TELEGRAM_BOT_TOKEN/CHAT_ID' };
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', String(caption ?? '').slice(0, 1020));
  form.set('video', new Blob([fs.readFileSync(video)], { type: 'video/mp4' }), 'short.mp4');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: 'POST',
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  return { sent: Boolean(body.ok), description: body.description ?? null };
}
