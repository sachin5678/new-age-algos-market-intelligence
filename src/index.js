#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createLogger } from './log/logger.js';
import { openStore } from './store/index.js';
import { createCategorizer } from './normalize/categorize.js';
import { createEntityExtractor } from './normalize/extractEntities.js';
import { createTextOps } from './dedupe/text.js';
import { createImportanceEngine } from './importance/classify.js';
import { createOpenAIService } from './ai/openaiService.js';
import { createTransport } from './telegram/transport.js';
import { createProviders } from './providers/index.js';
import { runProviders } from './providers/base.js';
import { runPipeline } from './pipeline.js';
import { createPoller } from './scheduler/index.js';
import { createSourceRegistry } from './normalize/sources.js';
import { buildPreMarketContext, buildClosingContext } from './briefings/context.js';
import { formatPreMarket, formatClosing } from './telegram/briefings.js';
import { chunkMessage } from './telegram/format.js';
import { labelChunks } from './telegram/theme.js';
import { VisualDeliver } from './visual/deliver.js';

const USAGE = `New Age Algos — market intelligence pipeline

Usage: node src/index.js [options]

Options:
  --mode <m>           intraday (default) | premarket | closing
  --job-type <t>       market-check (default) | market-news | health-check
  --briefing <b>       Render a scheduled briefing instead of the event pipeline:
                       premarket | closing (uses snapshots + recent store events)
  --visual             Generate and send visual briefing (PNG + optional PDF)
  --dry-run            Force DRY_RUN (print message, send nothing)
  --send               Allow real Telegram delivery (DRY_RUN=false)
  --no-ai              Skip OpenAI analysis (rules-only verdicts)
  --json               Machine-readable summary on stdout
  --memory             Use in-memory store instead of SQLite (testing)
  -h, --help           Show this help

Env: DRY_RUN, OPENAI_API_KEY, OPENAI_API_KEY_FILE,
     TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_API_ID, TELEGRAM_API_HASH,
     TELEGRAM_SESSION_PATH, EVENT_POLL_INTERVAL_MINUTES, MAX_ALERTS_PER_HOUR,
     VISUAL_BRIEFING, VISUAL_PDF, VISUAL_ALERTS
`;

