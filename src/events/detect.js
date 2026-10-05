import { canonicalUrl } from '../dedupe/canonicalUrl.js';
import { isDuplicatePair } from '../dedupe/similarity.js';
import { contentHash, eventIdFor, newClusterId } from './hash.js';

/**
 * How long a 'deferred' story stays eligible for a retry.
 *
 * A timing rejection (outside_market_hours, min_interval, cooldown, caps) is
 * a "not now", and this bounds how long "now" may be: long enough to span the
 * 45 minutes a pre-open story waits for the 09:15 gate, or an hour of
 * cooldown. Beyond it the alert would be stale, so the story is retired — the
 * premarket/closing briefings still carry it from their own 48h/24h lookback.
 */
const DEFERRED_RETRY_MAX_AGE_MS = 6 * 3600_000;

function toPair(cluster) {
  return {
    title: cluster.canonical_title,
    description: '',
    category: cluster.category,
    companies: cluster.companies,
    sectors: cluster.sectors,
    institutions: cluster.institutions,
    _tokens: cluster.tokens,
    _numbers: cluster.numbers,
    _normTitle: (cluster.canonical_title || '').toLowerCase(),
  };
}

function mergeCluster(cluster, event, nowIso) {
  const uniq = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  cluster.tokens = uniq(cluster.tokens, event._tokens);
  cluster.companies = uniq(cluster.companies, event.companies);
  cluster.sectors = uniq(cluster.sectors, event.sectors);
  cluster.institutions = uniq(cluster.institutions, event.institutions);
  cluster.numbers = uniq(cluster.numbers, event._numbers);
  cluster.sources = uniq(cluster.sources, [event.source]);
  cluster.item_count = (cluster.item_count ?? 1) + 1;
  cluster.last_seen_at = nowIso;
  return cluster;
}

/**
 * EVENT DETECTION stage — compares each new article against stored events/clusters.
 * Statuses: NEW | UPDATED | DUPLICATE | KNOWN, plus RETRY for a stored event
 * that was only deferred on a timing condition and is being re-considered.
 * Only NEW and materially UPDATED proceed to publication analysis.
 */
