import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, IN_HOURS, FakeTransport, rssXml, stubFetch } from './helpers.js';
import { MemoryStore } from '../src/store/memory.js';
import { SqliteStore } from '../src/store/sqlite.js';
import { nullLogger } from '../src/log/logger.js';
import { createCategorizer } from '../src/normalize/categorize.js';
import { createEntityExtractor } from '../src/normalize/extractEntities.js';
import { createTextOps } from '../src/dedupe/text.js';
import { createImportanceEngine } from '../src/importance/classify.js';
import { createOpenAIService } from '../src/ai/openaiService.js';
import { createProviders } from '../src/providers/index.js';
import { Provider } from '../src/providers/base.js';
import { runPipeline } from '../src/pipeline.js';

class BoomProvider extends Provider {
  constructor() {
    super({ name: 'boom', kind: 'official' });
  }

  async collect() {
    throw new Error('provider exploded');
  }
}

function build() {
  const cfg = testConfig();
  cfg.settings.ai.enabled = false; // offline: rules-only verdicts
  const logger = nullLogger();
  const store = new MemoryStore();
  const categorizer = createCategorizer(cfg.categories);
  const extractor = createEntityExtractor(cfg.entities);
  const textOps = createTextOps(cfg.text);
  const importance = createImportanceEngine(cfg.importance);
  const ai = createOpenAIService({ settings: cfg.settings, logger });
  const transport = new FakeTransport();

  const feeds = [
    { source: 'Moneycontrol', kind: 'news', url: 'https://mc.test/rss', tier: 2, enabled: true },
    { source: 'Livemint', kind: 'news', url: 'https://lm.test/rss', tier: 2, enabled: true },
    { source: 'DeadFeed', kind: 'news', url: 'https://dead.test/rss', tier: 2, enabled: true },
  ];
  const fetchImpl = stubFetch({
    'https://mc.test/rss': rssXml([
      {
        title: 'SEBI considers new F&O limits for retail traders',
        url: 'https://mc.test/a',
        description: 'The regulator is weighing tighter position limits.',
      },
      {
        title: 'Brokerages see Nifty hitting 25,000 by December',
        url: 'https://mc.test/b',
        description: 'Analysts say the rally may continue.',
      },
    ]),
    'https://lm.test/rss': rssXml([
      {
        title: 'SEBI may change derivatives position limits for retail players',
        url: 'https://lm.test/c',
        description: 'A decision could come this week.',
      },
    ]),
  });

  const providers = createProviders({
    settings: cfg.settings,
    feeds,
    officialSources: [],
    categorizer,
    extractor,
    fetchImpl,
  });
  providers.push(new BoomProvider());

  const opts = {
    providers,
    settings: cfg.settings,
    importance,
    textOps,
    categorizer,
    extractor,
    store,
    logger,
    ai,
    transport,
    mode: 'intraday',
    now: IN_HOURS,
  };
  return { cfg, opts, store, transport };
}

test('pipeline end-to-end: dedupes to exactly one alert; re-run is a no-op', async () => {
  const { opts, transport, store } = build();

  // ---------------------------------------------------------------- run 1
  const s1 = await runPipeline({ ...opts, runId: 'run_1' });

  assert.equal(s1.status, 'ok');
  assert.equal(s1.counts.collected, 3);
  assert.equal(s1.failures.length, 1, 'failing provider must be reported');
  assert.equal(s1.failures[0].provider, 'boom');
  assert.equal(s1.counts.dropped, 0);

  // dedup: story A + paraphrase B → one cluster; analyst story separate
  assert.equal(s1.counts.detection.NEW, 2);
  assert.equal(s1.counts.detection.DUPLICATE, 1);
  assert.equal(s1.counts.detection.UPDATED, 0);
  assert.equal(s1.counts.detection.KNOWN, 0);

  assert.equal(s1.counts.candidates, 2);
  assert.equal(s1.counts.levels.HIGH, 1);
  assert.equal(s1.counts.levels.LOW, 1);
  assert.equal(s1.counts.approved, 1);
  assert.equal(s1.counts.rejected, 1);
  assert.equal(s1.rejectReasons.importance_level, 1);

  // exactly ONE Telegram message for the two-article event
  assert.equal(transport.sent.length, 1, 'same underlying event must yield one message');
  const msg = transport.sent[0].text;
  assert.ok(msg.includes('🚨 <b>MARKET ALERT</b>'));
  assert.ok(msg.includes('Moneycontrol'), 'source shown');
  assert.ok(msg.includes('<b>⚠️ Status:</b>'), 'status line missing');
  assert.ok(!msg.includes('importance'), 'internal classification leaked');
  assert.ok(!/\b100\b/.test(msg), 'raw score leaked');

  // structured stage record present for every required stage
  for (const stage of ['COLLECT', 'NORMALIZE', 'DEDUPE', 'CLASSIFY', 'AI_ANALYZE', 'PUBLISH_DECISION', 'TELEGRAM_SEND']) {
    assert.ok(s1.stages[stage], `missing stage record: ${stage}`);
  }
  assert.equal(s1.stages.TELEGRAM_SEND.published, 1);
  assert.equal(s1.stages.AI_ANALYZE.fallback, 1);

  // persisted lifecycle states
  const dup = store.getEventByCanonicalUrl('https://lm.test/c');
  assert.equal(dup.detection_status, 'DUPLICATE');
  assert.equal(dup.status, 'ignored');
  const low = store.getEventByCanonicalUrl('https://mc.test/b');
  assert.equal(low.status, 'ignored');
  const head = store.getEventByCanonicalUrl('https://mc.test/a');
  assert.equal(head.status, 'published');
  assert.equal(store.isClusterPublished(head.cluster_id), true);
  assert.equal(store.getCluster(head.cluster_id).item_count, 2, 'cluster absorbs the paraphrase');

  // ---------------------------------------------------------------- run 2
  const s2 = await runPipeline({ ...opts, runId: 'run_2' });
  assert.equal(s2.status, 'ok');
  assert.equal(s2.counts.detection.KNOWN, 3);
  assert.equal(s2.counts.candidates, 0);
  assert.equal(s2.counts.approved, 0);
  assert.equal(transport.sent.length, 1, 'second run must not re-send');
});

