import { runProviders } from './providers/base.js';
import { normalizeItems } from './normalize/index.js';
import { detectEvents } from './events/detect.js';
import { shouldPublish } from './publish/shouldPublish.js';
import { deliverEvents } from './telegram/deliver.js';
import { fallbackVerdict } from './ai/openaiService.js';

/** Reasons that are timing-related (event stays 'processed'), vs permanent rejections ('ignored'). */
// Rejections whose cause expires on its own — the gate reopens, the interval
// elapses, the rolling window frees a slot. They are deferrals, not verdicts,
// so they are recorded as 'deferred' and re-considered by detectEvents on a
// later run. Reasons outside this set are terminal: the event is 'ignored'.
// hourly_cap belongs here too: it resets every hour like daily_cap does.
const TIMING_REASONS = new Set([
  'min_interval',
  'cooldown',
  'daily_cap',
  'hourly_cap',
  'outside_market_hours',
]);

/**
 * Phase 1 core pipeline — every stage is a separate module, wired here only:
 *
 *   COLLECT → NORMALIZE → DEDUPE/EVENT_DETECT → CLASSIFY → AI_ANALYZE
 *           → PUBLISH_DECISION → TELEGRAM_SEND
 *
 * Deterministic stages own all decisions; OpenAI only produces the analysis verdict.
 * Returns a structured summary (no exceptions for per-item failures).
 */
