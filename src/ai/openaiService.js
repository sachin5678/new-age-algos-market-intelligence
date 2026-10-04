import { createAIProvider, RulesOnlyProvider } from './providers.js';
import fs from 'node:fs';

/**
 * Fallback verdict used when AI is disabled/unavailable.
 * Conservative: falls back to deterministic importance classification.
 */
export function fallbackVerdict(event, reason = 'disabled') {
  const provider = new RulesOnlyProvider({ settings: { ai: { enabled: false } }, logger: null });
  return provider._fallbackVerdict(event, reason);
}

function _hasApiKey(settings) {
  if (settings.ai?.apiKey) return true;
  if (settings.ai?.apiKeyFile && fs.existsSync(settings.ai.apiKeyFile)) {
    return true;
  }
  return false;
}

/**
 * AI analysis service - wraps the provider abstraction.
 * Responsible for analysis/summary/classification ONLY —
 * it has no Telegram capability and never sends messages.
 */
export function createOpenAIService({ settings, sources = null, logger = null, fetchImpl = fetch, apiKey = null } = {}) {
  const ai = createAIProvider({ settings, logger, fetchImpl, apiKey });
  const hasKey = _hasApiKey(settings);

  async function analyze(event, ctx = {}) {
    return ai.analyze(event, ctx);
  }

  return { analyze, hasKey, enabled: settings.ai?.enabled !== false };
}