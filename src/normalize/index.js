import { normalizeArticle } from './normalizeArticle.js';

/**
 * NORMALIZE stage: provider items → { articles, snapshots, dropped }.
 * Articles are re-normalized defensively (inbox items may be loosely shaped);
 * snapshots pass through with minimal validation.
 */
export function normalizeItems(rawItems, ctx) {
  const { categorizer, extractor, logger, runId, now, mode, sourceRegistry } = ctx;
  const articles = [];
  const snapshots = [];
  let dropped = 0;

  for (const raw of rawItems || []) {
    if (raw?.kind === 'snapshot' || raw?._kind === 'snapshot') {
      const s = raw.snapshot ?? raw;
      if (s && typeof s.name === 'string' && typeof s.value === 'number') {
        snapshots.push({
          kind: 'snapshot',
          name: s.name,
          value: s.value,
          change: s.change ?? null,
          pct_change: s.pct_change ?? null,
          asof: s.asof ?? null,
          source: s.source ?? raw.source ?? 'unknown',
          extras: s.extras ?? {},
        });
      } else {
        dropped += 1;
      }
      continue;
    }

    const article = normalizeArticle(raw, {
      defaultSource: raw?.source,
      categorizer,
      extractor,
      tier: raw?.tier ?? raw?.trust_tier ?? 2,
      sourceType: raw?.source_type ?? 'media',
      sourceRegistry,
    });
    if (!article) {
      dropped += 1;
      continue;
    }
    articles.push({
      ...article,
      detected_at: (now ?? new Date()).toISOString(),
      run_id: runId,
      mode_scope: mode,
    });
  }

  logger?.info('NORMALIZE', `articles=${articles.length} snapshots=${snapshots.length} dropped=${dropped}`, {
    dropped,
  });
  return { articles, snapshots, dropped };
}
