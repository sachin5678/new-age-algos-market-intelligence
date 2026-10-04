const SEVERITY = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Compile config/importance.json into a classifier.
 * classify(event, ctx) → { level, score, matched:[{id,reason,weight}], factors }
 * Score is INTERNAL — never exposed to Telegram users.
 */
export function createImportanceEngine(importanceConfig) {
  const rules = (importanceConfig.rules || []).map((rule) => ({
    ...rule,
    regexes: (rule.patterns || []).map((p) => new RegExp(p, 'i')),
  }));
  const baseScores = importanceConfig.baseScores || { HIGH: 80, MEDIUM: 55, LOW: 25 };
  const boosts = importanceConfig.boosts || {};
  const penalties = importanceConfig.penalties || {};
  const defaultLevel = importanceConfig.defaultLevel || 'LOW';

  function classify(event, ctx = {}) {
    const text = `${event.title ?? ''} ${event.description ?? ''}`.trim();
    const matched = [];
    for (const rule of rules) {
      if (rule.regexes.some((re) => re.test(text))) {
        matched.push({ id: rule.id, reason: rule.reason, level: rule.level, weight: rule.weight ?? 0 });
      }
    }

    let level = defaultLevel;
    let best = SEVERITY[defaultLevel];
    for (const m of matched) {
      const sev = SEVERITY[m.level] ?? 1;
      if (sev > best) {
        best = sev;
        level = m.level;
      }
    }

    let score = baseScores[level] ?? 25;
    const factors = { base: score, ruleWeights: 0, boosts: {}, penalties: {} };

    for (const m of matched) {
      factors.ruleWeights += m.weight;
    }
    score += factors.ruleWeights;

    const official = event.source_type === 'official' || event.trust_tier === 1;
    if (official) {
      score += boosts.officialSource ?? 0;
      factors.boosts.officialSource = boosts.officialSource ?? 0;
    }
    const corroborated = (ctx.cluster?.item_count ?? 1) >= 2;
    if (corroborated) {
      score += boosts.corroborated ?? 0;
      factors.boosts.corroborated = boosts.corroborated ?? 0;
    }
    if (ctx.novel === true) {
      score += boosts.novel ?? 0;
      factors.boosts.novel = boosts.novel ?? 0;
    }
    if ((event.trust_tier ?? 2) >= 3) {
      score += penalties.tier3Source ?? 0;
      factors.penalties.tier3Source = penalties.tier3Source ?? 0;
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { level, score, matched, factors };
  }

  return { classify, defaultLevel, autoPublishLevels: importanceConfig.autoPublishLevels };
}