export function detectEvents(articles, ctx) {
  const { store, settings, textOps, logger, now = new Date() } = ctx;
  const nowIso = now.toISOString();
  const since = new Date(now.getTime() - settings.dedupe.recentWindowHours * 3600_000).toISOString();
  const storedClusters = store.findRecentClusters(since);
  const workingClusters = [];
  const results = [];
  const stats = { NEW: 0, UPDATED: 0, DUPLICATE: 0, KNOWN: 0, RETRY: 0 };

  for (const article of articles) {
    const enriched = {
      ...article,
      _tokens: textOps.tokenize(article.title),
      _normTitle: textOps.normalizeTitle(article.title),
      _numbers: textOps.extractNumbers(`${article.title} ${article.description ?? ''}`),
    };
    const canon = canonicalUrl(article.url);
    const hash = contentHash(article);
    const event = {
      ...article,
      event_id: eventIdFor({ canonical_url: canon, source: article.source }),
      canonical_url: canon,
      content_hash: hash,
      institutions: article.institutions ?? [],
      detection_status: 'NEW',
      event_status: 'new',
      status: 'new',
      first_seen_at: article.detected_at ?? nowIso,
    };

    // 1) Already known (same URL or same story hash). Terminal unless the
    //    stored event is merely deferred on a timing condition.
    const known =
      store.getEventByContentHash(hash) || store.getEventByCanonicalUrl(canon);
    if (known) {
      if (known.status === 'deferred') {
        const firstSeen = Date.parse(known.first_seen_at ?? known.detected_at ?? nowIso);
        const ageMs = now.getTime() - firstSeen;
        if (Number.isFinite(firstSeen) && ageMs <= DEFERRED_RETRY_MAX_AGE_MS) {
          // Re-queue under its ORIGINAL detection status: shouldPublish() reads
          // event.detection_status to decide new-vs-not_new, so surfacing this
          // as 'KNOWN' would trip that gate and silently cancel the retry.
          const detection = known.detection_status === 'UPDATED' ? 'UPDATED' : 'NEW';
          event.detection_status = detection;
          event.event_id = known.event_id;
          event.cluster_id = known.cluster_id;
          event.event_status = known.event_status ?? 'new';
          // Carry the defer and the true first_seen across this run: pipeline
          // re-saves the event before the publish decision, and losing either
          // would either make the story terminal or restart its age clock.
          event.status = 'deferred';
          event.first_seen_at = known.first_seen_at ?? event.first_seen_at;
          stats.RETRY += 1;
          results.push({
            event,
            status: detection,
            clusterId: known.cluster_id ?? null,
            score: 1,
            reason: 'timing_retry',
          });
          continue;
        }
        // Aged out of the retry window: retire it so it stops being examined
        // on every subsequent run.
        store.updateEvent?.(known.event_id, { status: 'ignored' });
      }
      event.detection_status = 'KNOWN';
      event.event_id = known.event_id;
      event.cluster_id = known.cluster_id;
      event.event_status = known.event_status ?? 'known';
      stats.KNOWN += 1;
      results.push({ event, status: 'KNOWN', clusterId: known.cluster_id ?? null, score: 1, reason: 'seen_before' });
      continue;
    }

    // 2) Match against stored clusters + clusters formed in this batch
    let best = null;
    const candidates = [...storedClusters, ...workingClusters];
    for (const cluster of candidates) {
      const pair = toPair(cluster);
      const verdict = isDuplicatePair(enriched, pair, settings, textOps);
      if (verdict.match && (!best || verdict.combined > best.verdict.combined)) {
        best = { cluster, verdict };
      }
    }

    if (best) {
      const cluster = best.cluster;
      const novelTokens = textOps.newTokens(enriched._tokens, cluster.tokens ?? []);
      const novelEntities =
        (enriched.companies ?? []).filter((x) => !(cluster.companies ?? []).includes(x)).length +
        (enriched.sectors ?? []).filter((x) => !(cluster.sectors ?? []).includes(x)).length +
        (enriched.institutions ?? []).filter((x) => !(cluster.institutions ?? []).includes(x)).length;
      const novelNumbers = (enriched._numbers ?? []).filter((n) => !(cluster.numbers ?? []).includes(n)).length;
      const stageWords = textOps.stageWords ?? new Set();
      const novelStage = novelTokens.filter(
        (t) => stageWords.has(t) || [...stageWords].some((s) => t.startsWith(s))
      ).length;
      // A paraphrase is NOT an update. A materially UPDATED event must ADD FACTS:
      // new entities, new numbers, or an escalation of the development stage
      // (e.g. consider → approve / effective).
      const materiallyUpdated =
        novelTokens.length >= (settings.dedupe.materialNewTokenMin ?? 3) &&
        (novelEntities > 0 || novelNumbers > 0 || novelStage > 0);

      event.detection_status = materiallyUpdated ? 'UPDATED' : 'DUPLICATE';
      event.cluster_id = cluster.cluster_id;
      event.event_status = materiallyUpdated ? 'updated' : 'duplicate';
      stats[event.detection_status] += 1;

      mergeCluster(cluster, enriched, nowIso);
      // upsert: persists merges for both batch-local and already-stored clusters
      store.saveCluster(cluster);

      results.push({
        event,
        status: event.detection_status,
        clusterId: cluster.cluster_id,
        score: best.verdict.combined,
        reason: best.verdict.reason,
      });
      store.saveEvent(event);
      continue;
    }

    // 3) Brand-new event → open a new cluster
    const cluster = {
      cluster_id: newClusterId({
        tokens: enriched._tokens,
        institutions: enriched.institutions,
        category: enriched.category,
        publishedAt: enriched.published_at ?? nowIso,
      }),
      head_event_id: event.event_id,
      canonical_title: enriched.title,
      tokens: enriched._tokens,
      companies: enriched.companies,
      sectors: enriched.sectors,
      institutions: enriched.institutions,
      numbers: enriched._numbers,
      category: enriched.category,
      sources: [enriched.source],
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      item_count: 1,
      publish_status: 'unpublished',
      cooldown_until: null,
    };
    workingClusters.push(cluster);
    store.saveCluster(cluster);
    event.cluster_id = cluster.cluster_id;
    event.detection_status = 'NEW';
    event.event_status = 'new';
    stats.NEW += 1;
    store.saveEvent(event);
    results.push({ event, status: 'NEW', clusterId: cluster.cluster_id, score: 1, reason: 'no_match' });
  }

  logger?.info('EVENT_DETECT', `NEW=${stats.NEW} UPDATED=${stats.UPDATED} DUPLICATE=${stats.DUPLICATE} KNOWN=${stats.KNOWN} RETRY=${stats.RETRY}`, stats);
  return { results, stats, clusters: workingClusters };
}
