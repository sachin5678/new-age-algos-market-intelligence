/**
 * Similarity scoring for deduplication.
 *   combined = TITLE_W * titleSim + ENTITY_W * entityScore + CAT_W * categoryCompat
 * Conflict (antonym/differing numbers) always wins: conflicting items are never duplicates.
 */

export const TITLE_W = 0.55;
export const ENTITY_W = 0.3;
export const CAT_W = 0.15;

export function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

function trigrams(s = '') {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length < 3) return t ? [t] : [];
  const out = [];
  for (let i = 0; i <= t.length - 3; i += 1) out.push(t.slice(i, i + 3));
  return out;
}

/** Token + character-trigram similarity of two normalized titles. */
export function titleSimilarity(tokensA, tokensB, normTitleA, normTitleB) {
  return Math.max(jaccard(tokensA, tokensB), jaccard(trigrams(normTitleA), trigrams(normTitleB)));
}

function overlap(listA = [], listB = []) {
  if (!listA.length || !listB.length) return 0;
  const setB = new Set(listB);
  const inter = listA.filter((x) => setB.has(x)).length;
  return inter / Math.min(listA.length, listB.length);
}

/** Highest entity agreement across companies / sectors / institutions. */
export function entityScore(a = {}, b = {}) {
  return Math.max(
    overlap(a.companies, b.companies),
    overlap(a.sectors, b.sectors),
    overlap(a.institutions, b.institutions)
  );
}

export function categoryCompat(catA, catB, categoryGroups = []) {
  if (catA === catB) return 1;
  for (const group of categoryGroups) {
    if (group.includes(catA) && group.includes(catB)) return 0.8;
  }
  return 0.2;
}

export function combinedScore({ titleSim, entitiesA, entitiesB, categoryA, categoryB, categoryGroups }) {
  const e = entityScore(entitiesA, entitiesB);
  const c = categoryCompat(categoryA, categoryB, categoryGroups);
  return {
    titleSim,
    entityScore: e,
    categoryScore: c,
    combined: TITLE_W * titleSim + ENTITY_W * e + CAT_W * c,
  };
}

/**
 * Decide whether two items represent the same underlying development.
 * Returns { match, score, titleSim, reason }.
 */
export function isDuplicatePair(a, b, settings, textOps) {
  const tokensA = a._tokens ?? textOps.tokenize(a.title);
  const tokensB = b._tokens ?? textOps.tokenize(b.title);
  const normA = a._normTitle ?? textOps.normalizeTitle(a.title);
  const normB = b._normTitle ?? textOps.normalizeTitle(b.title);
  const numbersA = a._numbers ?? textOps.extractNumbers(`${a.title} ${a.description ?? ''}`);
  const numbersB = b._numbers ?? textOps.extractNumbers(`${b.title} ${b.description ?? ''}`);

  if (textOps.hasConflict(tokensA, tokensB, numbersA, numbersB)) {
    return { match: false, score: 0, titleSim: 0, reason: 'conflict' };
  }

  const titleSim = titleSimilarity(tokensA, tokensB, normA, normB);
  const score = combinedScore({
    titleSim,
    entitiesA: a,
    entitiesB: b,
    categoryA: a.category,
    categoryB: b.category,
    categoryGroups: settings.dedupe.categoryGroups,
  });

  const d = settings.dedupe;
  if (score.titleSim >= d.titleOnlyThreshold) {
    return { match: true, ...score, reason: 'title' };
  }
  if (
    score.combined >= d.combinedThreshold &&
    score.titleSim >= d.entityTitleMin &&
    score.entityScore > 0
  ) {
    return { match: true, ...score, reason: 'combined' };
  }
  return { match: false, ...score, reason: 'below_threshold' };
}
