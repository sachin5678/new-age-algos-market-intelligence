import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LANGS,
  CTA_SPEECH,
  normalizeLang,
  voiceForLang,
  lexiconHinglish,
  rewriteNarration,
} from '../src/short/lang.js';

const scenes = () => [
  { kind: 'hook', text: 'Nifty oversold ahead of RBI policy', speech: 'Nifty is oversold ahead of the RBI policy decision.' },
  { kind: 'fact', text: 'Fact one', speech: 'The market fell sharply today.' },
  { kind: 'cta', text: 'FOLLOW @newageAlgos', speech: 'For more market shorts, follow New Age Algos.' },
];

const aiSettings = {
  ai: {
    enabled: true,
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    timeoutMs: 5000,
  },
};

/** Mock of the OpenAI-compatible endpoint that echoes Hindi-style rewrites. */
function mockFetchOk() {
  return async (url, opts) => {
    const input = JSON.parse(JSON.parse(opts.body).messages[1].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(input.map((t) => `HN: ${t}`)) } }],
      }),
    };
  };
}

test('normalizeLang accepts aliases and rejects unknowns', () => {
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('English'), 'en');
  assert.equal(normalizeLang('hinglish'), 'hinglish');
  assert.equal(normalizeLang('hi'), 'hinglish');
  assert.equal(normalizeLang('hindi'), 'hindi');
  assert.equal(normalizeLang(undefined), 'en');
  assert.throws(() => normalizeLang('french'), /unknown language/);
});

test('voiceForLang: per-language preset, explicit voice wins', () => {
  assert.equal(voiceForLang('en'), LANGS.en.voice);
  assert.equal(voiceForLang('hinglish'), 'en-IN-PrabhatNeural');
  assert.equal(voiceForLang('hindi'), 'hi-IN-MadhurNeural');
  assert.equal(voiceForLang('hindi', 'hi-IN-SwaraNeural'), 'hi-IN-SwaraNeural');
});

test('lexicon fallback translates the fixed phrases', () => {
  const out = lexiconHinglish('Why it matters. The market fell today because investors waited.');
  assert.match(out, /yeh kyun zaroori hai/i);
  assert.match(out, /\baaj\b/);
  assert.match(out, /\bgira\b/);
  assert.match(out, /\bkyunki\b/);
  assert.equal(/\bthe\b/i.test(out), false);
});

test('rewriteNarration en is a passthrough', async () => {
  const input = scenes();
  const res = await rewriteNarration({ scenes: input, lang: 'en', settings: aiSettings });
  assert.equal(res.mode, 'en');
  assert.equal(res.scenes, input);
});

test('rewriteNarration hinglish: AI path replaces speech, keeps on-screen text', async () => {
  const input = scenes();
  const res = await rewriteNarration({
    scenes: input,
    lang: 'hinglish',
    settings: aiSettings,
    fetchImpl: mockFetchOk(),
  });
  assert.equal(res.mode, 'ai');
  assert.match(res.scenes[0].speech, /^HN: /);
  // on-screen text untouched
  assert.equal(res.scenes[0].text, input[0].text);
  // CTA comes from the per-language template, not the AI
  assert.equal(res.scenes[2].speech, CTA_SPEECH.hinglish);
  // narration consistency is the caller's job — scenes are independent here
});

test('rewriteNarration: AI failure falls back to the lexicon', async () => {
  const res = await rewriteNarration({
    scenes: scenes(),
    lang: 'hinglish',
    settings: aiSettings,
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(res.mode, 'lexicon');
  assert.equal(res.scenes[2].speech, CTA_SPEECH.hinglish);
  assert.notEqual(res.scenes[1].speech, '');
});

test('rewriteNarration: malformed AI reply falls back to the lexicon', async () => {
  const res = await rewriteNarration({
    scenes: scenes(),
    lang: 'hinglish',
    settings: aiSettings,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'sorry, no json here' } }] }),
    }),
  });
  assert.equal(res.mode, 'lexicon');
});

test('rewriteNarration: no key → lexicon directly (no network call)', async () => {
  let called = false;
  const res = await rewriteNarration({
    scenes: scenes(),
    lang: 'hinglish',
    settings: { ai: { enabled: true, baseUrl: 'https://example.invalid' } },
    fetchImpl: async () => {
      called = true;
      throw new Error('should not be called');
    },
  });
  assert.equal(called, false);
  assert.equal(res.mode, 'lexicon');
});

test('hindi CTA is Devanagari, hinglish CTA is romanized', () => {
  assert.match(CTA_SPEECH.hindi, /[\u0900-\u097F]/);
  assert.match(CTA_SPEECH.hinglish, /follow karo/);
  assert.match(CTA_SPEECH.en, /follow New Age Algos/);
});
