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

const transport = { name: 'fake', sent: [], async send(t) { this.sent.push({ text: t }); return { message_id: this.sent.length }; } };
const baseNow = new Date('2026-10-09T04:00:00Z'); // Friday 09:30 IST, not a holiday

for (let i = 1; i <= 3; i++) {
  let article;
  if (i === 1) article = { ...BASE, url: 'https://nseindia.com/circular/fo-rule-change', title: 'SEBI announces F&O position limits revised', description: 'The regulator has notified new position limits for index derivatives.' };
  else if (i === 2) article = { ...BASE, url: 'https://rbi.org.in/scripts/rbi-circular-2', title: 'RBI cuts repo rate by 25 bps to 6.25%', description: 'The monetary policy committee reduced the policy repo rate.', category: 'RBI' };
  else article = { ...BASE, url: 'https://pib.gov.in/newsite/printrelease-3', title: 'Govt cuts capital gains tax on equities', description: 'Finance ministry slashes LTCG tax rate for equity investors.', category: 'MACRO' };

  const t = transport;
  const summary = await runPipeline({ providers: [new FixtureProvider(article)], settings, importance, textOps, categorizer, extractor, store, logger, ai, transport: t, mode: 'intraday', now: new Date(baseNow.getTime() + i * 60000), runId: 'run' + i, noAi: true, scheduledBriefing: false, sourceRegistry, holidays: cfg.holidays });
  console.log('Run ' + i + ':', 'approved=' + summary.counts.approved, 'rejectReasons=' + JSON.stringify(summary.rejectReasons), 'sent=' + t.sent.length);
}

logger.close();
store.close();