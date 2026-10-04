/**
 * Integration tests for the intraday monitoring engine — simulates the 8
 * required scenarios and verifies only appropriate alerts are sent.
 *
 * Run with:  node --test test/scheduler.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { createCategorizer } from '../src/normalize/categorize.js';
import { createEntityExtractor } from '../src/normalize/extractEntities.js';
import { createTextOps } from '../src/dedupe/text.js';
import { createImportanceEngine } from '../src/importance/classify.js';
import { createOpenAIService } from '../src/ai/openaiService.js';
import { createProviders } from '../src/providers/index.js';
import { runPipeline } from '../src/pipeline.js';
import { createSourceRegistry } from '../src/normalize/sources.js';
import { Provider } from '../src/providers/base.js';
import { nullLogger } from '../src/log/logger.js';
import { rssXml } from './helpers.js';

const CFG = loadConfig();
const LOG = nullLogger();

/** Build the standard test harness with an in-memory store and fake transport. */
function makeHarness(overrides = {}) {
  const settings = { ...CFG.settings, ...overrides.settings };
  if (overrides.hourlyCap !== undefined) {
    settings.publish = { ...settings.publish, hourlyCap: overrides.hourlyCap };
    settings.scheduler = { ...settings.scheduler, maxAlertsPerHour: overrides.hourlyCap };
  }
  if (overrides.holidays !== undefined) {
    settings.holidays = overrides.holidays;
  }
  if (overrides.marketHours !== undefined) {
    settings.marketHours = overrides.marketHours;
  }
  const store = new MemoryStore();
  const categorizer = createCategorizer(CFG.categories);
  const extractor = createEntityExtractor(CFG.entities);
  const textOps = createTextOps(CFG.text);
  const importance = createImportanceEngine(CFG.importance);
  const ai = createOpenAIService({ settings: CFG.settings, logger: LOG });
  const sourceRegistry = createSourceRegistry(CFG.sources);
  const transport = { name: 'fake', sent: [], async send(t) { this.sent.push({ text: t }); return { message_id: this.sent.length }; } };
  return { settings, store, categorizer, extractor, textOps, importance, ai, sourceRegistry, transport, logger: LOG };
}

/** Create a provider that returns the given articles on collect(). */
function fixtureProvider(articles) {
  class FixtureProvider extends Provider {
    constructor() { super({ name: 'fixture', kind: 'news' }); }
    async collect() { return articles; }
  }
  return new FixtureProvider();
}

/** Run pipeline once and return summary. Uses harness's shared transport. */
async function runOnce(harness, articles, { runId = 'test', mode = 'intraday', now = new Date() } = {}) {
  const providers = [fixtureProvider(articles)];
  const summary = await runPipeline({
    providers,
    settings: harness.settings,
    importance: harness.importance,
    textOps: harness.textOps,
    categorizer: harness.categorizer,
    extractor: harness.extractor,
    store: harness.store,
    logger: harness.logger,
    ai: harness.ai,
    transport: harness.transport,
    mode,
    now,
    runId,
    noAi: true,
    scheduledBriefing: false,
    sourceRegistry: harness.sourceRegistry,
    holidays: harness.settings.holidays,
  });
  return summary;
}

// -----------------------------------------------------------------------------
// SCENARIOS
// -----------------------------------------------------------------------------

const BASE = {
  url: 'https://nseindia.com/circular/sebi-fo-limits',
  source: 'NSE',
  source_type: 'official',
  trust_tier: 1,
  category: 'SEBI',
  published_at: new Date().toISOString(),
};

// A fixed weekday within market hours (Friday 09:30 IST) — NOT a holiday
const MARKET_NOW = new Date('2026-10-09T04:00:00Z');

const HOLIDAYS = CFG.holidays;

test('1) New SEBI official event → ALERT sent', async () => {
  const h = makeHarness();
  await runOnce(h, [{
    ...BASE,
    title: 'SEBI announces F&O position limits revised for retail traders',
    description: 'The regulator has cut index position limits from 500 to 300 contracts.',
  }], { now: MARKET_NOW });
  assert.equal(h.transport.sent.length, 1, 'exactly one alert for new SEBI event');
  assert.ok(h.transport.sent[0].text.includes('Confirmed — NSE'));
  assert.ok(h.transport.sent[0].text.includes('🚨 <b>MARKET ALERT</b>'));
});

