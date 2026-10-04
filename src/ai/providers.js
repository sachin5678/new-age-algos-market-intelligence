/**
 * AI Provider Abstraction
 * Supports multiple providers with graceful fallback.
 */

export const AI_STATUS = {
  AI_ANALYZED: 'ai_analyzed',
  RULES_ONLY: 'rules_only',
  UNVERIFIED: 'unverified',
  AWAITING_CONFIRMATION: 'awaiting_confirmation'
};

export class BaseAIProvider {
  constructor({ name, settings, logger = null } = {}) {
    this.name = name;
    this.settings = settings;
    this.logger = logger;
  }

  async analyze(event, ctx = {}) {
    throw new Error('analyze() must be implemented by subclass');
  }

  isAvailable() {
    throw new Error('isAvailable() must be implemented by subclass');
  }
}

/**
 * OpenAI Provider (primary)
 */
export class OpenAIProvider extends BaseAIProvider {
  constructor({ settings, logger = null, fetchImpl = fetch, apiKey = null } = {}) {
    super({ name: 'openai', settings, logger });
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  isAvailable() {
    return Boolean(this.apiKey || this.settings.ai?.apiKey || this.settings.ai?.apiKeyFile);
  }

  async analyze(event, ctx = {}) {
    if (!this.isAvailable()) {
      throw new Error('OpenAI not available: no API key');
    }

    const cfg = this.settings.ai ?? {};
    const key = this.apiKey ?? (await this._readKey());

    if (!key) {
      throw new Error('No API key available');
    }

    try {
      const res = await this.fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: cfg.model ?? 'gpt-4o-mini',
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: this._buildSystemPrompt() },
            { role: 'user', content: JSON.stringify(this._buildUserPayload(event, ctx), null, 2) },
          ],
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 30000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('empty completion');
      const parsed = JSON.parse(content);
      return this._coerceVerdict(parsed, event);
    } catch (err) {
      this.logger?.warn('AI_ANALYZE', `OpenAI failed (${err.message})`);
      throw err;
    }
  }

  async _readKey() {
    if (this.settings.ai?.apiKey) return this.settings.ai.apiKey;
    if (this.settings.ai?.apiKeyFile) {
      try {
        const fs = await import('node:fs');
        if (fs.existsSync(this.settings.ai.apiKeyFile)) {
          return fs.readFileSync(this.settings.ai.apiKeyFile, 'utf8').trim();
        }
      } catch {}
    }
    return null;
  }

  _buildSystemPrompt() {
    return `You are an objective Indian financial-market news analyst for "New Age Algos",
a professional market-intelligence service for Indian markets distributed over Telegram.

Your job is to identify important factual developments and explain their relevance
to Indian markets.

SOURCE HIERARCHY (judge reliability with this):
Tier 1 (official): NSE, BSE, SEBI, RBI, Government, Ministry of Finance, Exchange filing, Company filing, Corporate filing, MCA, IRDAI, PFRDA, GST Council
Tier 2 (reputable_media): Reuters, Bloomberg, Economic Times, Business Standard, CNBC-TV18, Mint, Livemint, Financial Express, BusinessLine
Tier 3 (reputable_financial_press): Moneycontrol, NDTV Profit, Zee Business, PTI, Press Trust of India, Associated Press, AFP
Tier 4 (commentary_social): Twitter, X, YouTube, Reddit, Telegram, Social media
Tier 4 information must NOT be treated as confirmed fact.

Rules — always follow:
- Prioritize primary sources: Tier 1 documents (exchanges, regulators, government, company filings) come first.
- Clearly distinguish CONFIRMED information (from Tier 1 sources / exchange filings) from
  REPORTED information (media reports without official confirmation).
- Do not speculate. Do not add analysis, forecasts, or interpretations not supported by the provided content.
- Avoid sensational language. Write like a wire-service editor: neutral, factual, specific.
- Never state or imply financial guarantees or assured returns.
- Never give personalized financial advice and never produce buy/sell/hold recommendations.
- NEVER fabricate data, sources, quotations, prices, percentages, dates or numbers.
  Use only facts present in the provided content. If a figure is not provided, omit it.
- affected_sectors / affected_stocks: include an entry ONLY when the provided information
  clearly establishes the relationship; otherwise return an empty array.
- summary: 2-3 factual sentences. facts: concrete facts drawn only from the provided content.
- market_relevance: why this matters for Indian markets today — factual, no advice.
- publication_priority: "high" only if an NSE trader needs to know this intraday today;
  "medium" if notable; "low" if minor.

Output ONLY a strict JSON object with exactly these keys:
{
  "event_type": string,
  "headline": string,
  "summary": string,
  "facts": string[],
  "market_relevance": string,
  "affected_sectors": string[],
  "affected_stocks": string[],
  "impact": "positive|negative|mixed|neutral|unclear",
  "confidence": "high|medium|low",
  "source_type": "official|reputable_media|other",
  "is_material": boolean,
  "publication_priority": "high|medium|low"
}`;
  }

  _buildUserPayload(event, ctx = {}) {
    const tier = Number(event.trust_tier ?? 2);
    return {
      article: {
        title: event.title,
        description: (event.description ?? '').slice(0, 800),
        source: event.source,
        source_tier: tier,
        source_tier_note:
          tier === 1
            ? 'official/primary source — information can be treated as confirmed'
            : tier >= 4
              ? 'social/commentary — must NOT be treated as confirmed fact'
              : 'media report — treat as reported, not confirmed',
        source_type: event.source_type,
        category: event.category,
        published_at: event.published_at,
      },
      extraction: {
        companies: event.companies,
        sectors: event.sectors,
        institutions: event.institutions,
      },
      classification: {
        importance_level: event.importance_level,
      },
      related_coverage: {
        outlets: ctx.cluster?.sources ?? [event.source],
        article_count: ctx.cluster?.item_count ?? 1,
      },
      market_context: (ctx.snapshots ?? []).slice(0, 12).map((s) => `${s.name}=${s.value}`),
      mode: ctx.mode ?? 'intraday',
    };
  }

  _coerceVerdict(parsed, event) {
    const level = event.importance_level ?? 'LOW';
    const pick = (v, allowed, dflt) => (allowed.has(v) ? v : dflt);
    const IMPACTS = new Set(['positive', 'negative', 'mixed', 'neutral', 'unclear']);
    const CONFIDENCES = new Set(['high', 'medium', 'low']);
    const PRIORITIES = new Set(['high', 'medium', 'low']);
    const SOURCE_TYPES = new Set(['official', 'reputable_media', 'other']);
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const list = (v, fallback) =>
      Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 120)) : fallback;

    const defaultEventType = (event) => {
      const map = {
        SEBI: 'regulatory',
        RBI: 'monetary_policy',
        FNO: 'derivatives',
        IPO: 'ipo',
        RESULTS: 'earnings',
        CORPORATE_ACTION: 'corporate_action',
        MACRO: 'macro',
        MARKET: 'market',
        GLOBAL: 'global',
        COMMODITIES: 'commodities',
        CURRENCY: 'currency',
        BONDS: 'bonds',
        SECTOR: 'sector',
        STOCK: 'corporate',
        OTHER: 'other',
      };
      return map[event.category] ?? 'other';
    };

    const sourceTypeForEvent = (event) => {
      const tier = Number(event.trust_tier ?? 2);
      if (tier === 1 || event.source_type === 'official') return 'official';
      if (tier >= 4) return 'other';
      return 'reputable_media';
    };

    return {
      event_type: str(parsed.event_type, 40) || defaultEventType(event),
      headline: str(parsed.headline, 300) || event.title,
      summary: str(parsed.summary, 600),
      facts: Array.isArray(parsed.facts)
        ? parsed.facts.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim().slice(0, 300)).slice(0, 8)
        : [],
      market_relevance: str(parsed.market_relevance, 400),
      affected_sectors: list(parsed.affected_sectors, event.sectors ?? []),
      affected_stocks: list(parsed.affected_stocks, event.companies ?? []),
      impact: pick(parsed.impact, IMPACTS, 'unclear'),
      confidence: pick(parsed.confidence, CONFIDENCES, 'low'),
      source_type: pick(parsed.source_type, SOURCE_TYPES, sourceTypeForEvent(event)),
      is_material: typeof parsed.is_material === 'boolean' ? parsed.is_material : level === 'HIGH',
      publication_priority: pick(parsed.publication_priority, PRIORITIES, level === 'HIGH' ? 'high' : 'low'),
      analysis_source: 'openai',
      fallback_reason: null,
    };
  }
}

