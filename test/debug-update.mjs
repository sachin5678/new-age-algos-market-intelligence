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
const settings = { ...cfg.settings, publish: { ...cfg.settings.publish, minIntervalMinutes: 0, cooldownMinutes: 0 } };
const store = new MemoryStore();
const categorizer = createCategorizer(cfg.categories);
const extractor = createEntityExtractor(cfg.entities);
const textOps = createTextOps(cfg.text);
const importance = createImportanceEngine(cfg.importance);
const ai = createOpenAIService({ settings: cfg.settings, logger: null });
const sourceRegistry = createSourceRegistry(cfg.sources);
const logger = createLogger({ runId: 'test', toConsole: false });

const BASE = { url: 'https://nseindia.com/circular/sebi-fo-limits', source: 'NSE', source_type: 'official', trust_tier: 1, category: 'SEBI', published_at: new Date().toISOString() };

class FixtureProvider extends Provider {
  constructor(article) { super({ name: 'fixture', kind: 'news' }); this.article = article; }
  async collect() { return [this.article]; }
}

const transport = { name: 'fake', sent: [], async send(t) { this.sent.push({ text: t }); return { message_id: this.sent.length }; } };
const now = new Date('2026-10-09T04:00:00Z');

// Run 1: "considering"
const article1 = { ...BASE, url: 'https://nseindia.com/circular/sebi-considers', title: 'SEBI considering tighter F&O position limits', description: 'The regulator is weighing new position limits for retail traders.' };
const summary1 = await runPipeline({ providers: [new FixtureProvider(article1)], settings, importance, textOps, categorizer, extractor, store, logger, ai, transport, mode: 'intraday', now, runId: 'run1', noAi: true, scheduledBriefing: false, sourceRegistry, holidays: cfg.holidays });
console.log('Run 1:', 'approved=' + summary1.counts.approved, 'detection=' + JSON.stringify(summary1.counts.detection), 'sent=' + transport.sent.length);

// Run 2: "announces" with new facts
const article2 = { ...BASE, url: 'https://nseindia.com/circular/sebi-announces', title: 'SEBI announces tighter F&O position limits effective June 1', description: 'The regulator has cut index position limits from 500 to 300 contracts, effective June 1, 2026.' };
const summary2 = await runPipeline({ providers: [new FixtureProvider(article2)], settings, importance, textOps, categorizer, extractor, store, logger, ai, transport, mode: 'intraday', now, runId: 'run2', noAi: true, scheduledBriefing: false, sourceRegistry, holidays: cfg.holidays });
console.log('Run 2:', 'approved=' + summary2.counts.approved, 'detection=' + JSON.stringify(summary2.counts.detection), 'sent=' + transport.sent.length);
console.log('  total sent:', transport.sent.length);

logger.close();
store.close();