test('2) Duplicate news article (same URL) → NO alert', async () => {
  const h = makeHarness();
  await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/sebi-fo-limits-v2',
    title: 'SEBI announces new F&O margin framework',
    description: 'The regulator has notified a revised margin framework for derivatives.',
  }], { runId: 'run1', now: MARKET_NOW });

  const summary = await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/sebi-fo-limits-v2',
    title: 'SEBI announces new F&O margin framework',
    description: 'The regulator has notified a revised margin framework for derivatives.',
  }], { runId: 'run2', now: MARKET_NOW });
  assert.equal(summary.counts.approved, 0);
  assert.equal(summary.counts.detection.KNOWN, 1);
  assert.equal(h.transport.sent.length, 1, 'no duplicate alert');
});

test('3) Same event from another source → NO duplicate alert (cluster dedupe)', async () => {
  const h = makeHarness();
  await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/sebi-fo-limits-3',
    title: 'SEBI tightens F&O position limits',
    description: 'The regulator has tightened position limits for index derivatives.',
  }], { runId: 'run1', now: MARKET_NOW });

  const summary = await runOnce(h, [{
    ...BASE,
    source: 'Livemint',
    source_type: 'media',
    trust_tier: 2,
    url: 'https://livemint.com/market/sebi-fo-tightening',
    title: 'SEBI tightens F&O position limits for retail',
    description: 'The regulator has tightened position limits for index derivatives, reports Livemint.',
  }], { runId: 'run2', now: MARKET_NOW });
  assert.equal(summary.counts.approved, 0, 'should be DUPLICATE not NEW');
  assert.equal(summary.counts.detection.DUPLICATE, 1);
  // Transport count stays at 1 (from first run)
  assert.equal(h.transport.sent.length, 1, 'no second alert for same underlying event');
});

test('4) Material update (SEBI considers → SEBI announces) → NEW alert', async () => {
  const h = makeHarness({ settings: { publish: { minIntervalMinutes: 0, cooldownMinutes: 0 } } });
  await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/sebi-considers',
    title: 'SEBI considering tighter F&O position limits',
    description: 'The regulator is weighing new position limits for retail traders.',
  }], { runId: 'run1', now: MARKET_NOW });

  const summary = await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/sebi-announces',
    title: 'SEBI announces tighter F&O position limits effective June 1',
    description: 'The regulator has cut index position limits from 500 to 300 contracts, effective June 1, 2026.',
  }], { runId: 'run2', now: MARKET_NOW });

  assert.equal(summary.counts.detection.UPDATED, 1, 'should detect as UPDATED');
  assert.equal(h.transport.sent.length, 2, 'material update triggers new alert');
});

test('5) Low-importance article (analyst opinion) → NO alert', async () => {
  const h = makeHarness();
  const summary = await runOnce(h, [{
    ...BASE,
    source: 'Moneycontrol',
    source_type: 'media',
    trust_tier: 3,
    title: 'Analysts say Nifty may hit 26,000 by year end',
    description: 'Brokerage firms remain bullish on the index.',
    category: 'MARKET',
  }], { now: MARKET_NOW });
  assert.equal(summary.counts.approved, 0);
  assert.equal(summary.rejectReasons.importance_level, 1);
  assert.equal(h.transport.sent.length, 0);
});