test('transport failures are isolated and recorded without failing the run', async () => {
  const { opts, transport } = build();
  transport.failNext = true;
  const s = await runPipeline({ ...opts, runId: 'run_fail' });
  assert.equal(s.counts.approved, 1);
  assert.equal(s.counts.sendFailures, 1);
  assert.equal(s.counts.published, 0);
  assert.equal(s.status, 'ok');
});

test('sqlite store round-trips events, clusters, published and runs', () => {
  const store = new SqliteStore(':memory:');
  const ts = IN_HOURS.toISOString();

  store.saveCluster({
    cluster_id: 'clu_s',
    head_event_id: 'evt_s',
    canonical_title: 'SEBI acts',
    tokens: ['sebi', 'fo'],
    companies: ['RELIANCE'],
    sectors: ['BANKING'],
    institutions: ['SEBI'],
    numbers: ['25'],
    category: 'SEBI',
    sources: ['NSE'],
    first_seen_at: ts,
    last_seen_at: ts,
    item_count: 2,
    publish_status: 'unpublished',
    cooldown_until: null,
  });
  store.saveEvent({
    event_id: 'evt_s',
    cluster_id: 'clu_s',
    url: 'https://s.test/a',
    canonical_url: 'https://s.test/a',
    content_hash: 'hash123',
    title: 'SEBI acts',
    description: 'd',
    source: 'NSE',
    source_type: 'official',
    trust_tier: 1,
    published_at: null,
    detected_at: ts,
    first_seen_at: ts,
    category: 'SEBI',
    companies: ['RELIANCE'],
    sectors: ['BANKING'],
    institutions: ['SEBI'],
    importance: 95,
    importance_level: 'HIGH',
    importance_factors: { base: 80 },
    confidence: 'high',
    official_confirmation: true,
    ai_summary: 'sum',
    ai_verdict: { is_material: true },
    detection_status: 'NEW',
    event_status: 'new',
    status: 'new',
    mode_scope: 'intraday',
    run_id: 'r',
    updated_at: ts,
  });

  const byUrl = store.getEventByCanonicalUrl('https://s.test/a');
  assert.equal(byUrl.event_id, 'evt_s');
  assert.deepEqual(byUrl.companies, ['RELIANCE']);
  assert.deepEqual(byUrl.institutions, ['SEBI']);
  assert.equal(byUrl.official_confirmation, true);
  assert.deepEqual(byUrl.ai_verdict, { is_material: true });
  assert.deepEqual(byUrl.importance_factors, { base: 80 });
  assert.equal(store.getEventByContentHash('hash123').event_id, 'evt_s');
  assert.equal(store.getEventByCanonicalUrl('https://s.test/zzz'), null);

  const cl = store.getCluster('clu_s');
  assert.deepEqual(cl.institutions, ['SEBI']);
  assert.equal(cl.item_count, 2);
  assert.equal(store.findRecentClusters(new Date(IN_HOURS.getTime() - 3600_000).toISOString()).length, 1);

  store.updateEvent('evt_s', { status: 'published', event_status: 'published' });
  assert.equal(store.getEvent('evt_s').status, 'published');

  assert.equal(store.isClusterPublished('clu_s'), false);
  store.recordPublished({
    event_id: 'evt_s',
    cluster_id: 'clu_s',
    chat_id: '-1004361419309',
    message_id: '42',
    mode: 'intraday',
    template: 'alert_v1',
    text_hash: 'th',
    published_at: ts,
    raw_text: 'hello',
  });
  assert.equal(store.isClusterPublished('clu_s'), true);
  assert.equal(store.lastPublishedAt(), ts);
  assert.equal(store.publishedCountSince(new Date(IN_HOURS.getTime() - 3600_000).toISOString()), 1);
  assert.equal(store.publishedCountSince(new Date(IN_HOURS.getTime() + 3600_000).toISOString()), 0);

  store.saveRun({ run_id: 'r', mode: 'intraday', started_at: ts, finished_at: ts, status: 'ok', stats: { published: 1 }, error: null });
  store.close(); // must not throw
});
