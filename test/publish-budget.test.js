import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from './helpers.js';
import { MemoryStore } from '../src/store/memory.js';
import { applyPublishBudget } from '../src/pipeline.js';

/**
 * Regression: 2026-10-06 09:17 IST — 12 events deferred by `outside_market_hours`
 * were all released by ONE market-check run: 12 Telegram messages in 22 seconds,
 * which also spent the whole dailyCap and left the channel silent for the day.
 *
 * shouldPublish() cannot prevent this: it scores every candidate against a single
 * store snapshot, and recordPublished() only runs later inside deliverEvents().
 * applyPublishBudget() re-applies the same rolling caps down the sorted list.
 */

const MIN = 60_000;

/** settings straight from config/settings.json, overridable per test. */
function settings(over = {}) {
  const cfg = testConfig();
  return {
    ...cfg.settings,
    publish: { ...cfg.settings.publish, ...(over.publish ?? {}) },
    scheduler: { ...cfg.settings.scheduler, ...(over.scheduler ?? {}) },
  };
}

/** n pending publish decisions, in the priority order the pipeline hands over. */
function decisions(n, priority = 'high') {
  return Array.from({ length: n }, (_, i) => ({
    event: { event_id: `evt_${i}`, title: `story ${i}` },
    verdict: { publication_priority: priority },
    publish: true,
    reason: 'ok',
  }));
}

test('backlog: one run can only spend one min_interval slot', () => {
  const store = new MemoryStore();
  const summary = { rejectReasons: {} };
  const now = new Date('2026-10-06T03:45:00Z'); // the 09:15 IST run

  const kept = applyPublishBudget(decisions(12), { store, settings: settings(), now, summary });

  assert.equal(kept.length, 1, 'a 12-event backlog must not become 12 messages');
  assert.equal(kept[0].event.event_id, 'evt_0', 'highest priority is kept first');
  assert.equal(summary.rejectReasons.min_interval, 11);
  assert.equal(summary.rejectReasons.hourly_cap ?? 0, 0);
  assert.equal(summary.rejectReasons.daily_cap ?? 0, 0);
});

test('deferred overflow is retried, never silently dropped', () => {
  const store = new MemoryStore();
  store.saveEvent({ event_id: 'evt_1', status: 'processed' });
  const now = new Date('2026-10-06T03:45:00Z');

  const kept = applyPublishBudget(decisions(3), { store, settings: settings(), now, summary: null });

  assert.equal(kept.length, 1);
  assert.equal(kept[0].event.event_id, 'evt_0');
  // 'deferred' is in TIMING_REASONS, so detectEvents re-queues it next run
  assert.equal(store.getEvent('evt_1').status, 'deferred', 'timing rejection must stay retryable');
});

test('decisions that miss the budget are mutated so the log reports the truth', () => {
  const store = new MemoryStore();
  const now = new Date('2026-10-06T03:45:00Z');
  const list = decisions(4);

  applyPublishBudget(list, { store, settings: settings(), now, summary: null });

  assert.equal(list[0].publish, true);
  assert.equal(list[0].reason, 'ok');
  for (const d of list.slice(1)) {
    assert.equal(d.publish, false);
    assert.equal(d.reason, 'min_interval');
  }
});

test('pacing across runs: one per run, three per hour, then the hour is full', () => {
  const store = new MemoryStore();
  const start = new Date('2026-10-06T03:45:00Z'); // 09:15 IST
  const keptPerRun = [];

  for (let run = 0; run < 5; run++) {
    const now = new Date(start.getTime() + run * 5 * MIN);
    const summary = { rejectReasons: {} };
    const kept = applyPublishBudget(decisions(3), { store, settings: settings(), now, summary });
    keptPerRun.push(kept.length);
    for (let i = 0; i < kept.length; i++) {
      store.recordPublished({ event_id: `pub_${run}_${i}`, published_at: now.toISOString() });
    }
  }

  assert.deepEqual(keptPerRun, [1, 1, 1, 0, 0], 'hourlyCap=3 must stop the fourth message');
  assert.equal(store.publishedCountSince(start.toISOString()), 3, 'exactly maxAlertsPerHour sent');
});

