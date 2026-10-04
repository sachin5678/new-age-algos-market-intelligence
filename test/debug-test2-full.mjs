import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';
import { createCategorizer } from '../src/normalize/categorize.js';
import { createEntityExtractor } from '../src/normalize/extractEntities.js';
import { createTextOps } from '../src/dedupe/text.js';
import { createImportanceEngine } from '../src/importance/classify.js';
import { createOpenAIService } from '../src/ai/openaiService.js';
import { createSourceRegistry } from '../src/normalize/sources.js';
import { runPipeline } from '../src/pipeline.js';
import { Provider } from '../src/providers/base.js';
import { createLogger } from '../src/log/logger.js';

const cfg = loadConfig();

function makeHarness(overrides = {}) {
  const settings = { ...cfg.settings, ...overrides.settings };
  if (overrides.holidays !== undefined) settings.holidays = overrides.holidays;
  const store = new MemoryStore();
  const categorizer = createCategorizer(cfg.categories);
  const extractor = createEntityExtractor(cfg.entities);
  const textOps = createTextOps(cfg.text);
  const importance = createImportanceEngine(cfg.importance);
  const ai = createOpenAIService({ settings: cfg.settings, logger: null });
  const sourceRegistry = createSourceRegistry(cfg.sources);
  const transport = { name: 'fake', sent: [], async send(t) { this.sent.push({ text: t }); return { message_id: this.sent.length }; } };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, close: () => {} };
  return { settings, store, categorizer, extractor, textOps, importance, ai, sourceRegistry, transport, logger };
}

async function runOnce(harness, articles, { runId = 'test', mode = 'intraday', now = new Date() } = {}) {
  const providers = [{
    async collect() { return articles; },
    kind: 'news',
    name: 'fixture'
  }];
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

const CFG = { settings: cfg.settings, categories: cfg.categories, entities: cfg.entities, text: cfg.text, importance: cfg.importance, sources: cfg.sources };
const HOLIDAYS = cfg.holidays;
const MARKET_NOW = new Date('2026-10-09T04:00:00Z');
const BASE = { url: 'https://nseindia.com/circular/sebi-fo-limits-v2', source: 'NSE', source_type: 'official', trust_tier: 1, category: 'SEBI', published_at: new Date().toISOString() };

async function testDuplicate() {
  const h = makeHarness();
  const article = { ...BASE, title: 'SEBI announces new F&O margin framework', description: 'The regulator has notified a revised margin framework for derivatives.' };
  
  await runOnce(h, [article], { runId: 'run1', now: MARKET_NOW });
  console.log('After run1:', h.transport.sent.length);
  
  const summary = await runOnce(h, [article], { runId: 'run2', now: MARKET_NOW });
  console.log('After run2:', h.transport.sent.length);
  console.log('summary:', summary.counts.approved, summary.rejectReasons);
  
  if (h.transport.sent.length === 1) {
    console.log('PASS');
  } else {
    console.log('FAIL: expected 1, got', h.transport.sent.length);
  }
}

testDuplicate();