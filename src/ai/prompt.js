/**
 * System prompt + user payload for the New Age Algos financial-news analyst.
 * The AI analyzes/summarizes/classifies ONLY — it never sends Telegram messages.
 */

/** Default event_type when the model omits/invalidates it (from event category). */
export function defaultEventType(event = {}) {
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
}

/** source_type the model should see defaults to: tier1 → official, tier2/3 → reputable_media, else other. */
export function sourceTypeForEvent(event = {}) {
  const tier = Number(event.trust_tier ?? 2);
  if (tier === 1 || event.source_type === 'official') return 'official';
  if (tier >= 4) return 'other';
  return 'reputable_media';
}

/**
 * Dedicated system prompt for the analyst, including the source hierarchy
 * rendered from config/sources.json.
 */
export function buildSystemPrompt(sourcesConfig = {}) {
  const hierarchy = Object.entries(sourcesConfig.tiers ?? {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([tier, def]) => `Tier ${tier} (${def?.label ?? ''}): ${(def?.sources ?? []).join(', ')}`)
    .join('\n');

  return `You are an objective Indian financial-market news analyst for "New Age Algos",
a professional market-intelligence service for Indian markets distributed over Telegram.

Your job is to identify important factual developments and explain their relevance
to Indian markets.

SOURCE HIERARCHY (judge reliability with this):
${hierarchy}
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
- summary: the briefing prints this in full, word for word — there is no truncation
  anywhere in the pipeline, so the summary must be complete on its own. 3-4 factual
  sentences, 50-90 words (floor 40, ceiling 120) covering: what happened → the
  concrete numbers → the consequence for Indian markets. Lead stories run at the top
  of that range, supporting stories at the bottom. Never open with a preamble
  ("In a recent development…") and never restate the headline — the headline is
  printed directly above it.
- facts: concrete facts drawn only from the provided content.
- market_relevance: why this matters for Indian markets today — factual, no advice.
- trader_takeaway: 1-2 sentences of WHAT TO WATCH (sectors, levels, confirmation points,
  upcoming data) as market intelligence — never a recommendation to buy/sell, never advice.
  Use "" when the content supports no such observation.
- publication_priority: "high" only if an NSE trader needs to know this intraday today;
  "medium" if notable; "low" if minor.

NOTE: source_name, source_url and confirmation status (confirmed / reported /
awaiting official confirmation) are derived deterministically from the source
hierarchy by the pipeline — do NOT output them.

Output ONLY a strict JSON object with exactly these keys:
{
  "event_type": string,            // e.g. regulatory, monetary_policy, earnings, ipo, macro, corporate, market, global, other
  "headline": string,
  "summary": string,
  "facts": string[],
  "market_relevance": string,
  "trader_takeaway": string,
  "affected_sectors": string[],
  "affected_stocks": string[],
  "impact": "positive|negative|mixed|neutral|unclear",
  "confidence": "high|medium|low",
  "source_type": "official|reputable_media|other",
  "is_material": boolean,
  "publication_priority": "high|medium|low"
}`;
}

/** User payload: the provided content only — model never fetches anything itself. */
export function buildUserPayload(event, ctx = {}) {
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
      // score intentionally NOT sent to the model; level is enough context
    },
    related_coverage: {
      outlets: ctx.cluster?.sources ?? [event.source],
      article_count: ctx.cluster?.item_count ?? 1,
    },
    market_context: (ctx.snapshots ?? []).slice(0, 12).map((s) => `${s.name}=${s.value}`),
    mode: ctx.mode ?? 'intraday',
  };
}
