import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, art } from './helpers.js';
import { canonicalUrl } from '../src/dedupe/canonicalUrl.js';
import { createTextOps } from '../src/dedupe/text.js';
import { isDuplicatePair, titleSimilarity, combinedScore } from '../src/dedupe/similarity.js';

const cfg = testConfig();
const textOps = createTextOps(cfg.text);
const settings = cfg.settings;

test('canonicalUrl strips tracking params, www, case and trailing slash', () => {
  assert.equal(
    canonicalUrl('https://WWW.Example.com/a/b/?utm_source=x&b=2&a=1#frag'),
    'https://example.com/a/b?a=1&b=2'
  );
  assert.equal(canonicalUrl('https://example.com/story/'), 'https://example.com/story');
  assert.equal(canonicalUrl('https://example.com/story?fbclid=abc&utm_medium=rss'), 'https://example.com/story');
  assert.equal(canonicalUrl('https://example.com/story?id=1'), 'https://example.com/story?id=1');
});

test('SEBI paraphrases A/B (different wording) are treated as one event', () => {
  const a = art({ title: 'SEBI considers new F&O limits', category: 'SEBI', institutions: ['SEBI'] });
  const b = art({ title: 'SEBI may change derivatives position limits', category: 'SEBI', institutions: ['SEBI'] });
  const v = isDuplicatePair(b, a, settings, textOps);
  assert.equal(v.match, true, `expected match, got ${JSON.stringify(v)}`);
  assert.ok(v.combined >= settings.dedupe.combinedThreshold);
  assert.ok(v.entityScore > 0);
});

test('conflicting direction or numbers are never duplicates', () => {
  const cut = art({ title: 'RBI cuts repo rate by 25 bps', category: 'RBI', institutions: ['RBI'] });
  const hold = art({ title: 'RBI holds repo rate unchanged', category: 'RBI', institutions: ['RBI'] });
  const cutVsHold = isDuplicatePair(cut, hold, settings, textOps);
  assert.equal(cutVsHold.match, false);
  assert.equal(cutVsHold.reason, 'conflict');

  const up = art({ title: 'Sensex rises 1 percent in volatile trade', category: 'MARKET' });
  const down = art({ title: 'Sensex falls 1 percent in volatile trade', category: 'MARKET' });
  assert.equal(isDuplicatePair(up, down, settings, textOps).match, false);

  const n1 = art({ title: 'Nifty ends at 24,000', category: 'MARKET' });
  const n2 = art({ title: 'Nifty ends at 24,500', category: 'MARKET' });
  assert.equal(isDuplicatePair(n1, n2, settings, textOps).match, false);
});

test('identical titles match on the title-only threshold', () => {
  const a = art({ title: 'SEBI raises F&O limit for index futures', category: 'SEBI' });
  const b = art({ title: 'SEBI raises F&O limit for index futures', category: 'SEBI' });
  const v = isDuplicatePair(a, b, settings, textOps);
  assert.equal(v.match, true);
  assert.equal(v.reason, 'title');
});

test('genuinely different stories do not match', () => {
  const a = art({
    title: 'Tata Motors Q2 profit jumps 50 percent',
    category: 'RESULTS',
    companies: ['TATAMOTORS'],
  });
  const b = art({
    title: 'Infosys wins large banking deal in Europe',
    category: 'STOCK',
    companies: ['INFY'],
    sectors: ['IT', 'BANKING'],
  });
  assert.equal(isDuplicatePair(a, b, settings, textOps).match, false);
});

test('title similarity is symmetric and bounded', () => {
  const ta = textOps.tokenize('SEBI considers new F&O limits');
  const tb = textOps.tokenize('SEBI may change derivatives position limits');
  const na = textOps.normalizeTitle('SEBI considers new F&O limits');
  const nb = textOps.normalizeTitle('SEBI may change derivatives position limits');
  const ab = titleSimilarity(ta, tb, na, nb);
  const ba = titleSimilarity(tb, ta, nb, na);
  assert.ok(Math.abs(ab - ba) < 1e-9);
  assert.ok(ab >= 0 && ab <= 1);
  assert.equal(titleSimilarity(ta, ta, na, na), 1);
});

test('combinedScore weights title, entities and category', () => {
  const s = combinedScore({
    titleSim: 0.5,
    entitiesA: { companies: [], sectors: [], institutions: ['SEBI'] },
    entitiesB: { companies: [], sectors: [], institutions: ['SEBI'] },
    categoryA: 'SEBI',
    categoryB: 'SEBI',
    categoryGroups: settings.dedupe.categoryGroups,
  });
  assert.ok(Math.abs(s.combined - (0.55 * 0.5 + 0.3 * 1 + 0.15 * 1)) < 1e-9);
  assert.equal(s.categoryScore, 1);
});

test('textOps conflict detection works on antonyms and numbers', () => {
  assert.equal(
    textOps.hasConflict(['rbi', 'cut'], ['rbi', 'hold'], [], []),
    true
  );
  assert.equal(
    textOps.hasConflict(['rbi', 'cut'], ['rbi', 'cut'], ['25'], ['25']),
    false
  );
  assert.equal(
    textOps.hasConflict(['nifty'], ['nifty'], ['24000'], ['24500']),
    true
  );
});