/**
 * Rules-only fallback provider (always available)
 */
export class RulesOnlyProvider extends BaseAIProvider {
  constructor({ settings, logger = null } = {}) {
    super({ name: 'rules_only', settings, logger });
  }

  isAvailable() {
    return true; // Always available
  }

  async analyze(event, ctx = {}) {
    const level = event.importance_level ?? 'LOW';
    return this._fallbackVerdict(event, 'ai_unavailable');
  }

  _fallbackVerdict(event, reason = 'ai_unavailable') {
    const level = event.importance_level ?? 'LOW';
    const defaultEventType = (event) => {
      const map = {
        SEBI: 'regulatory',
        RBI: 'monetary_policy',
        FNO: 'derivatives',
        IPO: 'ipo',
        RESULTS: 'earnings',
        CORPORATE_ACTION: 'corporate_action',
        MACRO: 'macro',
        MARKET: 'market',
        GLOBAL: 'global',
        COMMODITIES: 'commodities',
        CURRENCY: 'currency',
        BONDS: 'bonds',
        SECTOR: 'sector',
        STOCK: 'corporate',
        OTHER: 'other',
      };
      return map[event.category] ?? 'other';
    };

    const sourceTypeForEvent = (event) => {
      const tier = Number(event.trust_tier ?? 2);
      if (tier === 1 || event.source_type === 'official') return 'official';
      if (tier >= 4) return 'other';
      return 'reputable_media';
    };

    return {
      event_type: defaultEventType(event),
      headline: event.title ?? '',
      summary: (event.description ?? '').slice(0, 240),
      facts: [],
      market_relevance: '',
      affected_sectors: event.sectors ?? [],
      affected_stocks: event.companies ?? [],
      impact: 'unclear',
      confidence: 'low',
      source_type: sourceTypeForEvent(event),
      is_material: level === 'HIGH',
      publication_priority: level === 'HIGH' ? 'high' : level === 'MEDIUM' ? 'medium' : 'low',
      analysis_source: 'rules',
      fallback_reason: reason,
    };
  }
}

/**
 * Factory to create AI provider with fallback chain
 */
export function createAIProvider({ settings, logger = null, fetchImpl = fetch, apiKey = null } = {}) {
  const providers = [
    new OpenAIProvider({ settings, logger, fetchImpl, apiKey }),
    new RulesOnlyProvider({ settings, logger }),
  ];

  async function analyze(event, ctx = {}) {
    for (const provider of providers) {
      if (!provider.isAvailable()) {
        continue;
      }
      try {
        const result = await provider.analyze(event, ctx);
        if (provider.name !== 'openai') {
          // Mark as rules-only
          result.analysis_source = provider.name;
        }
        return result;
      } catch (err) {
        logger?.warn('AI_ANALYZE', `${provider.name} failed (${err.message}), trying fallback`);
        // Try next provider
      }
    }
    // Should never reach here since RulesOnlyProvider is always available
    return providers[providers.length - 1].analyze(event, ctx);
  }

  return { analyze };
}

export { BaseAIProvider, OpenAIProvider, RulesOnlyProvider };