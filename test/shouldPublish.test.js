import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, IN_HOURS, AFTER_HOURS } from './helpers.js';
import { MemoryStore } from '../src/store/memory.js';
import { shouldPublish, isWithinMarketHours } from '../src/publish/shouldPublish.js';

const cfg = testConfig();
const settings = cfg.settings;

function makeStore({ item_count = 1, published = [] } = {}) {
  const store = new MemoryStore();
  store.saveCluster({
    cluster_id: 'clu_t',
    head_event_id: 'evt_t',
    canonical_title: 'SEBI considers new F&O limits',
    tokens: ['sebi', 'fo', 'limit'],
    companies: [],
    sectors: [],
    institutions: ['SEBI'],
    numbers: [],
    category: 'SEBI',
    sources: ['Moneycontrol'],
    first_seen_at: IN_HOURS.toISOString(),
    last_seen_at: IN_HOURS.toISOString(),
    item_count,
    publish_status: 'unpublished',
    cooldown_until: null,
  });
  for (const p of published) store.recordPublished({ event_id: 'other', cluster_id: 'clu_other', ...p });
  return store;
}

function ev(over = {}) {
  return {
    event_id: 'evt_t',
    cluster_id: 'clu_t',
    detection_status: 'NEW',
    importance_level: 'HIGH',
    source_type: 'media',
    trust_tier: 2,
    confidence: 'medium',
    category: 'SEBI',
    ai_verdict: { is_material: true, publication_priority: 'high', confidence: 'medium' },
    ...over,
  };
}

function decide(event, { store = makeStore(), now = IN_HOURS, mode = 'intraday', scheduledBriefing = false } = {}) {
  return shouldPublish(event, { settings, store, now, mode, scheduledBriefing });
}

test('NEW HIGH verified event inside market hours publishes', () => {
  const d = decide(ev());
  assert.equal(d.publish, true, `expected publish, got ${d.reason}`);
  assert.equal(d.reason, 'ok');
});

test('KNOWN / DUPLICATE / UPDATED-gated events are rejected', () => {
  assert.equal(decide(ev({ detection_status: 'KNOWN' })).reason, 'not_new');
  assert.equal(decide(ev({ detection_status: 'DUPLICATE' })).reason, 'duplicate');
  // materially UPDATED events are allowed through
  assert.equal(decide(ev({ detection_status: 'UPDATED' })).publish, true);
});

test('already-published cluster is not re-published', () => {
  const store = makeStore({ published: [{ cluster_id: 'clu_t', published_at: IN_HOURS.toISOString() }] });
  const d = decide(ev(), { store });
  assert.equal(d.publish, false);
  assert.equal(d.reason, 'already_published');
});

test('only configured importance levels auto-publish', () => {
  assert.equal(decide(ev({ importance_level: 'MEDIUM' })).reason, 'importance_level');
  assert.equal(decide(ev({ importance_level: 'LOW' })).reason, 'importance_level');
  assert.ok((settings.publish.autoPublishLevels ?? []).includes('HIGH'));
});

test('AI verdict can veto a non-material event', () => {
  const d = decide(ev({ ai_verdict: { is_material: false, publication_priority: 'low', confidence: 'medium' } }));
  assert.equal(d.publish, false);
  assert.equal(d.reason, 'not_material');
});

test('unverified single-source low-confidence events are held', () => {
  const d = decide(ev({ confidence: 'low', ai_verdict: { is_material: true, publication_priority: 'high', confidence: 'low' } }));
  assert.equal(d.publish, false);
  assert.equal(d.reason, 'unverified');
});

test('corroborated coverage counts as verified', () => {
  const store = makeStore({ item_count: 2 });
  const d = decide(ev({ confidence: 'low' }), { store });
  assert.equal(d.publish, true, `expected publish via corroboration, got ${d.reason}`);
});

test('official source counts as verified', () => {
  const d = decide(ev({ source_type: 'official', trust_tier: 1, confidence: 'low' }));
  assert.equal(d.publish, true, `expected publish via official source, got ${d.reason}`);
});

test('outside market hours is rejected unless scheduled briefing', () => {
  const outside = decide(ev(), { now: AFTER_HOURS });
  assert.equal(outside.publish, false);
  assert.equal(outside.reason, 'outside_market_hours');

  const briefing = decide(ev(), { now: AFTER_HOURS, scheduledBriefing: true });
  assert.equal(briefing.publish, true, `briefing should bypass hours, got ${briefing.reason}`);
  assert.equal(briefing.checks.scheduledBriefing, true);
});

test('weekend is never within market hours', () => {
  // Sat 03 Oct 2026 11:00 IST = 05:30 UTC
  const sat = new Date('2026-10-03T05:30:00Z');
  assert.equal(isWithinMarketHours(sat, settings.marketHours), false);
  // Mon 05 Oct 2026 09:30 IST = 04:00 UTC
  const mon = new Date('2026-10-05T04:00:00Z');
  assert.equal(isWithinMarketHours(mon, settings.marketHours), true);
});

test('holidays block market-hours publishing', () => {
  const d = shouldPublish(ev(), {
    settings,
    store: makeStore(),
    now: IN_HOURS,
    mode: 'intraday',
    holidays: ['2026-10-02'],
  });
  assert.equal(d.publish, false);
  assert.equal(d.reason, 'outside_market_hours');
});

test('daily cap and minimum interval are enforced', () => {
  const full = Array.from({ length: settings.publish.dailyCap }, () => ({
    cluster_id: 'clu_other',
    published_at: new Date(IN_HOURS.getTime() - 2 * 3600_000).toISOString(),
  }));
  const capped = decide(ev(), { store: makeStore({ published: full }) });
  assert.equal(capped.publish, false);
  assert.equal(capped.reason, 'daily_cap');

  const recent = makeStore({
    published: [{ cluster_id: 'clu_other', published_at: new Date(IN_HOURS.getTime() - 60_000).toISOString() }],
  });
  const interval = decide(ev(), { store: recent });
  assert.equal(interval.publish, false);
  assert.equal(interval.reason, 'min_interval');
});

test('cooldown applies to medium priority but not high priority', () => {
  const store = makeStore({
    published: [{ cluster_id: 'clu_other', published_at: new Date(IN_HOURS.getTime() - 10 * 60_000).toISOString() }],
  });
  const med = decide(ev({ ai_verdict: { is_material: true, publication_priority: 'medium', confidence: 'medium' } }), { store });
  assert.equal(med.publish, false);
  assert.equal(med.reason, 'cooldown');

  const high = decide(ev({ ai_verdict: { is_material: true, publication_priority: 'high', confidence: 'medium' } }), { store });
  assert.equal(high.publish, true, `high priority should bypass cooldown, got ${high.reason}`);
});
