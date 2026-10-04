import { decodeEntities } from '../normalize/normalizeArticle.js';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text operations for dedup: normalized titles, token sets (stopwords removed,
 * synonyms mapped, naively stemmed), numbers, and conflict detection
 * (antonym pairs / differing numbers = different underlying events).
 */
export function createTextOps(textConfig) {
  const stopwords = new Set(textConfig.stopwords || []);
  const synonyms = Object.entries(textConfig.synonyms || {});
  const synonymPhrases = synonyms.filter(([k]) => k.includes(' ')).sort((a, b) => b[0].length - a[0].length);
  const synonymWords = new Map(synonyms.filter(([k]) => !k.includes(' ')));
  const antonymPairs = (textConfig.antonymPairs || []).map(([a, b]) => [a.toLowerCase(), b.toLowerCase()]);
  const stageWords = new Set((textConfig.stageEscalation || []).map((w) => w.toLowerCase()));
  const minLength = textConfig.minTokenLength ?? 2;
  const synonymPhraseRes = synonymPhrases.map(([phrase, repl]) => ({
    re: new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'gi'),
    repl,
  }));

  function normalizeTitle(title = '') {
    let s = decodeEntities(String(title)).toLowerCase();
    s = s.replace(/&/g, ' fo ').replace(/[^a-z0-9\s]/g, ' ');
    for (const { re, repl } of synonymPhraseRes) s = s.replace(re, ` ${repl} `);
    return s.replace(/\s+/g, ' ').trim();
  }

  function stem(token) {
    if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
  }

  function tokenize(title = '') {
    const norm = normalizeTitle(title);
    const out = new Set();
    for (const raw of norm.split(' ')) {
      if (!raw || raw.length < minLength) continue;
      if (stopwords.has(raw)) continue;
      const mapped = synonymWords.get(raw) ?? raw;
      if (!mapped || stopwords.has(mapped)) continue;
      out.add(stem(mapped));
    }
    return [...out];
  }

  function extractNumbers(text = '') {
    return [...new Set((String(text).match(/\d+(?:[.,]\d+)?%?/g) || []).map((n) => n.replace(/,/g, '')))];
  }

  function hasConflict(tokensA, tokensB, numbersA = [], numbersB = []) {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    for (const [x, y] of antonymPairs) {
      if ((setA.has(x) && setB.has(y)) || (setA.has(y) && setB.has(x))) return true;
    }
    if (numbersA.length && numbersB.length) {
      const inter = numbersA.filter((n) => numbersB.includes(n));
      if (inter.length === 0) return true;
    }
    return false;
  }

  function newTokens(tokens, against = []) {
    const set = new Set(against);
    return tokens.filter((t) => !set.has(t));
  }

  return { normalizeTitle, tokenize, extractNumbers, hasConflict, newTokens, stem, stageWords };
}
