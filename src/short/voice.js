/**
 * Voice stage — Market → Short factory stage 2.
 *
 * Wraps the free Microsoft Edge neural TTS CLI (edge-tts) to turn the
 * narration into an MP3 plus an SRT subtitle track, then derives the data
 * every later stage needs:
 *
 *   synthSpeech      — narration text → voice.mp3 + voice.srt (free, no API
 *                      key); the output is decoded and, if it is unusable, the
 *                      synthesis is re-run before the stage gives up
 *   diagnoseVoice    — why a freshly written voice.mp3/voice.srt pair is or is
 *                      not a usable narration ('' = healthy)
 *   parseSrt        — SRT → [{start, end, text}] cues in seconds
 *   estimateWordTimings — sub-cue word timings (proportional estimate, good
 *                         enough for caption chunking and scene boundaries)
 *   matchSegments   — map script scenes onto the timeline so each scene PNG
 *                     is shown exactly while its lines are being spoken
 *
 * edge-tts 7.x emits sentence-level cues (no --words-in-cue flag), so word
 * timings inside a cue are estimated by character share — captions stay in
 * sync within a few tens of milliseconds, which is plenty for burned-in
 * Shorts captions.
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { ffprobeInfo } from './assemble.js';

/** Free en-IN neural voice; Neerja = female (channel default), Prabhat = male. */
export const DEFAULT_VOICE = 'en-IN-NeerjaNeural';

/** Size floor used only when ffprobe is unavailable — see diagnoseVoice(). */
export const MIN_VOICE_BYTES = 8 * 1024;

function rmQuiet(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort — a leftover file would only weaken the next check */
  }
}

/**
 * Is what edge-tts just wrote a *usable* narration?
 *
 * Returns `''` when healthy, otherwise a one-line reason to discard the attempt.
 *
 * Existence proves nothing. On 2026-10-12 edge-tts exited having written a
 * ~1 KB voice.mp3 for 80 words of speech, done in 0.7s end to end. The old gate
 * — `existsSync(mp3) && existsSync(srt)` — waved it straight through, and the
 * damage only surfaced much later as `ffprobe exited 1` while assembling, an
 * error naming the wrong stage entirely. Validate here, where a retry can still
 * rescue the run.
 *
 * `probe` is injectable so tests do not need ffprobe on PATH.
 */
export function diagnoseVoice({ mp3File, srtFile, probe = ffprobeInfo }) {
  for (const [label, file] of [
    ['voice.mp3', mp3File],
    ['voice.srt', srtFile],
  ]) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return `${label} was not written`;
    }
    if (!st.size) return `${label} is empty`;
  }

  try {
    const info = probe(mp3File);
    return Number(info?.duration) > 0 ? '' : 'voice.mp3 reports zero duration';
  } catch (err) {
    const msg = String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 200);
    // No ffprobe on this box → fall back to the size floor. Any other failure
    // means the stream cannot be decoded, which is precisely the truncation bug.
    if (!/not found/i.test(msg)) return `voice.mp3 cannot be decoded: ${msg}`;
    const size = fs.statSync(mp3File).size;
    return size >= MIN_VOICE_BYTES ? '' : `voice.mp3 is only ${size} bytes`;
  }
}

/**
 * One edge-tts invocation. Resolves rather than rejects on a bad exit so the
 * caller can retry; a spawn failure still rejects, since re-running a binary
 * that is not there would only delay the same error.
 */
