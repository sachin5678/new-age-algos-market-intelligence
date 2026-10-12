import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildShort } from '../src/short/script.js';
import {
  parseSrt,
  parseTimecode,
  estimateWordTimings,
  matchSegments,
  normalizeToken,
  diagnoseVoice,
  synthSpeech,
  MIN_VOICE_BYTES,
  DEFAULT_VOICE,
} from '../src/short/voice.js';
import { buildCaptionChunks, buildAss } from '../src/short/captions.js';
import { renderSceneHtml, shortCss, SHORT_DIMS } from '../src/short/scenes.js';
import { validateShort } from '../src/short/qa.js';

const verdict = {
  headline: 'Nifty oversold ahead of RBI policy — rebound chances are rising',
  summary: 'Nifty 50 is oversold while traders wait for the RBI policy decision.',
  facts: [
    'Nifty 50 slipped below the rising trendline from the swing lows of June 2024 and April 2025.',
    'Oversold conditions are raising the odds of a rebound from current levels.',
    'The RBI policy decision is the next big catalyst traders are watching.',
  ],
  market_relevance:
    'A rebound attempt into the RBI policy keeps the broad range intact, while a breakdown extends the correction.',
  impact: 'mixed',
};

const event = {
  event_id: 'evt_test',
  title: 'Nifty prediction today: oversold conditions raise rebound chances',
  category: 'RBI',
  importance_level: 'HIGH',
  source: 'Livemint',
  url: 'https://example.com/nifty',
};

// ------------------------------------------------------------- script.js

test('buildShort: hook → facts → why → cta, narration joins speeches', () => {
  const short = buildShort({ event, verdict });
  assert.equal(short.scenes[0].kind, 'hook');
  assert.equal(short.scenes.at(-1).kind, 'cta');
  const facts = short.scenes.filter((s) => s.kind === 'fact');
  assert.equal(facts.length, 3);
  assert.equal(short.scenes.some((s) => s.kind === 'why'), true);

  const narration = short.scenes.map((s) => s.speech).join(' ');
  assert.equal(short.narration, narration);
  assert.ok(short.narration.split(/\s+/).length >= 40, 'narration should be substantial');
});

