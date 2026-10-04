/**
 * Intraday polling scheduler — runs the pipeline every N minutes
 * during market hours (Asia/Kolkata), respecting NSE holidays.
 *
 * Usage:
 *   const poller = createPoller({ settings, pipelineFn, logger });
 *   await poller.start();
 *   // ... later ...
 *   await poller.stop();
 */
import { isWithinMarketHours } from '../publish/shouldPublish.js';

export function createPoller({ settings, pipelineFn, logger }) {
  const schedulerCfg = settings.scheduler ?? {};
  const enabled = schedulerCfg.enabled !== false;
  const pollIntervalMs = (Number(schedulerCfg.pollIntervalMinutes) || 5) * 60 * 1000;
  const marketHours = settings.marketHours ?? { timezone: 'Asia/Kolkata', start: '09:15', end: '15:30', weekdaysOnly: true };
  const holidays = settings.holidays ?? [];

  let timer = null;
  let running = false;
  let lastRunSummary = null;

  async function tick(runId, mode = 'intraday') {
    if (running) return;
    const now = new Date();
    if (!isWithinMarketHours(now, marketHours, holidays)) {
      logger?.info('POLLER', `skip: outside market hours (${now.toISOString()})`);
      return;
    }
    running = true;
    logger?.info('POLLER', `run ${runId} starting`);
    try {
      const summary = await pipelineFn({ mode, now, runId });
      lastRunSummary = summary;
      logger?.info('POLLER', `run ${runId} done: ${summary.status}`, {
        published: summary.counts?.published ?? 0,
        candidates: summary.counts?.candidates ?? 0,
      });
    } catch (err) {
      logger?.error('POLLER', `run ${runId} failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  function scheduleNext(runNumber) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const runId = `poll_${runNumber}_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
      tick(runId).then(() => scheduleNext(runNumber + 1));
    }, pollIntervalMs);
  }

  return {
    async start() {
      if (!enabled) {
        logger?.info('POLLER', 'scheduler disabled in config');
        return;
      }
      logger?.info('POLLER', `starting: interval=${schedulerCfg.pollIntervalMinutes}min`);
      scheduleNext(1);
      // Run immediately on start
      const runId = `poll_start_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
      await tick(runId);
    },
    async stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      logger?.info('POLLER', 'stopped');
    },
    isRunning() {
      return running;
    },
    getLastSummary() {
      return lastRunSummary;
    },
  };
}