export async function runPipeline({
  providers,
  settings,
  importance,
  textOps,
  categorizer,
  extractor,
  store,
  logger,
  ai,
  transport,
  mode = 'intraday',
  now = new Date(),
  runId = 'run',
  noAi = false,
  scheduledBriefing = false,
  holidays = [],
  sourceRegistry = null,
}) {
  const startedAt = now.toISOString();
  const summary = {
    runId,
    mode,
    startedAt,
    dryRun: Boolean(settings.dryRun),
    counts: {},
    stages: {},
    failures: [],
    rejectReasons: {},
    sent: [],
    sendFailures: [],
  };

  // ---------------------------------------------------------------- COLLECT
  const collected = await runProviders(providers, { logger, mode, now }, logger);
  summary.failures = collected.failures;
  summary.counts.collected = collected.items.length;
  summary.stages.COLLECT = { items: collected.items.length, providerFailures: collected.failures.length };

  // -------------------------------------------------------------- NORMALIZE
  const { articles, snapshots, dropped } = normalizeItems(collected.items, {
    categorizer,
    extractor,
    logger,
    runId,
    now,
    mode,
    sourceRegistry,
  });
  summary.counts.articles = articles.length;
  summary.counts.snapshots = snapshots.length;
  summary.counts.dropped = dropped;
  summary.stages.NORMALIZE = { articles: articles.length, snapshots: snapshots.length, dropped };

  // ------------------------------------------------- DEDUPE + EVENT_DETECT
  const detection = detectEvents(articles, { store, settings, textOps, logger, now });
  summary.counts.detection = detection.stats;
  summary.stages.DEDUPE = { ...detection.stats };

  // --------------------------------------------------------------- CLASSIFY
  const candidates = [];
  const levelCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of detection.results) {
    if (r.status === 'KNOWN') continue; // stored event keeps its own lifecycle state
    if (r.status !== 'NEW' && r.status !== 'UPDATED') {
      store.updateEvent?.(r.event.event_id, { status: 'ignored' });
      continue;
    }
    const cluster = store.getCluster(r.event.cluster_id ?? r.clusterId ?? null);
    const cls = importance.classify(r.event, { cluster, novel: r.status === 'NEW' });
    const event = {
      ...r.event,
      importance: cls.score,
      importance_level: cls.level,
      importance_factors: cls.factors,
    };
    store.saveEvent(event);
    levelCounts[cls.level] = (levelCounts[cls.level] ?? 0) + 1;
    candidates.push({ event, cluster, status: r.status });
  }
  summary.counts.candidates = candidates.length;
  summary.counts.levels = levelCounts;
  summary.stages.CLASSIFY = levelCounts;
  logger.info('CLASSIFY', `HIGH=${levelCounts.HIGH} MEDIUM=${levelCounts.MEDIUM} LOW=${levelCounts.LOW}`);

  // ------------------------------------------------------------- AI_ANALYZE
  const publishCfg = settings.publish ?? {};
  const autoLevels = publishCfg.autoPublishLevels ?? ['HIGH'];
  const aiLimit = settings.ai?.maxEventsPerRun ?? 20;
  let aiCalls = 0;
  let aiFallback = 0;
  let aiSkipped = 0;
  for (const c of candidates) {
    const wanted = autoLevels.includes(c.event.importance_level) || c.event.importance_level === 'MEDIUM';
    if (!wanted) {
      aiSkipped += 1;
      continue; // LOW never passes the deterministic gate — don't spend tokens
    }
    let verdict;
    if (noAi) {
      verdict = fallbackVerdict(c.event, 'disabled');
      aiFallback += 1;
    } else if (aiCalls >= aiLimit) {
      verdict = fallbackVerdict(c.event, 'max_events');
      aiFallback += 1;
    } else {
      verdict = await ai.analyze(c.event, { cluster: c.cluster, snapshots, mode, noAi });
      aiCalls += 1;
      if (verdict.analysis_source !== 'openai') aiFallback += 1;
    }
    c.event.ai_verdict = verdict;
    c.event.confidence = verdict.confidence;
    c.event.ai_summary = verdict.summary || null;
    store.saveEvent(c.event);
  }
  summary.stages.AI_ANALYZE = { analyzed: aiCalls, fallback: aiFallback, skipped: aiSkipped };
  logger.info('AI_ANALYZE', `analyzed=${aiCalls} fallback=${aiFallback} skipped=${aiSkipped}`);

  // -------------------------------------------------------- PUBLISH_DECISION
  const decisions = [];
  for (const c of candidates) {
    const d = shouldPublish(c.event, {
      settings,
      store,
      now,
      mode,
      cluster: c.cluster,
      holidays,
      scheduledBriefing,
    });
    decisions.push({
      event: c.event,
      verdict: c.event.ai_verdict ?? null,
      cluster: c.cluster,
      publish: d.publish,
      reason: d.reason,
      checks: d.checks,
    });
    if (!d.publish) {
      summary.rejectReasons[d.reason] = (summary.rejectReasons[d.reason] ?? 0) + 1;
      // 'deferred' means "revisit me": detectEvents re-queues exactly this
      // status. 'processed' stays reserved for terminal handling (cluster
      // de-duplication), and 'published'/'ignored' are never retried.
      const status = TIMING_REASONS.has(d.reason) ? 'deferred' : 'ignored';
      store.updateEvent?.(c.event.event_id, { status });
    }
  }
  const approved = decisions
    .filter((d) => d.publish)
    .sort((a, b) => {
      const rank = (d) => (d.verdict?.publication_priority === 'high' ? 2 : d.verdict?.publication_priority === 'medium' ? 1 : 0);
      return rank(b) - rank(a) || (b.event.importance ?? 0) - (a.event.importance ?? 0);
    });

  // One message per underlying story: keep only the best candidate per cluster.
  const seenClusters = new Set();
  const clustered = [];
  for (const d of approved) {
    const cid = d.event.cluster_id ?? d.event.event_id;
    if (seenClusters.has(cid)) {
      summary.rejectReasons.cluster_already_selected =
        (summary.rejectReasons.cluster_already_selected ?? 0) + 1;
      store.updateEvent?.(d.event.event_id, { status: 'processed' });
      continue;
    }
    seenClusters.add(cid);
    clustered.push(d);
  }

  // ------------------------------------------------------------- RATE BUDGET
  // shouldPublish() scores every candidate against ONE store snapshot and
  // nothing is recorded until deliverEvents() has already run, so the rolling
  // caps (daily / hourly / min_interval) all see the pre-run state and a
  // backlog passes them simultaneously. Observed live: 12 events deferred by
  // `outside_market_hours` were released together — 12 messages in 22s, which
  // also spent the whole `dailyCap` so the channel then went silent all day.
  // Re-apply the same caps down the already-priority-sorted list, simulating
  // each keep as if it had been recorded at this run's timestamp.
  const selected = applyPublishBudget(clustered, { store, settings, now, summary, scheduledBriefing });

  summary.decisions = decisions.map((d) => ({ event_id: d.event.event_id, publish: d.publish, reason: d.reason }));
  summary.counts.approved = selected.length;
  summary.counts.rejected = decisions.length - selected.length;
  summary.stages.PUBLISH_DECISION = {
    approved: selected.length,
    rejected: decisions.length - selected.length,
    reasons: summary.rejectReasons,
  };
  logger.info(
    'PUBLISH_DECISION',
    `approved=${selected.length} rejected=${decisions.length - selected.length}`,
    summary.rejectReasons
  );

  // ----------------------------------------------------------- TELEGRAM_SEND
  const delivery = await deliverEvents(selected, { store, transport, logger, mode, now });
  summary.sent = delivery.sent;
  summary.sendFailures = delivery.failed;
  summary.counts.published = delivery.sent.length;
  summary.counts.sendFailures = delivery.failed.length;
  summary.stages.TELEGRAM_SEND = { published: delivery.sent.length, failed: delivery.failed.length };
  summary.finishedAt = new Date().toISOString();
  summary.status = 'ok';

  logger.info(
    'PIPELINE',
    `done: collected=${summary.counts.collected} candidates=${candidates.length} published=${summary.counts.published}`
  );
  return summary;
}

