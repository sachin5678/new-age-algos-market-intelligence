import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from './helpers.js';
import { buildSystemPrompt, buildUserPayload, defaultEventType, sourceTypeForEvent } from '../src/ai/prompt.js';

const sources = testConfig().sources;

test('system prompt enforces the analyst behaviour rules', () => {
  const p = buildSystemPrompt(sources);
  assert.ok(/objective Indian financial-market news analyst/i.test(p));
  assert.ok(/Tier 1/.test(p) && /Tier 4/.test(p), 'source hierarchy missing');
  assert.ok(/NEVER fabricate data, sources, quotations, prices, percentages/i.test(p));
  assert.ok(/never produce buy\/sell\/hold recommendations/i.test(p));
  assert.ok(/personalized financial advice/i.test(p));
  assert.ok(/financial guarantees/i.test(p));
  assert.ok(/Do not speculate/i.test(p));
  assert.ok(/sensational language/i.test(p));
  assert.ok(/CONFIRMED/i.test(p) && /REPORTED/i.test(p), 'confirmed vs reported distinction');
  assert.ok(/must NOT be treated as confirmed fact/i.test(p), 'tier 4 rule missing');
});

test('system prompt declares the full output schema', () => {
  const p = buildSystemPrompt(sources);
  for (const key of [
    'event_type',
    'headline',
    'summary',
    'facts',
    'market_relevance',
    'affected_sectors',
    'affected_stocks',
    'impact',
    'confidence',
    'source_type',
    'is_material',
    'publication_priority',
  ]) {
    assert.ok(p.includes(`"${key}"`), `missing output key: ${key}`);
  }
  assert.ok(p.includes('"official|reputable_media|other"') || p.includes('official|reputable_media|other'));
});

test('user payload carries source tier guidance but never the raw score', () => {
  const payload = buildUserPayload(
    {
      title: 'SEBI acts',
      description: 'd',
      source: 'Moneycontrol',
      trust_tier: 3,
      source_type: 'media',
      category: 'SEBI',
      importance_level: 'HIGH',
      importance: 100,
      companies: [],
      sectors: [],
      institutions: ['SEBI'],
    },
    { mode: 'intraday', snapshots: [{ name: 'NIFTY 50', value: 25000 }] }
  );
  assert.equal(payload.article.source_tier, 3);
  assert.ok(payload.article.source_tier_note.includes('not confirmed'));
  assert.equal(payload.classification.importance_level, 'HIGH');
  assert.ok(!JSON.stringify(payload).includes('"importance":'), 'raw score sent to model');
  assert.deepEqual(payload.market_context, ['NIFTY 50=25000']);
});

test('defaultEventType maps categories and sourceTypeForEvent maps tiers', () => {
  assert.equal(defaultEventType({ category: 'SEBI' }), 'regulatory');
  assert.equal(defaultEventType({ category: 'RBI' }), 'monetary_policy');
  assert.equal(defaultEventType({ category: 'RESULTS' }), 'earnings');
  assert.equal(defaultEventType({}), 'other');

  assert.equal(sourceTypeForEvent({ trust_tier: 1 }), 'official');
  assert.equal(sourceTypeForEvent({ trust_tier: 2 }), 'reputable_media');
  assert.equal(sourceTypeForEvent({ trust_tier: 4 }), 'other');
  assert.equal(sourceTypeForEvent({ source_type: 'official' }), 'official');
});
