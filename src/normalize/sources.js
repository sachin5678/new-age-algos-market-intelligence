/**
 * Source hierarchy registry — maps source names to trust tiers (1-4) per
 * config/sources.json:
 *   1 = official / primary (NSE, BSE, SEBI, RBI, Government, exchange filings)
 *   2 = major reputable financial media
 *   3 = other reputable financial publications
 *   4 = social media / commentary (never confirmed fact)
 *
 * Matching is case-insensitive: exact name, alias, then containment.
 * Unmatched sources get `defaultTier` with matched:false so callers can fall
 * back to feed-declared tiers.
 */
export function createSourceRegistry(cfg = {}) {
  const defaultTier = Number(cfg.defaultTier ?? 3);
  const tiers = cfg.tiers ?? {};
  const aliases = cfg.aliases ?? {};

  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

  // lookup: normalized source name -> { tier, canonical, official, matched }
  const lookup = new Map();
  for (const [tierStr, def] of Object.entries(tiers)) {
    const tier = Number(tierStr);
    for (const name of def?.sources ?? []) {
      lookup.set(norm(name), { tier, canonical: name, official: tier === 1, matched: true });
    }
  }
  for (const [alias, target] of Object.entries(aliases)) {
    const resolved = lookup.get(norm(target));
    if (resolved) lookup.set(norm(alias), resolved);
  }

  function resolve(name = '') {
    const key = norm(name);
    if (!key) return { tier: defaultTier, canonical: name, official: false, matched: false };

    const hit = lookup.get(key);
    if (hit) return hit;

    // containment match (longest registry name wins), guard against tiny keys
    let best = null;
    if (key.length > 3) {
      for (const [k, v] of lookup) {
        if ((key.includes(k) || k.includes(key)) && (!best || k.length > best.k.length)) {
          best = { k, v };
        }
      }
    }
    if (best) return best.v;

    return { tier: defaultTier, canonical: name, official: false, matched: false };
  }

  return {
    resolve,
    defaultTier,
    /** Hierarchy rendered for the AI system prompt. */
    describe() {
      return Object.entries(tiers)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([tier, def]) => `Tier ${tier} — ${def?.label ?? ''}: ${def?.description ?? ''}`)
        .join('\n');
    },
  };
}
