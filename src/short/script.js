/**
 * Short script builder — Market → Short factory stage 1.
 *
 * Turns one market event + its AI verdict into a 45-second short script:
 * an ordered list of scenes (hook → facts → why-it-matters → CTA) where
 * every scene carries BOTH:
 *   - text  — punchy on-screen copy rendered into the 1080×1920 scene PNG, and
 *   - speech — the spoken sentence(s) fed to edge-tts.
 *
 * Keeping text/speech paired per scene is what lets the word timings from the
 * TTS subtitle track be mapped back to exact scene boundaries later
 * (voice.js → matchSegments).
 *
 * Deterministic by design: no AI call happens here. The pipeline already
 * stores an ai_verdict on each event; callers may pass any verdict-shaped
 * object (including the offline fallback verdict).
 */

const MAX_FACTS = 3;
const DEFAULT_HANDLE = '@newageAlgos';
export const DEFAULT_HASHTAGS = [
  '#nifty',
  '#stockmarket',
  '#indianstockmarket',
  '#trading',
  '#newagealgos',
];

/** Clip to n chars on a word boundary; append an ellipsis when clipped. */
export function clip(value, n) {
  const s = String(value ?? '').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\-–—.\s]+$/, '')}…`;
}

/** Make a fragment a spoken sentence (TTS pauses on the full stop). */
export function sentence(value) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

/**
 * Build the short script.
 *
 * @param {object} args
 * @param {object} args.event   normalized store event (title, url, category, …)
 * @param {object} args.verdict AI/rules verdict: headline, facts[],
 *                              market_relevance, summary, impact
 * @param {string} [args.handle] channel handle for the CTA scene
 * @returns {{
 *   title: string, description: string, hashtags: string[],
 *   impact: string, category: string, handle: string,
 *   scenes: Array<{kind: 'hook'|'fact'|'why'|'cta', text: string, speech: string}>,
 *   narration: string
 * }}
 */
export function buildShort({ event = {}, verdict = {}, handle = DEFAULT_HANDLE } = {}) {
  const v = verdict ?? {};
  const headline = clip(v.headline || event.title || 'Market update', 200);
  const facts = (Array.isArray(v.facts) ? v.facts : [])
    .map((f) => String(f ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_FACTS);
  const relevance = String(v.market_relevance ?? '').trim();
  const summary = String(v.summary ?? event.description ?? '').trim();

  const scenes = [
    {
      kind: 'hook',
      text: clip(headline, 110),
      speech: sentence(headline),
    },
    ...facts.map((f, i) => ({
      kind: 'fact',
      n: i + 1,
      of: facts.length,
      text: clip(f, 150),
      speech: sentence(f),
    })),
    ...(relevance
      ? [
          {
            kind: 'why',
            text: clip(relevance, 170),
            speech: `Why it matters. ${sentence(relevance)}`,
          },
        ]
      : []),
    {
      kind: 'cta',
      text: `FOLLOW ${handle}`,
      speech: 'For more market shorts, follow New Age Algos.',
    },
  ].filter((s) => s.speech);

  const narration = scenes
    .map((s) => s.speech)
    .filter(Boolean)
    .join(' ');

  const title = `${clip(headline, 88)} #Shorts`;
  const description = [
    summary,
    relevance,
    '',
    DEFAULT_HASHTAGS.join(' '),
    event.url ? `Source: ${event.url}` : '',
  ]
    .filter((line, i, arr) => line !== '' || arr[i - 1] !== '')
    .join('\n')
    .trim();

  return {
    title: clip(title, 100),
    description,
    hashtags: [...DEFAULT_HASHTAGS],
    impact: v.impact ?? 'unclear',
    category: event.category ?? '',
    importance: event.importance_level ?? '',
    handle,
    source: event.source ?? '',
    scenes,
    narration,
  };
}
