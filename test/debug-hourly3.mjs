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
const settings = { ...cfg.settings, publish: { ...cfg.settings.publish, minIntervalMinutes: 0, cooldownMinutes: 0, hourlyCap: 3 }, scheduler: { ...cfg.settings.scheduler, maxAlertsPerHour: 3 } };
const store = new MemoryStore();
const categorizer = createCategorizer(cfg.categories);
const extractor = createEntityExtractor(cfg.entities);
const textOps = createTextOps(cfg.text);
const importance = createImportanceEngine(cfg.importance);
const ai = createOpenAIService({ settings: cfg.settings, logger: null });
const sourceRegistry = createSourceRegistry(cfg.sources);
const logger = createLogger({ runId: 'test', toConsole: false });

const BASE = { url: 'https://nseindia.com/circular/fo-rule-change', source: 'NSE', source_type: 'official', trust_tier: 1, category: 'SEBI', published_at: new Date().toISOString() };

class FixtureProvider extends Provider {
  constructor(article) { super({ name: 'fixture', kind: 'news' }); this.article = article; }
  async collect() { return [this.article]; }
}

const baseNow = new Date('2026-10-09T04:00:00Z');

const events = [
  { ...BASE, url: 'https://nseindia.com/circular/fo-rule-change', title: 'SEBI announces F&O position limits revised', description: 'The regulator has notified new position limits for index derivatives.' },
  { ...BASE, url: 'https://rbi.org.in/scripts/rbi-circular-2', title: 'RBI cuts repo rate by 25 bps to 6.25%', description: 'The monetary policy committee reduced the policy repo rate.', category: 'RBI' },
  { ...BASE, url: 'https://pib.gov.in/newsite/printrelease-3', title: 'Govt cuts capital gains tax on equities', description: 'Finance ministry slashes LTCG tax rate for equity investors.', category: 'MACRO' },
  { ...BASE, url: 'https://nseindia.com/circular/market-disruption', title: 'SEBI halts derivatives trading amid extreme volatility', description: 'The regulator has suspended F&O trading for the session due to extreme volatility.', category: 'SEBI' },
];

for (let i = 0; i < 4; i++) {
  const transport = { name: 'fake', sent: [], async send(t) { this.sent.push({ text: t }); return { message_id: this.sent.length }; } };
  const summary = await runPipeline({ providers: [new FixtureProvider(events[i])], settings, importance, textOps, categorizer, extractor, store, logger, ai, transport, mode: 'intraday', now: new Date(baseNow.getTime() + (i+1) * 60000), runId: 'run' + (i+1), noAi: true, scheduledBriefing: false, sourceRegistry, holidays: cfg.holidays });
  console.log('Run ' + (i+1) + ':', 'approved=' + summary.counts.approved, 'rejectReasons=' + JSON.stringify(summary.rejectReasons), 'detection=' + JSON.stringify(summary.counts.detection), 'sent=' + transport.sent.length);
  console.log('  published array:', store.published.map(p => p.published_at));
  console.log('  publishedCountSince 1hr:', store.publishedCountSince(new Date(baseNow.getTime() + (i+1) * 60000 - 3600000).toISOString()));
}

logger.close();
store.close();