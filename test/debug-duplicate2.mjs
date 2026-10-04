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
const settings = { ...cfg.settings }; // default settings
const store = new MemoryStore();
const categorizer = createCategorizer(cfg.categories);
const extractor = createEntityExtractor(cfg.entities);
const textOps = createTextOps(cfg.text);
const importance = createImportanceEngine(cfg.importance);
const ai = createOpenAIService({ settings: cfg.settings, logger: null });
const sourceRegistry = createSourceRegistry(cfg.sources);
const logger = createLogger({ runId: 'test', toConsole: false });

const BASE = { url: 'https://nseindia.com/circular/sebi-fo-limits-v2', source: 'NSE', source_type: 'official', trust_tier: 1, category: 'SEBI', published_at: new Date().toISOString() };

class FixtureProvider extends Provider {
  constructor(article) { super({ name: 'fixture', kind: 'news' }); this.article = article; }
  async collect() { return [this.article]; }
}

const article = { ...BASE, title: 'SEBI announces new F&O margin framework', description: 'The regulator has notified a revised margin framework for derivatives.' };
const transport = { name: 'fake', sent: [], async send(t) { this.sent.push({ text: t }); return { message_id: this.sent.length }; } };
const now = new Date('2026-10-09T04:00:00Z');

for (let i = 1; i <= 2; i++) {
  const t = transport;
  const summary = await runPipeline({ providers: [new FixtureProvider(article)], settings, importance, textOps, categorizer, extractor, store, logger, ai, transport: t, mode: 'intraday', now, runId: 'run' + i, noAi: true, scheduledBriefing: false, sourceRegistry, holidays: cfg.holidays });
  console.log('Run ' + i + ':', 'approved=' + summary.counts.approved, 'rejectReasons=' + JSON.stringify(summary.rejectReasons), 'detection=' + JSON.stringify(summary.counts.detection), 'sent=' + t.sent.length);
}

logger.close();
store.close();