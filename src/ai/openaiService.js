import { createAIProvider } from './providers.js';

/**
 * AI analysis service - wraps the provider abstraction.
 * Responsible for analysis/summary/classification ONLY —
 * it has no Telegram capability and never sends messages.
 */
export function createOpenAIService({ settings, sources = null, logger = null, fetchImpl = fetch, apiKey = null } = {}) {
  const ai = createAIProvider({ settings, logger, fetchImpl, apiKey });

  async function analyze(event, ctx = {}) {
    return ai.analyze(event, ctx);
  }

  // For backwards compatibility with tests
  const fallbackVerdict = (event, reason = 'disabled') => {
    const provider = new (await import('./providers.js')).RulesOnlyProvider({ settings, logger });
    return provider._fallbackVerdict(event, reason);
  };

  return { analyze, fallbackVerdict, hasKey: true, enabled: true };
}