test('6) Three DIFFERENT HIGH events within one hour → only MAX_ALERTS_PER_HOUR (3) allowed', async () => {
  const h = makeHarness({ hourlyCap: 3, settings: { publish: { minIntervalMinutes: 0, cooldownMinutes: 0 }, scheduler: { criticalAutoPublish: false } } });
  const baseNow = new Date('2026-10-09T04:00:00Z'); // Friday 09:30 IST (not a holiday)

  // Event 1: SEBI F&O rule change
  await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/fo-rule-change',
    title: 'SEBI announces F&O position limits revised',
    description: 'The regulator has notified new position limits for index derivatives.',
  }], { runId: 'run1', now: new Date(baseNow.getTime() + 1 * 60000) });

  // Event 2: RBI rate cut (matches rbi-policy HIGH rule)
  await runOnce(h, [{
    ...BASE,
    url: 'https://rbi.org.in/scripts/rbi-circular-2',
    title: 'RBI cuts repo rate by 25 bps to 6.25%',
    description: 'The monetary policy committee reduced the policy repo rate.',
    category: 'RBI',
  }], { runId: 'run2', now: new Date(baseNow.getTime() + 2 * 60000) });

  // Event 3: Government tax cut (matches govt-market-policy HIGH rule)
  await runOnce(h, [{
    ...BASE,
    url: 'https://pib.gov.in/newsite/printrelease-3',
    title: 'Govt cuts capital gains tax on equities',
    description: 'Finance ministry slashes LTCG tax rate for equity investors.',
    category: 'MACRO',
  }], { runId: 'run3', now: new Date(baseNow.getTime() + 3 * 60000) });

  assert.equal(h.transport.sent.length, 3, 'first 3 different HIGH events allowed');

  // 4th HIGH event in same hour → rejected by hourly cap (different topic: market disruption)
  const summary4 = await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/market-disruption',
    title: 'SEBI halts derivatives trading amid extreme volatility',
    description: 'The regulator has suspended F&O trading for the session due to extreme volatility.',
    category: 'SEBI',
  }], { runId: 'run4', now: new Date(baseNow.getTime() + 4 * 60000) });
  assert.equal(summary4.counts.approved, 0, '4th rejected');
  assert.equal(summary4.rejectReasons.hourly_cap, 1, 'rejected due to hourly cap');
  assert.equal(h.transport.sent.length, 3, 'still only 3 sent');
});

test('7) Market holiday (2026-01-26 Republic Day) → NO intraday alerts', async () => {
  const h = makeHarness({ holidays: HOLIDAYS });
  const holiday = new Date('2026-01-26T04:00:00Z'); // 09:30 IST on Republic Day
  const summary = await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/holiday-test',
    title: 'SEBI issues circular on market trading holiday',
    description: 'The regulator has notified a trading holiday for Republic Day.',
  }], { runId: 'holiday', now: holiday });
  assert.equal(summary.counts.approved, 0);
  assert.equal(summary.rejectReasons.outside_market_hours, 1, 'rejected outside market hours on holiday');
});

test('8) Outside market hours (08:00 IST pre-market) → NO intraday alerts', async () => {
  const h = makeHarness({ holidays: HOLIDAYS });
  const preMarket = new Date('2026-10-05T02:30:00Z'); // 08:00 IST
  const summary = await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/outside-hours',
    title: 'SEBI issues circular on new F&O margin norms',
    description: 'The regulator has notified revised margin requirements.',
  }], { runId: 'outside', now: preMarket });
  assert.equal(summary.counts.approved, 0);
  assert.equal(summary.rejectReasons.outside_market_hours, 1, 'rejected outside market hours');
});

// -----------------------------------------------------------------------------
// Additional: Critical HIGH event bypasses hourly cap (when criticalAutoPublish=true)
// -----------------------------------------------------------------------------

test('Critical HIGH event bypasses hourly cap when criticalAutoPublish=true', async () => {
  const h = makeHarness({ hourlyCap: 1, settings: { publish: { minIntervalMinutes: 0, cooldownMinutes: 0 }, scheduler: { criticalAutoPublish: true } } });
  const now = new Date('2026-10-09T04:00:00Z');
  const BASE = { url: 'https://nseindia.com/circular/fo-rule-change', source: 'NSE', source_type: 'official', trust_tier: 1, category: 'SEBI', published_at: new Date().toISOString() };

  // First event fills the hourly cap
  await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/critical-1',
    title: 'SEBI announces F&O position limits revised',
    description: 'The regulator has notified new position limits for index derivatives.',
  }], { runId: 'run1', now: new Date(now.getTime() + 1 * 60000) });
  assert.equal(h.transport.sent.length, 1);

  // Second HIGH event with criticalAutoPublish=true should bypass hourly cap
  const summary2 = await runOnce(h, [{
    ...BASE,
    url: 'https://nseindia.com/circular/critical-2',
    title: 'SEBI halts derivatives trading amid extreme volatility',
    description: 'The regulator has suspended F&O trading for the session due to extreme volatility.',
  }], { runId: 'run2', now: new Date(now.getTime() + 2 * 60000) });
  assert.equal(summary2.counts.approved, 1, 'critical event bypasses hourly cap');
  assert.equal(h.transport.sent.length, 2);
});