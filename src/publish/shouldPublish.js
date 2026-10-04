/** Market-hours helpers in IST (Asia/Kolkata) — no dependency on machine timezone. */

function partsIn(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

export function isWithinMarketHours(now, marketHours, holidays = []) {
  const { timezone = 'Asia/Kolkata', start = '09:15', end = '15:30', weekdaysOnly = true } = marketHours;
  const p = partsIn(now, timezone);
  if (weekdaysOnly && (p.weekday === 'Sat' || p.weekday === 'Sun')) return false;
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  if (holidays.includes(dateStr)) return false;
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return minutes >= sh * 60 + sm && minutes <= eh * 60 + em;
}

function reject(reason, checks, detail = {}) {
  return { publish: false, reason, checks: { ...checks, ...detail } };
}

/**
 * shouldPublish(event) — the single publication gate.
 *
 * Considers, in order: new? duplicate? already published? importance level?
 * AI materiality? verification? market hours (or scheduled briefing)? caps/cooldowns?
 *
 * Returns { publish: boolean, reason: string, checks: object }.
 * Reasons starting with "not_" or "unverified"/"importance" are permanent for this event;
 * "min_interval"/"cooldown"/"daily_cap"/"outside_market_hours" are timing rejections.
 */
export function shouldPublish(event, ctx = {}) {
  const settings = ctx.settings ?? {};
  const publishCfg = { ...settings.publish, ...settings.scheduler };
  const now = ctx.now ?? new Date();
  const checks = {};

  const detection = event.detection_status ?? 'NEW';
  if (detection === 'DUPLICATE') return reject('duplicate', checks, { detection });
  if (detection !== 'NEW' && detection !== 'UPDATED') {
    return reject('not_new', checks, { detection });
  }

  const store = ctx.store;
  const cluster = ctx.cluster ?? (store && event.cluster_id ? store.getCluster(event.cluster_id) : null);
  const isMaterialUpdate = detection === 'UPDATED';
  if (store && event.cluster_id && !isMaterialUpdate) {
    if (store.isClusterPublished(event.cluster_id)) {
      return reject('already_published', checks, { cluster_id: event.cluster_id });
    }
  }
  checks.published = false;

  const levels = publishCfg.autoPublishLevels ?? ['HIGH'];
  const level = event.importance_level ?? 'LOW';
  if (!levels.includes(level)) {
    return reject('importance_level', checks, { level });
  }

  const verdict = event.ai_verdict ?? null;
  if (verdict && verdict.is_material === false) {
    return reject('not_material', checks, { priority: verdict.publication_priority });
  }

  if (publishCfg.requireVerification !== false) {
    const official = event.source_type === 'official' || event.trust_tier === 1;
    const corroborated = (cluster?.item_count ?? 1) >= 2;
    const confidence = event.confidence ?? verdict?.confidence ?? 'low';
    if (!official && !corroborated && confidence === 'low') {
      return reject('unverified', checks, { confidence });
    }
    checks.verified = true;
  }

  const scheduledBriefing = ctx.scheduledBriefing === true || ctx.mode === 'premarket' || ctx.mode === 'closing';
  checks.scheduledBriefing = Boolean(scheduledBriefing);

  if (!scheduledBriefing && !isWithinMarketHours(now, settings.marketHours ?? {}, ctx.holidays ?? [])) {
    return reject('outside_market_hours', checks);
  }

  const store2 = ctx.store;
  if (store2) {
    const dailyCap = publishCfg.dailyCap ?? 12;
    const hourlyCap = publishCfg.maxAlertsPerHour ?? publishCfg.hourlyCap ?? 3;
    const sinceIso = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const sinceHourIso = new Date(now.getTime() - 3600_000).toISOString();
    const count = store2.publishedCountSince(sinceIso);
    if (count >= dailyCap) return reject('daily_cap', checks, { count, dailyCap });
    const hourlyCount = store2.publishedCountSince(sinceHourIso);
    if (hourlyCount >= hourlyCap) {
      const criticalAuto = publishCfg.criticalAutoPublish ?? false;
      if (!(criticalAuto && verdict?.publication_priority === 'high')) {
        return reject('hourly_cap', checks, { count: hourlyCount, hourlyCap });
      }
    }

    const last = store2.lastPublishedAt();
    if (last) {
      const minInterval = publishCfg.minIntervalMinutes ?? 5;
      const elapsedMin = (now.getTime() - Date.parse(last)) / 60000;
      if (elapsedMin < minInterval) {
        return reject('min_interval', checks, { elapsedMin: Math.round(elapsedMin), minInterval });
      }
      const cooldown = publishCfg.cooldownMinutes ?? 60;
      if (!scheduledBriefing && verdict?.publication_priority !== 'high' && elapsedMin < cooldown) {
        return reject('cooldown', checks, { elapsedMin: Math.round(elapsedMin), cooldown });
      }
    }
    checks.caps = true;
  }

  return { publish: true, reason: 'ok', checks };
}
