import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from './helpers.js';
import { createSourceRegistry } from '../src/normalize/sources.js';
import { normalizeArticle } from '../src/normalize/normalizeArticle.js';

const registry = createSourceRegistry(testConfig().sources);

test('tier 1 official sources resolve with official flag', () => {
  assert.deepEqual(
    { tier: registry.resolve('NSE').tier, official: registry.resolve('NSE').official },
    { tier: 1, official: true }
  );
  assert.equal(registry.resolve('sebi').tier, 1);
  assert.equal(registry.resolve('RBI').tier, 1);
  assert.equal(registry.resolve('Ministry of Finance').official, true);
});

test('tier 2 / tier 3 media resolve per the hierarchy', () => {
  assert.equal(registry.resolve('Reuters').tier, 2);
  assert.equal(registry.resolve('Livemint').tier, 2);
  assert.equal(registry.resolve('Economic Times').tier, 2);
  assert.equal(registry.resolve('Moneycontrol').tier, 3);
  assert.equal(registry.resolve('Moneycontrol').official, false);
});

test('tier 4 commentary resolves and is never official', () => {
  const r = registry.resolve('Twitter');
  assert.equal(r.tier, 4);
  assert.equal(r.official, false);
});

test('alias and containment matching, unknown → default with matched:false', () => {
  assert.equal(registry.resolve('ET').tier, 2); // alias
  assert.equal(registry.resolve('The Economic Times').tier, 2); // containment
  const unknown = registry.resolve('RandomBlog');
  assert.equal(unknown.tier, registry.defaultTier);
  assert.equal(unknown.matched, false);
});

test('normalizeArticle: registry overrides feed tier; unmatched falls back to feed tier', () => {
  const base = { title: 'Story', url: 'https://x.test/a' };

  const nse = normalizeArticle(
    { ...base, source: 'NSE', tier: 2 },
    { sourceRegistry: registry }
  );
  assert.equal(nse.trust_tier, 1, 'registry must win on match');
  assert.equal(nse.source_type, 'official');

  const unknown = normalizeArticle(
    { ...base, source: 'RandomBlog', tier: 2 },
    { sourceRegistry: registry }
  );
  assert.equal(unknown.trust_tier, 2, 'feed tier kept when registry has no match');
  assert.equal(unknown.source_type, 'media');

  const noRegistry = normalizeArticle({ ...base, source: 'NSE', tier: 2 }, {});
  assert.equal(noRegistry.trust_tier, 2, 'no registry → feed tier unchanged');
});

test('registry.describe renders the hierarchy for the AI prompt', () => {
  const d = registry.describe();
  assert.ok(d.includes('Tier 1'));
  assert.ok(d.includes('Tier 4'));
});
