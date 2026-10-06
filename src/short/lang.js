/**
 * Language support — Hinglish / Hindi voiceovers (free).
 *
 * On-screen scene text always stays English (fast to read, standard for
 * Indian finance Shorts); what changes is the SPOKEN narration, which flows
 * into edge-tts and therefore into the burned captions automatically.
 *
 * Rewrite paths, in order of preference:
 *   1. AI   — the repo's free Gemini tier (settings.ai) rewrites each
 *             scene's narration into natural Hinglish / Hindi. Zero cost.
 *   2. Lexicon — deterministic word/phrase map when no key is configured.
 *             Rougher, but always works offline.
 *
 * CTA and "why it matters" are template lines per language (no AI needed).
 * Recap narration (recap.js) is fully template-based per language as well.
 */

import fs from 'node:fs';

const MSG_TIMEOUT_MS = 30_000;

export const LANGS = Object.freeze({
  en: Object.freeze({ id: 'en', label: 'English', voice: 'en-IN-NeerjaNeural' }),
  hinglish: Object.freeze({ id: 'hinglish', label: 'Hinglish', voice: 'en-IN-PrabhatNeural' }),
  hindi: Object.freeze({ id: 'hindi', label: 'Hindi', voice: 'hi-IN-MadhurNeural' }),
});

export function normalizeLang(value) {
  const v = String(value ?? 'en').toLowerCase();
  if (['en', 'eng', 'english'].includes(v)) return 'en';
  if (['hi', 'hn', 'hinglish', 'hing'].includes(v)) return 'hinglish';
  if (['hin', 'hindi', 'devanagari'].includes(v)) return 'hindi';
  throw new Error(`unknown language "${value}" — use en | hinglish | hindi`);
}

/** Default edge-tts voice per language (explicit --voice still wins). */
export function voiceForLang(lang, explicit = null) {
  if (explicit) return explicit;
  return LANGS[normalizeLang(lang)]?.voice ?? LANGS.en.voice;
}

/** Per-language spoken CTA (on-screen CTA text stays English). */
export const CTA_SPEECH = Object.freeze({
  en: 'For more market shorts, follow New Age Algos.',
  hinglish: 'Aise hi market shorts ke liye, New Age Algos ko follow karo.',
  hindi: 'ऐसे ही मार्केट शॉर्ट्स के लिए, न्यू एज एल्गोस को फॉलो करो।',
});

/** Deterministic fallback: phrase-level Hinglish map + light cleanup. */
const LEXICON = [
  [/why it matters\.?/gi, 'yeh kyun zaroori hai'],
  [/\btoday\b/gi, 'aaj'],
  [/\btomorrow\b/gi, 'kal'],
  [/\bthis week\b/gi, 'is hafte'],
  [/\bnext week\b/gi, 'agle hafte'],
  [/\bthis month\b/gi, 'is mahine'],
  [/\bfell\b/gi, 'gira'],
  [/\bfalls?\b/gi, 'girta hai'],
  [/\bfalling\b/gi, 'gir raha hai'],
  [/\brose\b/gi, 'chadha'],
  [/\brises?\b/gi, 'badhta hai'],
  [/\brising\b/gi, 'badh raha hai'],
  [/\bsays\b/gi, 'kehta hai'],
  [/\bsaid\b/gi, 'kaha'],
  [/\bbecause\b/gi, 'kyunki'],
  [/\bbut\b/gi, 'lekin'],
  [/\band\b/gi, 'aur'],
  [/\bwith\b/gi, 'ke saath'],
  [/\bfor\b/gi, 'ke liye'],
  [/\bahead of\b/gi, 'se pehle'],
  [/\binvestors\b/gi, 'investors'],
  [/\bshares\b/gi, 'shares'],
  [/\bbond yields?\b/gi, 'bond yields'],
  [/\bthe\b|\ban\b/gi, ''],
  [/\ba\b/gi, ''],
];

/** Rough offline Hinglish transform (only used when no AI key exists). */
export function lexiconHinglish(text) {
  let out = String(text ?? '');
  for (const [re, to] of LEXICON) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}

function hasAiKey(settings) {
  const ai = settings?.ai;
  if (!ai) return false;
  if (ai.apiKey) return true;
  if (ai.apiKeyFile) {
    try {
      return fs.existsSync(ai.apiKeyFile);
    } catch {
      return false;
    }
  }
  return false;
}

async function readAiKey(settings) {
  if (settings.ai.apiKey) return settings.ai.apiKey.trim();
  if (settings.ai.apiKeyFile) {
    if (fs.existsSync(settings.ai.apiKeyFile)) {
      return fs.readFileSync(settings.ai.apiKeyFile, 'utf8').trim();
    }
  }
  return null;
}

function parseJsonArray(content) {
  let raw = String(content ?? '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in AI reply');
  const arr = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new Error('AI reply is not an array of non-empty strings');
  }
  return arr.map((x) => x.trim());
}

/** Free Gemini tier (OpenAI-compatible) rewrite of narration lines. */
export async function aiRewrite(texts, { lang, settings, fetchImpl = fetch }) {
  const key = await readAiKey(settings);
  if (!key) throw new Error('no AI key configured');
  const base = String(settings.ai?.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const target =
    lang === 'hindi'
      ? 'Hindi in Devanagari script, natural spoken register'
      : 'Hinglish (Romanized Hindi–English code-mix, the way Indian creators actually speak)';

  const system =
    `You rewrite YouTube Short voiceover lines into ${target}. Rules: ` +
    'keep numbers, percentages, currency amounts, and names such as Nifty, Sensex, RBI, SEBI, NSE and company names exactly as given; ' +
    'one line per input, same count as input, same order; ' +
    'conversational and punchy, fit for a 45-second short; ' +
    'output ONLY a JSON array of strings, no markdown, no commentary.';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.ai?.timeoutMs ?? MSG_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: settings.ai.model,
        temperature: 0.7,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(texts) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const out = parseJsonArray(content);
    if (out.length !== texts.length) {
      throw new Error(`AI returned ${out.length} lines, expected ${texts.length}`);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rewrite a built short's SPOKEN narration for the target language.
 * On-screen `text` fields are intentionally untouched (English visuals).
 *
 * @param {{scenes: Array}} short   from buildShort()/buildRecapShort()
 * @param {'en'|'hinglish'|'hindi'} lang
 * @returns {{scenes: Array, mode: 'en'|'ai'|'lexicon'}}
 */
export async function rewriteNarration({ scenes, lang = 'en', settings = null, fetchImpl = fetch }) {
  const target = normalizeLang(lang);
  if (target === 'en') return { scenes, mode: 'en' };

  const out = scenes.map((s) => ({ ...s }));
  const rewriteIdx = [];
  out.forEach((s, i) => {
    if (s.kind !== 'cta') rewriteIdx.push(i);
  });

  let mode = 'lexicon';
  let lines = null;
  const texts = rewriteIdx.map((i) => out[i].speech);

  if (settings && settings.ai?.enabled !== false && hasAiKey(settings)) {
    try {
      lines = await aiRewrite(texts, { lang: target, settings, fetchImpl });
      mode = 'ai';
    } catch {
      lines = null; // fall back to the offline lexicon
    }
  }
  if (!lines) lines = texts.map((t) => lexiconHinglish(t));

  rewriteIdx.forEach((i, k) => {
    out[i].speech = lines[k];
  });
  const ctaIdx = out.findIndex((s) => s.kind === 'cta');
  if (ctaIdx >= 0) out[ctaIdx].speech = CTA_SPEECH[target];

  return { scenes: out, mode };
}