function runEdgeTts({ txtFile, outFile, srtFile, voice, rate, command, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      [
        '-f', txtFile,
        '-v', voice,
        '--rate', rate,
        '--write-media', outFile,
        '--write-subtitles', srtFile,
      ],
      { windowsHide: true }
    );
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`edge-tts failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });
}

/**
 * Run edge-tts on a narration file, re-running whenever the output is unusable.
 *
 * Retrying is safe and cheap here: edge-tts is stateless, and a truncated
 * stream is transient (the observed 2026-10-12 failure reproduced twice a day
 * and passed on the runs in between).
 *
 * @param {object}   [opts]
 * @param {number}   [opts.attempts=3]  how many times to re-synthesize
 * @param {Function} [opts.run]         swap the edge-tts invocation (tests)
 * @returns {Promise<{file: string, srtFile: string, txtFile: string, attempts: number}>}
 */
export function synthSpeech({
  text,
  outFile,
  voice = DEFAULT_VOICE,
  rate = '+14%',
  command = 'edge-tts',
  timeoutMs = 120_000,
  attempts = 3,
  run = runEdgeTts,
} = {}) {
  if (!text || !text.trim()) return Promise.reject(new Error('synthSpeech: empty narration'));
  if (!outFile) return Promise.reject(new Error('synthSpeech: outFile required'));

  const txtFile = `${outFile}.txt`;
  const srtFile = outFile.replace(/\.[^.]+$/, '.srt');
  fs.writeFileSync(txtFile, text, 'utf8');

  return (async () => {
    let why = 'edge-tts never ran';
    let stderr = '';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // Clear both, or a file left by an earlier run would satisfy the check
      // while this run's synthesis produced nothing at all.
      rmQuiet(outFile);
      rmQuiet(srtFile);

      const res = await run({ txtFile, outFile, srtFile, voice, rate, command, timeoutMs });
      if (res.timedOut) throw new Error(`edge-tts timed out after ${timeoutMs}ms`);
      stderr = res.stderr ?? '';

      why = diagnoseVoice({ mp3File: outFile, srtFile });
      if (!why) return { file: outFile, srtFile, txtFile, attempts: attempt };
    }

    throw new Error(
      `edge-tts produced unusable output after ${attempts} attempt(s): ${why}` +
        (stderr ? ` — ${stderr.slice(-500)}` : '')
    );
  })();
}

/** "HH:MM:SS,mmm" → seconds */
export function parseTimecode(tc) {
  const m = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(tc).trim());
  if (!m) return 0;
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
  );
}

/** Parse SRT content → cues [{index, start, end, text}] (seconds). */
export function parseSrt(content) {
  const cues = [];
  const blocks = String(content ?? '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    const timeLine = lines[0].includes('-->') ? lines[0] : lines[1];
    const tm = /(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/.exec(
      timeLine
    );
    if (!tm) continue;
    const start = parseTimecode(tm[1]);
    const end = parseTimecode(tm[2]);
    const text = lines
      .slice(lines[0].includes('-->') ? 1 : 2)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) cues.push({ index: cues.length + 1, start, end, text });
  }
  return cues;
}

/** Lowercase, strip punctuation/quotes — for matching script tokens to TTS tokens. */
export function normalizeToken(token) {
  return String(token ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%]+/gu, '');
}

/**
 * Estimate word-level timings inside sentence-level cues by character share.
 * @returns {Array<{word: string, start: number, end: number, cue: number}>}
 */
export function estimateWordTimings(cues) {
  const words = [];
  cues.forEach((cue, ci) => {
    const tokens = cue.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    const totalChars = tokens.reduce((n, w) => n + w.length + 1, 0);
    const span = Math.max(cue.end - cue.start, 0.05);
    let t = cue.start;
    tokens.forEach((word, i) => {
      const share = ((word.length + 1) / totalChars) * span;
      const end = i === tokens.length - 1 ? cue.end : Math.min(t + share, cue.end);
      words.push({ word, start: Number(t.toFixed(3)), end: Number(end.toFixed(3)), cue: ci });
      t = end;
    });
  });
  return words;
}

/**
 * Map script scenes onto the word timeline.
 *
 * Walks the words in order, matching each scene's spoken tokens; a scene's
 * start = first matched word, end = last matched word. Tokens the TTS
 * rewrote (expanded abbreviations, merged numbers) are skipped with a
 * bounded miss budget. Scenes that cannot be matched fall back to a
 * proportional split, so the video always gets valid boundaries.
 *
 * @returns {Array<{start: number, end: number}|null>}
 */
export function matchSegments(scenes, words) {
  const flat = words.map((w) => normalizeToken(w.word));
  const out = [];
  let j = 0;

  for (const scene of scenes) {
    const tokens = String(scene.speech ?? '')
      .split(/\s+/)
      .map(normalizeToken)
      .filter(Boolean);
    let first = -1;
    let last = -1;
    let misses = 0;

    for (const tok of tokens) {
      let found = false;
      while (j < flat.length && misses < 12) {
        if (flat[j] === tok) {
          if (first < 0) first = j;
          last = j;
          j += 1;
          found = true;
          break;
        }
        j += 1;
        misses += 1;
      }
      if (!found && first >= 0) {
        // token missing after we already started — keep going from here
        j = Math.min(j, flat.length);
      }
    }
    out.push(first >= 0 ? { first, last } : null);
  }

  // Resolve boundaries: start of each scene; fill gaps proportionally.
  const boundaries = new Array(scenes.length).fill(null);
  out.forEach((m, i) => {
    if (m) boundaries[i] = words[m.first].start;
  });
  for (let i = 0; i < boundaries.length; i += 1) {
    if (boundaries[i] !== null) continue;
    // interpolate between the nearest known neighbours (or 0 / last-known)
    let prev = i - 1;
    while (prev >= 0 && boundaries[prev] === null) prev -= 1;
    let next = i + 1;
    while (next < boundaries.length && boundaries[next] === null) next += 1;
    const prevT = prev >= 0 && boundaries[prev] !== null ? boundaries[prev] : 0;
    const nextT =
      next < boundaries.length && boundaries[next] !== null
        ? boundaries[next]
        : (words.at(-1)?.end ?? prevT + 5);
    const span = next - prev;
    boundaries[i] = Number((prevT + ((nextT - prevT) * (i - prev)) / span).toFixed(3));
  }
  boundaries[0] = 0; // narration always starts at t=0

  return boundaries.map((start, i) => ({
    start,
    end: i + 1 < boundaries.length ? boundaries[i + 1] : (words.at(-1)?.end ?? start + 3),
  }));
}
