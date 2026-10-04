import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader — sets unset env keys from <project>/.env (no dependency). */
export function loadDotEnv(file = path.join(PROJECT_ROOT, '.env'), env = process.env) {
  if (!fs.existsSync(file)) return env;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[2] === '') continue;
    const key = m[1];
    if (env[key] === undefined) env[key] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function readJson(rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(PROJECT_ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`Config file missing: ${abs}`);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

/**
 * Load all configuration. Env overrides: DRY_RUN, OPENAI_API_KEY_FILE, OPENAI_API_KEY.
 */
export function loadConfig({ settingsFile = 'config/settings.json', env = process.env } = {}) {
  loadDotEnv(undefined, env);
  const settings = readJson(settingsFile);
  const feeds = readJson(settings.feedsFile);
  const officialSources = readJson(settings.officialSourcesFile);
  const sources = readJson(settings.sourcesFile);
  const holidays = readJson('config/holidays.json');
  const importance = readJson(settings.importanceFile);
  const entities = readJson(settings.entitiesFile);
  const categories = readJson(settings.categoriesFile);
  const text = readJson(settings.textFile);

  // Env overrides (never stored, never logged)
  if (env.DRY_RUN !== undefined && env.DRY_RUN !== '') {
    settings.dryRun = String(env.DRY_RUN).toLowerCase() === 'true';
  }
  if (env.OPENAI_API_KEY_FILE) settings.ai.apiKeyFile = env.OPENAI_API_KEY_FILE;
  if (env.OPENAI_API_KEY) settings.ai.apiKey = env.OPENAI_API_KEY;
  if (env.EVENT_POLL_INTERVAL_MINUTES) {
    const mins = Number(env.EVENT_POLL_INTERVAL_MINUTES);
    if (Number.isFinite(mins) && mins > 0) settings.scheduler.pollIntervalMinutes = mins;
  }
  if (env.MAX_ALERTS_PER_HOUR) {
    const n = Number(env.MAX_ALERTS_PER_HOUR);
    if (Number.isFinite(n) && n >= 0) settings.scheduler.maxAlertsPerHour = n;
  }

  const abs = (p) => (path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p));
  settings.paths = {
    inbox: abs(settings.paths.inbox),
    archive: abs(settings.paths.archive),
    logs: abs(settings.paths.logs),
    db: abs(settings.paths.db),
  };

  return { settings, feeds, officialSources, sources, holidays, importance, entities, categories, text };
}
