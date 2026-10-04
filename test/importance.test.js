import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from './helpers.js';
import { createImportanceEngine } from '../src/importance/classify.js';

const cfg = testConfig();
const engine = createImportanceEngine(cfg.importance);

test('SEBI rule/regulation change classifies HIGH', () => {
  const r = engine.classify({ title: 'SEBI tightens F&O position limits for retail traders', description: '' });
  assert.equal(r.level, 'HIGH');
  assert.ok(r.matched.some((m) => m.id === 'sebi-action'));
  assert.ok(r.score >= cfg.importance.baseScores.HIGH);
});

test('RBI policy change classifies HIGH', () => {
  const r = engine.classify({ title: 'RBI cuts repo rate by 25 bps to 5.50 percent', description: '' });
  assert.equal(r.level, 'HIGH');
  assert.ok(r.matched.some((m) => m.id === 'rbi-policy'));
});

test('F&O rule change classifies HIGH', () => {
  const r = engine.classify({ title: 'Exchange changes F&O position limit rules for index futures', description: '' });
  assert.equal(r.level, 'HIGH');
  assert.ok(r.matched.some((m) => m.id === 'fo-rule-change'));
});

test('sector development classifies MEDIUM', () => {
  const r = engine.classify({ title: 'IT sector gets boost from new government digital push', description: '' });
  assert.equal(r.level, 'MEDIUM');
  assert.ok(r.matched.some((m) => m.id === 'sector-impact'));
  assert.ok(r.score >= cfg.importance.baseScores.MEDIUM);
});

test('analyst commentary classifies LOW with a suppressed score', () => {
  const r = engine.classify({ title: 'Brokerages say Reliance target price may rise to 3200', description: '' });
  assert.equal(r.level, 'LOW');
  assert.ok(r.matched.some((m) => m.id === 'analyst-opinion'));
  assert.ok(r.score < cfg.importance.baseScores.LOW, `expected score below base LOW, got ${r.score}`);
});

test('unmatched news falls back to the configured default level', () => {
  const r = engine.classify({ title: 'A rainbow of colours on a quiet street', description: '' });
  assert.equal(r.level, cfg.importance.defaultLevel);
  assert.equal(r.matched.length, 0);
  assert.equal(r.score, cfg.importance.baseScores[cfg.importance.defaultLevel]);
});

test('official source earns the configured boost', () => {
  const base = { title: 'IT sector gets boost from new government digital push', description: '' };
  const media = engine.classify({ ...base, source_type: 'media', trust_tier: 2 });
  const official = engine.classify({ ...base, source_type: 'official', trust_tier: 1 });
  assert.equal(official.level, media.level);
  assert.equal(official.score, media.score + cfg.importance.boosts.officialSource);
});

test('score is clamped to 0..100 and factors are recorded internally', () => {
  const heavy = engine.classify({
    title: 'SEBI issues circular on F&O limit changes as RBI policy, GDP data and budget proposals roll in',
    description: '',
  });
  assert.ok(heavy.score <= 100, `score must clamp, got ${heavy.score}`);
  assert.equal(heavy.level, 'HIGH');
  assert.ok(heavy.matched.length >= 2);
  assert.ok(heavy.factors && typeof heavy.factors === 'object');
  assert.ok('base' in heavy.factors);
});

test('score never goes negative for heavily penalized items', () => {
  const r = engine.classify({ title: 'Analysts give a sell call with target price and outlook', description: '' });
  assert.ok(r.score >= 0);
});

test('stock-tip / opinion headlines never classify HIGH (regex hygiene regression)', () => {
  const cases = [
    {
      title:
        "Sumeet Bagadia's top 3 stocks to buy: HDFC Life, Cummins India, CG Power | Target, stoploss, Nifty, Bank Nifty outlook",
      description:
        'Stock market outlook: Historically, in 2008, Nifty declined for seven consecutive weeks before witnessing a five-week positive move.',
    },
    {
      title: "Vaishali Parekh's top 3 stocks to buy: HDFC Bank, NRB Bearings, Lalithaa Jewellery | Target, stoploss",
      description: 'The analyst shared the targets and stoploss levels for the three counters.',
    },
    {
      title: 'Brokers expect banks to hold rates as economy steadies',
      description: 'Strategy desks say the path is balanced.',
    },
  ];
  for (const c of cases) {
    const r = engine.classify(c);
    assert.notEqual(r.level, 'HIGH', `opinion piece classified HIGH: ${c.title}`);
  }
});

test('word boundaries: "Bank ... before" must not trigger the F&O rule', () => {
  const r = engine.classify({
    title: 'Bank Nifty outlook before the festive season',
    description: 'Traders await cues before the weekly expiry.',
  });
  assert.ok(!r.matched.some((m) => m.id === 'fo-rule-change'), 'fo-rule-change false positive');
  assert.notEqual(r.level, 'HIGH');
});