function parseCli() {
  try {
    const { values } = parseArgs({
      options: {
        mode: { type: 'string', default: 'intraday' },
        'job-type': { type: 'string', default: 'market-check' },
        briefing: { type: 'string' },
        visual: { type: 'boolean', default: false },
        poll: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        send: { type: 'boolean', default: false },
        'no-ai': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        memory: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    });
    return values;
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

/**
 * BRIEFING path: collect market/global snapshots, pull recent events from the
 * store, assemble context, render the template, deliver through the transport.
 * Missing data → sections omitted (never fabricated).
 */
async function runBriefing({ briefing, providers, store, transport, logger, settings, now, runId, visual = false, visualDeliver = null }) {
  const startedAt = now.toISOString();
  const kind = briefing;

  // Collect only market/global providers — briefings don't need news feeds.
  const briefingProviders = providers.filter((p) => ['market', 'global'].includes(p.kind));
  const collected = await runProviders(briefingProviders, { logger, mode: kind, now }, logger);
  const snapshots = collected.items.filter((i) => i?.kind === 'snapshot').map((i) => i.snapshot ?? i);

  // Lookback: pre-market covers the previous evening, closing covers today.
  const hours = kind === 'premarket' ? 48 : 24;
  const since = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
  const events = store.listRecentEvents(since, 40);

  let visualResult = { visual: false };
  let text = '';
  let sent = false;
  let sendError = null;

  // If visual enabled, render and send image (+ optional PDF)
  if (visual && visualDeliver) {
    try {
      visualResult = await visualDeliver.sendBriefing({ type: kind, snapshots, events, now, runId });
      if (visualResult.visual) {
        sent = true;
      }
    } catch (err) {
      logger.error('VISUAL', `Visual briefing failed, falling back to text: ${err.message}`);
    }
  }

  // Fallback to text briefing if visual not enabled or failed
  if (!sent) {
    const ctx = kind === 'premarket'
      ? buildPreMarketContext({ snapshots, events, now })
      : buildClosingContext({ snapshots, events, now });
    text = kind === 'premarket' ? formatPreMarket(ctx, { now }) : formatClosing(ctx, { now });

    try {
      for (const chunk of labelChunks(chunkMessage(text, 4096))) {
        await transport.send(chunk, { mode: kind, category: 'BRIEFING', event_id: runId });
      }
      sent = true;
    } catch (err) {
      sendError = err.message;
      logger.error('TELEGRAM_SEND', `briefing send failed: ${err.message}`);
    }
  }

  const summary = {
    runId,
    kind,
    dryRun: Boolean(settings.dryRun),
    visual: visualResult.visual,
    pngPath: visualResult.pngPath ?? null,
    pdfPath: visualResult.pdfPath ?? null,
    snapshots: snapshots.length,
    eventsConsidered: events.length,
    messageLength: text.length,
    sent,
    sendError,
    startedAt,
    finishedAt: new Date().toISOString(),
    text,
  };
  store.saveRun({
    run_id: runId,
    mode: kind,
    started_at: startedAt,
    finished_at: summary.finishedAt,
    status: sent ? 'ok' : 'error',
    stats: { snapshots: snapshots.length, events: events.length, messageLength: text.length },
    error: sendError,
  });
  return summary;
}

function printBriefingSummary(summary, settings) {
  const lines = [
    '',
    `BRIEFING ${summary.runId}  kind=${summary.kind}  dryRun=${summary.dryRun}`,
    `  snapshots=${summary.snapshots} recentEvents=${summary.eventsConsidered} messageLength=${summary.messageLength}`,
    `  sent=${summary.sent}${summary.sendError ? ` error=${summary.sendError}` : ''}`,
    '',
    summary.text,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function printSummary(summary, settings, mode) {
  const c = summary.counts;
  const d = c.detection ?? {};
  const lines = [
    '',
    `RUN ${summary.runId}  mode=${mode}  dryRun=${settings.dryRun}`,
    `  collected=${c.collected} articles=${c.articles} snapshots=${c.snapshots} dropped=${c.dropped ?? 0}`,
    `  detect: NEW=${d.NEW ?? 0} UPDATED=${d.UPDATED ?? 0} DUPLICATE=${d.DUPLICATE ?? 0} KNOWN=${d.KNOWN ?? 0}`,
    `  classify: HIGH=${c.levels?.HIGH ?? 0} MEDIUM=${c.levels?.MEDIUM ?? 0} LOW=${c.levels?.LOW ?? 0}`,
    `  decisions: approved=${c.approved ?? 0} rejected=${c.rejected ?? 0}`,
    `  telegram: published=${c.published ?? 0} sendFailures=${c.sendFailures ?? 0}`,
  ];
  if (summary.failures.length) {
    lines.push(`  provider failures: ${summary.failures.map((f) => `${f.provider}(${f.error})`).join(', ')}`);
  }
  if (summary.rejectReasons && Object.keys(summary.rejectReasons).length) {
    lines.push(`  reject reasons: ${JSON.stringify(summary.rejectReasons)}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Health check function - verifies all components are working
 */
/**
 * Verify a Bot API token can deliver to `chatId` without posting anything:
 * getMe → identity, getChatMember → is this bot an admin that may post?
 * The token is only ever in the URL of the API call, never in logs/output.
 */
async function probeBotDelivery({ botToken, chatId, apiBase = 'https://api.telegram.org' }) {
  const call = async (method, params = {}) => {
    const url = `${apiBase}/bot${botToken}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), ...params }),
    });
    const data = await res.json().catch(() => null);
    return { ok: Boolean(data?.ok), data, status: res.status };
  };

  const me = await call('getMe');
  if (!me.ok) return { ok: false, error: `getMe failed: ${me.data?.description ?? me.status}` };
  const bot = me.data.result.username;

  // getChatMember needs the bot's own user_id — passing only chat_id is a 400.
  const member = await call('getChatMember', { user_id: me.data.result.id });
  if (!member.ok) {
    return { ok: false, bot, error: `getChatMember failed: ${member.data?.description ?? member.status}` };
  }

  const r = member.data.result;
  const status = r.status;
  const canPost = Boolean(r.can_post_messages ?? r.rights?.has_admin_rights ?? false);
  if (status === 'left' || status === 'kicked') {
    return { ok: false, bot, error: `bot @${bot} is not a member of chat ${chatId}` };
  }
  if (status === 'administrator' && !canPost) {
    return { ok: false, bot, error: `bot @${bot} is admin but lacks "Post messages" right` };
  }
  if (status !== 'administrator' && status !== 'creator') {
    return { ok: false, bot, error: `bot @${bot} is ${status} in chat ${chatId} — needs admin + Post messages` };
  }
  return { ok: true, bot, rights: 'admin · post messages' };
}

async function runHealthCheck({ settings, logger }) {
  const checks = [];
  let healthy = true;

  // Check configuration
  checks.push({ name: 'config', status: 'ok', message: 'Configuration loaded' });

  // TELEGRAM_CHAT_ID is required for every delivery path. TELEGRAM_API_ID /
  // TELEGRAM_API_HASH are not: Bot API delivery (CI) never uses them, and the
  // local GramJS session works off built-in defaults.
  const requiredEnv = ['TELEGRAM_CHAT_ID'];
  for (const env of requiredEnv) {
    if (!process.env[env]) {
      checks.push({ name: `env:${env}`, status: 'fail', message: `Missing required environment variable: ${env}` });
      healthy = false;
    } else {
      checks.push({ name: `env:${env}`, status: 'ok', message: 'Set' });
    }
  }
  checks.push({
    name: 'env:telegram-credentials',
    status: 'ok',
    message: process.env.TELEGRAM_BOT_TOKEN
      ? 'Bot API (TELEGRAM_BOT_TOKEN)'
      : 'GramJS session (built-in api id/hash defaults)',
  });

  // Check OpenAI key if AI enabled
  if (settings.ai.enabled) {
    const hasKey = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_FILE;
    if (hasKey) {
      checks.push({ name: 'openai:key', status: 'ok', message: 'API key available' });
    } else {
      checks.push({ name: 'openai:key', status: 'warn', message: 'No API key, will use rules-only fallback' });
    }
  } else {
    checks.push({ name: 'openai:key', status: 'skip', message: 'AI disabled in config' });
  }

  // Test NSE connectivity
  try {
    const { NSECollector } = await import('./providers/nseCollector.js');
    const collector = new NSECollector({ timeoutMs: 10000 });
    await collector.fetchIndices(null);
    checks.push({ name: 'nse:api', status: 'ok', message: 'NSE API reachable' });
  } catch (err) {
    checks.push({ name: 'nse:api', status: 'fail', message: `NSE API error: ${err.message}` });
    healthy = false;
  }

  // Test global market connectivity
  try {
    const { GlobalMarketCollector } = await import('./providers/nseCollector.js');
    const collector = new GlobalMarketCollector({ timeoutMs: 10000 });
    // Just test that the module loads, don't actually run yfinance in health check
    checks.push({ name: 'global:collector', status: 'ok', message: 'Global collector module loaded' });
  } catch (err) {
    checks.push({ name: 'global:collector', status: 'warn', message: `Global collector warning: ${err.message}` });
  }

  // Test official sources
  try {
    const { OfficialAnnouncementProvider } = await import('./providers/officialProvider.js');
    const { createCategorizer } = await import('./normalize/categorize.js');
    const { createEntityExtractor } = await import('./normalize/extractEntities.js');
    const cfg = await import('./config.js');
    const config = cfg.loadConfig();
    const provider = new OfficialAnnouncementProvider({
      sources: config.officialSources,
      categorizer: createCategorizer(config.categories),
      extractor: createEntityExtractor(config.entities),
    });
    checks.push({ name: 'official:provider', status: 'ok', message: 'Official provider initialized' });
  } catch (err) {
    checks.push({ name: 'official:provider', status: 'warn', message: `Official provider warning: ${err.message}` });
  }

  // Test state access
  try {
    const { openStore } = await import('./store/index.js');
    const store = openStore({ driver: 'sqlite', dbPath: ':memory:' });
    store.close();
    checks.push({ name: 'state:sqlite', status: 'ok', message: 'SQLite store accessible' });
  } catch (err) {
    checks.push({ name: 'state:sqlite', status: 'fail', message: `SQLite error: ${err.message}` });
    healthy = false;
  }

  // Test Telegram transport (dry-run)
  try {
    const { createTransport } = await import('./telegram/transport.js');
    const transport = createTransport({ mode: 'dry-run' });
    await transport.send('Health check test');
    checks.push({ name: 'telegram:transport', status: 'ok', message: 'Dry-run transport working' });
  } catch (err) {
    checks.push({ name: 'telegram:transport', status: 'fail', message: `Telegram transport error: ${err.message}` });
    healthy = false;
  }

  // Telegram delivery readiness: Bot API (CI) vs local GramJS session
  try {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!chatId) {
      checks.push({ name: 'telegram:delivery', status: 'fail', message: 'TELEGRAM_CHAT_ID not set' });
      healthy = false;
    } else if (botToken) {
      // Live validation: does this token belong to a bot that may post here?
      // Sends nothing — getMe + getChatMember only.
      const live = await probeBotDelivery({ botToken, chatId });
      if (live.ok) {
        checks.push({
          name: 'telegram:delivery',
          status: 'ok',
          message: `bot @${live.bot} → chat ${chatId} (${live.rights})`,
        });
      } else {
        checks.push({ name: 'telegram:delivery', status: 'fail', message: `bot-api → chat ${chatId}: ${live.error}` });
        healthy = false;
      }
    } else {
      checks.push({ name: 'telegram:delivery', status: 'ok', message: `gramjs-session → chat ${chatId}` });
    }
  } catch (err) {
    checks.push({ name: 'telegram:delivery', status: 'fail', message: `Delivery config error: ${err.message}` });
    healthy = false;
  }

  // Output results
  const output = {
    timestamp: new Date().toISOString(),
    healthy,
    checks,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exitCode = healthy ? 0 : 1;
  return output;
}

async function main() {
  const args = parseCli();
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const cfg = loadConfig();
  const { settings, feeds, officialSources, sources, importance, entities, categories, text } = cfg;

  // CLI overrides (env DRY_RUN handled inside loadConfig)
  if (args['dry-run']) settings.dryRun = true;
  if (args.send) settings.dryRun = false;
  if (args['no-ai']) settings.ai.enabled = false;

  const mode = args.mode;
  if (!['intraday', 'premarket', 'closing'].includes(mode)) {
    process.stderr.write(`Unknown mode: ${mode}\n\n${USAGE}`);
    process.exit(2);
  }
  const jobType = args['job-type'];
  if (!['market-check', 'market-news', 'health-check'].includes(jobType)) {
    process.stderr.write(`Unknown job-type: ${jobType}\n\n${USAGE}`);
    process.exit(2);
  }
  const briefing = args.briefing ?? null;
  if (briefing && !['premarket', 'closing'].includes(briefing)) {
    process.stderr.write(`Unknown briefing: ${briefing}\n\n${USAGE}`);
    process.exit(2);
  }
  const poll = Boolean(args.poll);
  if (poll && mode !== 'intraday') {
    process.stderr.write(`--poll only works with --mode intraday (default)\n\n${USAGE}`);
    process.exit(2);
  }
  const visual = Boolean(args.visual);
  if (visual && !briefing) {
    process.stderr.write(`--visual only works with --briefing premarket|closing\n\n${USAGE}`);
    process.exit(2);
  }

  const now = new Date();
  const runId = `${mode}_${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const logger = createLogger({ runId, dir: settings.paths.logs, toConsole: !args.json });
  const store = openStore({ driver: args.memory ? 'memory' : 'sqlite', dbPath: settings.paths.db });

  try {
    const categorizer = createCategorizer(categories);
    const extractor = createEntityExtractor(entities);
    const textOps = createTextOps(text);
    const importanceEngine = createImportanceEngine(importance);
    const sourceRegistry = createSourceRegistry(sources);
    const ai = createOpenAIService({ settings, sources, logger });
    // Bot API when a token is available (CI), GramJS session otherwise (local).
    const liveTransport = process.env.TELEGRAM_BOT_TOKEN ? 'bot' : 'gramjs';
    const transport = createTransport({
      mode: settings.dryRun ? 'dry-run' : liveTransport,
      options: {
        logger,
        chatId: process.env.TELEGRAM_CHAT_ID ?? null,
        botToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
        apiId: process.env.TELEGRAM_API_ID ?? '20412495',
        apiHash: process.env.TELEGRAM_API_HASH ?? 'b8843afdbd2790efd99744c20e8f4f77',
        sessionPath: process.env.TELEGRAM_SESSION_PATH ?? null,
      },
    });
    const providers = createProviders({ settings, feeds, officialSources, categorizer, extractor });

    // ---------------------------------------------------- BRIEFING COMMAND
    if (briefing) {
      const visualDeliver = new VisualDeliver({ transport, logger, settings, enabled: visual });
      const summary = await runBriefing({
        briefing,
        providers,
        store,
        transport,
        logger,
        settings,
        now,
        runId,
        visual,
        visualDeliver,
      });
      if (args.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      else printBriefingSummary(summary, settings);
      return;
    }

    // ---------------------------------------------------- HEALTH CHECK
    if (jobType === 'health-check') {
      await runHealthCheck({ settings, logger });
      return;
    }

    // ---------------------------------------------------- MARKET NEWS (fetch only, no publish)
    if (jobType === 'market-news') {
      const transport2 = createTransport({ mode: 'dry-run' });
      const newsProviders = providers.filter((p) => p.kind === 'news');
      const collected = await runProviders(newsProviders, { logger, mode: 'intraday', now }, logger);
      logger.info('MARKET_NEWS', `collected ${collected.items.length} articles`);
      return;
    }

    // ---------------------------------------------------- POLLING MODE
    if (poll) {
      const poller = createPoller({
        settings,
        pipelineFn: async ({ mode, now: pollNow, runId: pollRunId }) => {
          return runPipeline({
            providers,
            settings,
            importance: importanceEngine,
            textOps,
            categorizer,
            extractor,
            store,
            logger,
            ai,
            transport,
            mode,
            now: pollNow,
            runId: pollRunId,
            noAi: !settings.ai.enabled,
            scheduledBriefing: false,
            sourceRegistry,
          });
        },
        logger,
      });
      await poller.start();

      // Handle graceful shutdown
      let shuttingDown = false;
      async function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        logger?.info('POLLER', `received ${signal}, shutting down...`);
        await poller.stop();
        logger.close();
        store.close();
        process.exit(0);
      }
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      // Keep the process alive
      return;
    }

    // ---------------------------------------------------- MARKET CHECK (full pipeline)
    if (jobType === 'market-check') {
      const summary = await runPipeline({
        providers,
        settings,
        importance: importanceEngine,
        textOps,
        categorizer,
        extractor,
        store,
        logger,
        ai,
        transport,
        mode,
        now,
        runId,
        noAi: !settings.ai.enabled,
        scheduledBriefing: mode !== 'intraday',
        sourceRegistry,
      });

      store.saveRun({
        run_id: runId,
        mode,
        started_at: summary.startedAt,
        finished_at: summary.finishedAt,
        status: summary.status,
        stats: summary.counts,
        error: null,
      });

      if (args.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      else printSummary(summary, settings, mode);
    } else {
      logger.info('JOB', `Job type "${jobType}" completed without running pipeline`);
    }
  } catch (err) {
    logger.error('PIPELINE', `fatal: ${err.message}`, { stack: err.stack });
    try {
      store.saveRun({
        run_id: runId,
        mode,
        started_at: now.toISOString(),
        finished_at: new Date().toISOString(),
        status: 'error',
        stats: {},
        error: err.message,
      });
    } catch {
      /* store already broken — log above is enough */
    }
    process.exitCode = 1;
  } finally {
    logger.close();
    store.close();
  }
}

main().catch((err) => {
  process.stderr.write(`[FATAL] ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