test('daily cap is preserved instead of being burned by a single burst', () => {
  const store = new MemoryStore();
  const now = new Date('2026-10-06T09:41:00Z'); // a later run the same day
  for (let i = 0; i < 12; i++) {
    store.recordPublished({ event_id: `done_${i}`, published_at: new Date(now.getTime() - 90 * MIN).toISOString() });
  }

  const summary = { rejectReasons: {} };
  const kept = applyPublishBudget(decisions(12), { store, settings: settings(), now, summary });

  assert.equal(kept.length, 0, 'dailyCap reached — nothing more today');
  assert.equal(summary.rejectReasons.daily_cap, 12);
});

test('with min_interval disabled the hourly cap is what still limits a burst', () => {
  const store = new MemoryStore();
  const now = new Date('2026-10-06T03:45:00Z');
  const cfg = settings({ publish: { minIntervalMinutes: 0 } });

  const summary = { rejectReasons: {} };
  const kept = applyPublishBudget(decisions(12), { store, settings: cfg, now, summary });

  assert.equal(kept.length, 3, 'maxAlertsPerHour=3 caps a burst even with spacing off');
  assert.equal(summary.rejectReasons.hourly_cap, 9);
});

test('hourly cap binds from the store even when nothing was sent this run', () => {
  const store = new MemoryStore();
  const now = new Date('2026-10-06T04:00:00Z');
  for (let i = 0; i < 3; i++) {
    store.recordPublished({ event_id: `h_${i}`, published_at: new Date(now.getTime() - 10 * MIN).toISOString() });
  }

  const summary = { rejectReasons: {} };
  const kept = applyPublishBudget(decisions(2), {
    store,
    settings: settings({ publish: { minIntervalMinutes: 0 } }),
    now,
    summary,
  });

  assert.equal(kept.length, 0);
  assert.equal(summary.rejectReasons.hourly_cap, 2);
});

test('a store with no published history never blocks the first message', () => {
  const store = new MemoryStore();
  const now = new Date('2026-10-06T03:45:00Z');
  const kept = applyPublishBudget(decisions(1), { store, settings: settings(), now, summary: null });
  assert.equal(kept.length, 1);
});

test('criticalAutoPublish lets a HIGH event through an otherwise full hour', () => {
  const store = new MemoryStore();
  const now = new Date('2026-10-06T04:00:00Z');
  store.recordPublished({ event_id: 'h_0', published_at: new Date(now.getTime() - 10 * MIN).toISOString() });

  const cfg = settings({ publish: { minIntervalMinutes: 0 }, scheduler: { criticalAutoPublish: true } });
  const kept = applyPublishBudget(decisions(1, 'high'), { store, settings: cfg, now, summary: null });
  assert.equal(kept.length, 1, 'must not contradict shouldPublish: critical HIGH bypasses hourly_cap');

  // …but a non-critical one is still stopped
  const blocked = applyPublishBudget(decisions(1, 'medium'), { store, settings: cfg, now, summary: null });
  assert.equal(blocked.length, 0);
});

test('scheduled briefing is exempt from the cooldown, like shouldPublish', () => {
  const store = new MemoryStore();
  const now = new Date('2026-10-06T04:00:00Z');
  store.recordPublished({ event_id: 'c_0', published_at: new Date(now.getTime() - 10 * MIN).toISOString() });
  const cfg = settings({ publish: { minIntervalMinutes: 0 } });

  const intraday = applyPublishBudget(decisions(1, 'medium'), { store, settings: cfg, now, summary: null });
  assert.equal(intraday.length, 0, 'cooldown still applies to an intraday medium event');

  const briefing = applyPublishBudget(decisions(1, 'medium'), {
    store,
    settings: cfg,
    now,
    summary: null,
    scheduledBriefing: true,
  });
  assert.equal(briefing.length, 1, 'pre-market/closing briefings skip the cooldown');
});

test('works without a store: no crash, and still one message per min_interval', () => {
  const now = new Date('2026-10-06T03:45:00Z');
  const kept = applyPublishBudget(decisions(4), { store: null, settings: settings(), now, summary: null });
  assert.equal(kept.length, 1, 'defaults still pace the output when there is no history');
  assert.deepEqual(kept.map((d) => d.event.event_id), ['evt_0']);
});