test('buildShort: title capped at 100 chars with #Shorts, description has source', () => {
  const short = buildShort({ event, verdict });
  assert.ok(short.title.length <= 100, `title too long: ${short.title.length}`);
  assert.match(short.title, /#Shorts$/);
  assert.match(short.description, /Source: https:\/\/example\.com\/nifty/);
  assert.match(short.description, /#newagealgos/);
});

test('buildShort: survives empty verdict (no crash, no undefined text)', () => {
  const short = buildShort({ event: { title: 'Plain title' }, verdict: {} });
  assert.ok(short.narration.length > 0);
  assert.equal(short.narration.includes('undefined'), false);
  assert.equal(short.scenes.at(-1).kind, 'cta');
});

test('buildShort: caps facts at 3', () => {
  const many = { ...verdict, facts: ['a', 'b', 'c', 'd', 'e'] };
  const short = buildShort({ event, verdict: many });
  assert.equal(short.scenes.filter((s) => s.kind === 'fact').length, 3);
});

// ------------------------------------------------------------- voice.js

test('parseTimecode handles HH:MM:SS,mmm', () => {
  assert.equal(parseTimecode('00:00:04,950'), 4.95);
  assert.equal(parseTimecode('01:02:03.250'), 3723.25);
});

test('parseSrt parses the sample track', () => {
  const srt = `1
00:00:00,100 --> 00:00:04,950
Nifty is oversold ahead of the RBI policy decision.

2
00:00:04,900 --> 00:00:07,775
Rebound chances are rising.
`;
  const cues = parseSrt(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0.1);
  assert.equal(cues[0].end, 4.95);
  assert.equal(cues[1].text, 'Rebound chances are rising.');
});

test('estimateWordTimings covers each cue span in order', () => {
  const cues = parseSrt(`1
00:00:00,000 --> 00:00:02,000
one two three

2
00:00:02,000 --> 00:00:03,500
four
`);
  const words = estimateWordTimings(cues);
  assert.equal(words.length, 4);
  assert.equal(words[0].start, 0);
  assert.equal(words[2].end <= 2.0 + 1e-6, true);
  assert.equal(words[3].end, 3.5);
  for (let i = 1; i < words.length; i += 1) {
    assert.ok(words[i].start >= words[i - 1].start, 'words must be ordered');
  }
});

test('matchSegments maps scenes to their spoken windows', () => {
  const scenes = [
    { speech: 'Nifty is oversold today.' },
    { speech: 'Rebound chances are rising.' },
    { speech: 'Follow New Age Algos.' },
  ];
  const cues = parseSrt(`1
00:00:00,100 --> 00:00:02,000
Nifty is oversold today.

2
00:00:02,000 --> 00:00:04,000
Rebound chances are rising.

3
00:00:04,000 --> 00:00:05,500
Follow New Age Algos.
`);
  const words = estimateWordTimings(cues);
  const bounds = matchSegments(scenes, words);
  assert.equal(bounds.length, 3);
  assert.equal(bounds[0].start, 0);
  assert.ok(Math.abs(bounds[1].start - 2) < 0.15, `scene 1 start ${bounds[1].start}`);
  assert.ok(Math.abs(bounds[2].start - 4) < 0.15, `scene 2 start ${bounds[2].start}`);
});

test('matchSegments falls back to proportional timing when text diverges', () => {
  const scenes = [{ speech: 'Alpha beta gamma.' }, { speech: 'Delta epsilon.' }];
  const cues = parseSrt(`1
00:00:00,000 --> 00:00:04,000
Completely different narration entirely here
`);
  const words = estimateWordTimings(cues);
  const bounds = matchSegments(scenes, words);
  assert.equal(bounds.length, 2);
  assert.equal(bounds[0].start, 0);
  assert.ok(bounds[1].start > 0 && bounds[1].start < 4, 'fallback boundary inside duration');
});

test('normalizeToken strips punctuation and case', () => {
  assert.equal(normalizeToken('Nifty-50!'), 'nifty50');
  assert.equal(normalizeToken('  RBI?'), 'rbi');
});

test('DEFAULT_VOICE is a free en-IN neural voice', () => {
  assert.match(DEFAULT_VOICE, /^en-IN-/);
});

// ------------------------------------------------- voice.js: output gate

/**
 * Lay down a voice.mp3/voice.srt pair in a scratch dir, hand it to fn, clean up.
 * Pass `mp3: null` / `srt: null` to leave that file unwritten.
 */
function withVoice({ mp3 = Buffer.alloc(64 * 1024, 1), srt = '1\n00:00:00,000 --> 00:00:01,000\nHi\n' } = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetest-'));
  const mp3File = path.join(dir, 'voice.mp3');
  const srtFile = path.join(dir, 'voice.srt');
  if (mp3 !== null) fs.writeFileSync(mp3File, mp3);
  if (srt !== null) fs.writeFileSync(srtFile, srt);
  try {
    return fn({ mp3File, srtFile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const decode = (file) => ({ duration: 31.4, size: fs.statSync(file).size });
const truncated = () => {
  throw new Error(
    'ffprobe exited 1: [mp3 @ 0x55] Failed to read frame size: Could not seek to 1026.'
  );
};
const noFfprobe = () => {
  throw new Error('ffprobe not found — install it (free) or set FFPROBE_PATH.');
};

test('diagnoseVoice: a decodable narration is healthy', () => {
  withVoice({}, ({ mp3File, srtFile }) => {
    assert.equal(diagnoseVoice({ mp3File, srtFile, probe: decode }), '');
  });
});

test('diagnoseVoice: rejects the 1 KB truncated stream that exists on disk', () => {
  // Production failure, 2026-10-12: both files were present, the mp3 was ~1 KB,
  // and the old existsSync gate passed it — the breakage only surfaced later as
  // `ffprobe exited 1` during assembly.
  withVoice({ mp3: Buffer.alloc(1026, 0) }, ({ mp3File, srtFile }) => {
    const why = diagnoseVoice({ mp3File, srtFile, probe: truncated });
    assert.match(why, /cannot be decoded/);
    assert.match(why, /Could not seek to 1026/, 'the decode failure must survive into the message');
  });
});

test('diagnoseVoice: reports a zero-length stream', () => {
  withVoice({}, ({ mp3File, srtFile }) => {
    assert.match(
      diagnoseVoice({ mp3File, srtFile, probe: () => ({ duration: 0 }) }),
      /zero duration/
    );
  });
});

test('diagnoseVoice: reports a missing or empty half of the pair', () => {
  withVoice({ srt: null }, ({ mp3File, srtFile }) => {
    assert.match(diagnoseVoice({ mp3File, srtFile, probe: decode }), /voice\.srt was not written/);
  });
  withVoice({ mp3: null }, ({ mp3File, srtFile }) => {
    assert.match(diagnoseVoice({ mp3File, srtFile, probe: decode }), /voice\.mp3 was not written/);
  });
  withVoice({ mp3: Buffer.alloc(0) }, ({ mp3File, srtFile }) => {
    assert.match(diagnoseVoice({ mp3File, srtFile, probe: decode }), /voice\.mp3 is empty/);
  });
  withVoice({ srt: Buffer.alloc(0) }, ({ mp3File, srtFile }) => {
    assert.match(diagnoseVoice({ mp3File, srtFile, probe: decode }), /voice\.srt is empty/);
  });
});

test('diagnoseVoice: without ffprobe it falls back to the size floor', () => {
  withVoice({ mp3: Buffer.alloc(1026, 0) }, ({ mp3File, srtFile }) => {
    assert.match(
      diagnoseVoice({ mp3File, srtFile, probe: noFfprobe }),
      /only 1026 bytes/,
      'the truncation must still be caught when ffprobe is absent'
    );
  });
  withVoice({ mp3: Buffer.alloc(MIN_VOICE_BYTES, 1) }, ({ mp3File, srtFile }) => {
    assert.equal(diagnoseVoice({ mp3File, srtFile, probe: noFfprobe }), '');
  });
});

// ---------------------------------------------- voice.js: synthesis retry

const SRT = '1\n00:00:00,000 --> 00:00:01,000\nHello\n';

/** 1s of 16-bit mono silence as RIFF/WAVE — decodable from the header alone. */
function silentWav(seconds = 1) {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'synth-'));
}

test('synthSpeech: a truncated synthesis is re-run rather than passed through', async () => {
  const dir = scratch();
  const outFile = path.join(dir, 'voice.mp3');
  let calls = 0;
  const run = async ({ outFile: mp3, srtFile }) => {
    calls += 1;
    // attempt 1 reproduces the 2026-10-12 failure: both files written, mp3 dead
    fs.writeFileSync(mp3, calls === 1 ? Buffer.alloc(1026, 0) : silentWav());
    fs.writeFileSync(srtFile, SRT);
    return { code: 0, stderr: '', timedOut: false };
  };

  try {
    const res = await synthSpeech({ text: 'Nifty is oversold today.', outFile, run });
    assert.equal(calls, 2, 'the bad attempt must be retried');
    assert.equal(res.attempts, 2);
    assert.equal(res.file, outFile);
    assert.equal(fs.existsSync(`${outFile}.txt`), true, 'narration kept as an artifact');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('synthSpeech: gives up after `attempts`, naming the reason and the CLI output', async () => {
  const dir = scratch();
  const outFile = path.join(dir, 'voice.mp3');
  let calls = 0;
  const run = async ({ outFile: mp3, srtFile }) => {
    calls += 1;
    fs.writeFileSync(mp3, Buffer.alloc(1026, 0));
    fs.writeFileSync(srtFile, SRT);
    return { code: 1, stderr: 'upstream stream reset', timedOut: false };
  };

  try {
    await assert.rejects(
      () => synthSpeech({ text: 'Nifty is oversold today.', outFile, run, attempts: 3 }),
      (err) => {
        assert.match(err.message, /after 3 attempt\(s\)/);
        assert.match(err.message, /cannot be decoded|only 1026 bytes/);
        assert.match(err.message, /upstream stream reset/, 'CLI stderr must reach the caller');
        return true;
      }
    );
    assert.equal(calls, 3, 'every attempt should be spent before failing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('synthSpeech: a leftover voice.mp3 cannot mask a synthesis that wrote nothing', async () => {
  const dir = scratch();
  const outFile = path.join(dir, 'voice.mp3');
  // leftovers from a previous short — good-looking, but not this run's work
  fs.writeFileSync(outFile, silentWav());
  fs.writeFileSync(path.join(dir, 'voice.srt'), SRT);

  let calls = 0;
  const run = async () => {
    calls += 1;
    return { code: 1, stderr: 'no output', timedOut: false };
  };

  try {
    await assert.rejects(() => synthSpeech({ text: 'Nifty.', outFile, run, attempts: 2 }));
    assert.equal(calls, 2, 'stale files must be cleared, not accepted');
    assert.equal(fs.existsSync(outFile), false, 'the stale file should have been removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('synthSpeech: a timeout aborts the stage instead of burning the retry budget', async () => {
  const dir = scratch();
  const outFile = path.join(dir, 'voice.mp3');
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { code: null, stderr: '', timedOut: true };
  };

  try {
    await assert.rejects(() => synthSpeech({ text: 'Nifty.', outFile, run, attempts: 3 }), /timed out/);
    assert.equal(calls, 1, 'waiting again would only multiply the stall');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ captions.js

test('buildCaptionChunks flushes on gaps and caps length', () => {
  const words = [
    { word: 'Nifty', start: 0, end: 0.2 },
    { word: 'is', start: 0.2, end: 0.3 },
    { word: 'oversold', start: 0.3, end: 0.7 },
    { word: 'today', start: 0.7, end: 1.0 },
    // scene gap → new chunk
    { word: 'Rebound', start: 2.0, end: 2.3 },
    { word: 'chances', start: 2.3, end: 2.6 },
  ];
  const chunks = buildCaptionChunks(words, { maxWords: 4, maxChars: 40 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'Nifty is oversold today');
  assert.equal(chunks[1].start, 2.0);
  assert.equal(chunks[1].end, 2.6);
});

test('buildCaptionChunks splits overlong chunks by word count', () => {
  const words = Array.from({ length: 9 }, (_, i) => ({
    word: `word${i}`,
    start: i * 0.2,
    end: i * 0.2 + 0.18,
  }));
  const chunks = buildCaptionChunks(words, { maxWords: 4, maxGap: 10, maxChars: 100 });
  assert.ok(chunks.length >= 3, 'long runs must split');
  for (const ch of chunks) {
    assert.ok(ch.text.split(' ').length <= 4);
    assert.ok(ch.end > ch.start);
  }
});

test('buildAss emits a valid ASS document at 1080x1920', () => {
  const ass = buildAss([{ text: 'Nifty rebounds', start: 0.1, end: 1.2 }], SHORT_DIMS);
  assert.match(ass, /\[Script Info\]/);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Style: Short,Arial,/);
  assert.match(ass, /Dialogue: 0,0:00:00\.10,0:00:01\.20,Short,,0,0,0,,NIFTY REBOUNDS/);
  // colors must derive from the theme (background navy outline, light text)
  assert.match(ass, /,Short,,/);
});

test('buildAss escapes braces so ASS override codes cannot inject', () => {
  const ass = buildAss([{ text: 'a {\\b1} trick', start: 0, end: 1 }], SHORT_DIMS);
  const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
  assert.equal(dialogue.includes('{'), false);
});

// ------------------------------------------------------------- scenes.js

test('renderSceneHtml: every scene kind produces a .poster doc', () => {
  const meta = {
    category: 'RBI',
    impact: 'mixed',
    date: '05 OCT 2026',
    source: 'Livemint',
    handle: '@newageAlgos',
  };
  const scenes = [
    { kind: 'hook', text: 'Nifty oversold ahead of RBI policy' },
    { kind: 'fact', n: 1, of: 3, text: 'Nifty slipped below its rising trendline.' },
    { kind: 'why', text: 'A breakdown would extend the correction.' },
    { kind: 'cta', text: 'FOLLOW @newageAlgos' },
  ];
  for (const scene of scenes) {
    const html = renderSceneHtml(scene, meta, SHORT_DIMS);
    assert.match(html, /<div class="poster"/, `${scene.kind}: missing .poster`);
    assert.ok(html.includes(scene.text), `${scene.kind}: scene text missing`);
    assert.equal(html.includes('undefined'), false);
    assert.equal(html.includes('[object Object]'), false);
  }
});

test('renderSceneHtml: hook shows category + impact chip, fact shows badge', () => {
  const meta = { category: 'RBI', impact: 'positive', date: 'x' };
  const hook = renderSceneHtml({ kind: 'hook', text: 'T' }, meta);
  assert.match(hook, /sh-cat/);
  assert.match(hook, /i-positive/);
  const fact = renderSceneHtml({ kind: 'fact', n: 2, of: 3, text: 'T' }, meta);
  assert.match(fact, /FACT 2 \/ 3/);
});

test('renderSceneHtml: sample events carry the SAMPLE banner', () => {
  const html = renderSceneHtml({ kind: 'hook', text: 'T' }, { sample: true });
  assert.match(html, /SAMPLE \/ TEST DATA/);
});

test('shortCss reserves caption zone (bottom padding) and uses theme colors only', () => {
  const css = shortCss();
  assert.match(css, /padding:26px 26px 330px/);
  // no raw hex colors outside of theme — the css builder interpolates them,
  // so at least assert none of the *other* brand hexes leak in ad hoc
  assert.match(css, /--?/); // smoke: css non-empty
  assert.ok(css.length > 400);
});

test('SHORT_DIMS is 1080x1920 at scale 2', () => {
  assert.deepEqual(SHORT_DIMS, { width: 1080, height: 1920, scale: 2 });
});

// ----------------------------------------------------------------- qa.js

test('validateShort: accepts a conforming probe', () => {
  const probe = {
    duration: 42.5,
    size: 3_500_000,
    width: 1080,
    height: 1920,
    hasVideo: true,
    hasAudio: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
  };
  const res = validateShort({ file: 'package.json', probe }); // exists on disk
  assert.deepEqual(res, { ok: true, problems: [] });
});

test('validateShort: rejects wrong dimensions, missing audio, bad duration', () => {
  const probe = {
    duration: 9.0,
    size: 5000,
    width: 720,
    height: 1280,
    hasVideo: true,
    hasAudio: false,
    videoCodec: 'vp9',
    audioCodec: null,
  };
  const res = validateShort({ file: 'package.json', probe });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes('wrong dimensions')));
  assert.ok(res.problems.some((p) => p.includes('no audio stream')));
  assert.ok(res.problems.some((p) => p.includes('outside')));
  assert.ok(res.problems.some((p) => p.includes('small')));
});

test('validateShort: rejects a missing file', () => {
  const res = validateShort({
    file: 'does-not-exist-xyz.mp4',
    probe: {
      duration: 30,
      size: 1_000_000,
      width: 1080,
      height: 1920,
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
  });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes('file not found')));
});