/**
 * applyPublishBudget(list, { store, settings, now, summary }) — the rolling-cap
 * re-check that shouldPublish() cannot do on its own.
 *
 * shouldPublish() is called for every candidate against a single snapshot of
 * the store; recordPublished() only runs later, inside deliverEvents(). So a
 * backlog held back by a timing gate (e.g. `outside_market_hours` before the
 * 09:15 open) is released all at once: dailyCap / maxAlertsPerHour /
 * minIntervalMinutes all read the same stale counters and approve everything.
 *
 * Walks the already-priority-sorted selection and keeps only what fits, counting
 * each keep as if it had just been recorded at this run's timestamp — which is
 * exactly how recordPublished() stamps it. Overflow stays `deferred` (a timing
 * rejection) so a later run retries it instead of dropping the story, holding
 * the configured pacing: one message per min_interval, maxAlertsPerHour per
 * hour, dailyCap per day.
 *
 * Mutates the decisions it skips (publish/reason) so PUBLISH_DECISION reports
 * what was really sent. Returns the kept decisions, in order.
 */
export function applyPublishBudget(
  list,
  { store, settings = {}, now = new Date(), summary = null, scheduledBriefing = false } = {}) {
  const publishCfg = { ...settings.publish, ...settings.scheduler };
  const dailyCap = publishCfg.dailyCap ?? 12;
  const hourlyCap = publishCfg.maxAlertsPerHour ?? publishCfg.hourlyCap ?? 3;
  const minInterval = publishCfg.minIntervalMinutes ?? 5;
  const cooldown = publishCfg.cooldownMinutes ?? 60;
  const criticalAuto = publishCfg.criticalAutoPublish ?? false;

  const nowMs = now.getTime();
  let dailyUsed = store?.publishedCountSince?.(new Date(nowMs - 86_400_000).toISOString()) ?? 0;
  let hourlyUsed = store?.publishedCountSince?.(new Date(nowMs - 3_600_000).toISOString()) ?? 0;
  const lastIso = store?.lastPublishedAt?.() ?? null;
  let lastMs = lastIso ? Date.parse(lastIso) : NaN;

  const kept = [];
  for (const d of list) {
    // Same exemptions shouldPublish() grants, so this never contradicts it.
    const priority = d.verdict?.publication_priority ?? null;
    const critical = criticalAuto && priority === 'high';

    let reason = null;
    if (dailyUsed >= dailyCap) reason = 'daily_cap';
    else if (hourlyUsed >= hourlyCap && !critical) reason = 'hourly_cap';
    else if (Number.isFinite(lastMs)) {
      const elapsedMin = (nowMs - lastMs) / 60_000;
      if (elapsedMin < minInterval) reason = 'min_interval';
      else if (!scheduledBriefing && priority !== 'high' && elapsedMin < cooldown) reason = 'cooldown';
    }

    if (reason) {
      d.publish = false;
      d.reason = reason;
      if (summary) summary.rejectReasons[reason] = (summary.rejectReasons[reason] ?? 0) + 1;
      store?.updateEvent?.(d.event?.event_id, { status: 'deferred' });
      continue;
    }

    kept.push(d);
    dailyUsed += 1;
    hourlyUsed += 1;
    lastMs = nowMs; // one run's sends all carry the same timestamp
  }
  return kept;
}
