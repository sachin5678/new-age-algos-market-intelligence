# New Age Algos — Indian Market Intelligence System

Event-driven pipeline: **collect → normalize → dedupe → detect → classify importance → AI analysis → publish decision → Telegram output**.

Phase 1 implements the core pipeline with a full **dry-run** mode (no Telegram sends).
Phase 2 adds the **AI analysis + content-generation layer**: dedicated analyst system prompt,
source hierarchy, structured JSON verdict, wire-format alerts and scheduled briefings.

## Quick start

```powershell
cd E:\Desktop\YT\new-age-algos
npm test                 # unit tests (no network)
npm start                # intraday run, DRY_RUN from settings/.env (prints message)
node src/index.js --mode premarket --dry-run
node src/index.js --no-ai                    # rules-only (no OpenAI calls)
node src/index.js --briefing premarket --dry-run   # render the pre-market brief
node src/index.js --briefing closing --dry-run     # render the closing brief
```

## Layout

```
config/          feeds, categories, importance rules, entity dictionaries, source hierarchy, thresholds
src/
  providers/     MarketData / News / OfficialAnnouncement / GlobalMarket providers (independent, failure-isolated)
  normalize/     article normalization, category classification, entity extraction, source-tier registry
  dedupe/        canonical URL, title similarity, entity/semantic matching, clustering
  events/        hashing + NEW/UPDATED/DUPLICATE/KNOWN detection
  importance/    configurable HIGH/MEDIUM/LOW classification
  ai/            analyst system prompt (src/ai/prompt.js) + OpenAI service (structured JSON; never sends messages)
  briefings/     briefing context assembly (snapshots + store events → template context)
  publish/       shouldPublish() decision gates
  telegram/      alert + briefing formatting, transports (dry-run / JSON emit / gramjs later)
  store/         SQLite (node:sqlite) + in-memory store
  log/           structured stage logging with secret redaction
  pipeline.js    stage orchestration (each stage is its own module)
  index.js       CLI entry
test/            node:test unit + integration tests (offline fixtures)
state/           runtime: market.db, logs/, inbox/   (gitignored)
```

## MCP bridge (reuses existing OpenCode MCPs)

Standalone scripts cannot call MCP servers, so MCP-fed data is dropped into the **inbox**:

| Inbox file (in `state/inbox/`) | Producer | Provider that reads it |
|---|---|---|
| `official.json` | `nse` MCP circulars / SEBI-RBI pages via `firecrawl` | `OfficialAnnouncementProvider` |
| `market.json` | `nse` MCP (indices, breadth, movers) | `MarketDataProvider` |
| `global.json` | `yfinance` MCP (US/Asia, crude, gold, USDINR, Gift Nifty) | `GlobalMarketProvider` |

File shape: `{ "source": "...", "sourceType": "official|media", "tier": 1, "items": [ ...normalized articles or snapshots ] }`.

News is fetched directly (RSS HTTP) — the same 5 verified feeds the `rss` MCP uses (see `config/feeds.json`).

## DRY_RUN

`DRY_RUN=true` (default): the entire pipeline runs, the Telegram message is printed and logged under `TELEGRAM_SEND`, but nothing is sent.

## Deployment (GitHub Actions)

Production runs on GitHub Actions — no laptop, no OpenCode, no MCPs. Each run is a
one-shot job: collect → detect → format → send → persist state.

| Workflow | Trigger | Times (UTC / IST) |
|---|---|---|
| `market-intelligence.yml` | `schedule` + `workflow_dispatch` | `0 3 * * 1-5` → 08:30 IST pre-market · `*/5 3-10 * * 1-5` → every 5 min, 09:15–15:30 IST · `15 10 * * 1-5` → 15:45 IST closing |
| `market-intelligence-external.yml` | `repository_dispatch` (`market-check`, `premarket`, `closing`, `market-news`, `health-check`) | on demand — for precise-timing external cron |
| `ci.yml` | push / PR | tests + Docker image to `ghcr.io` |

**Repository secrets**

| Secret | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot API delivery in CI (stateless — no session file to carry between runs) |
| `TELEGRAM_CHAT_ID` | yes | Target chat/channel, e.g. `-1004497477393` |
| `OPENAI_API_KEY` | optional | AI classification; without it the pipeline runs rules-only |

The bot must be an **administrator of the channel** with *Post messages* right.

Transport selection is automatic: `TELEGRAM_BOT_TOKEN` present → Bot API,
otherwise the local GramJS session. `DRY_RUN` is `false` for scheduled runs;
manual `workflow_dispatch` runs honour the `dry_run` input (default: deliver).

State (`state/market.db`, `state/inbox`, `state/logs`) survives between runs
through `actions/cache`, so dedupe, cooldowns and the event graph persist.
`workflow_dispatch` input `no_ai: true` skips the OpenAI call.

Manual run:

```bash
gh workflow run market-intelligence.yml -f job_type=closing -f dry_run=false
```

External cron (cron-job.org, etc.) POST:

```json
{ "event_type": "market-check", "client_payload": { "dry_run": false } }
```

```bash
curl -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/OWNER/REPO/dispatches \
  -d '{"event_type":"market-check","client_payload":{"dry_run":false}}'
```

## Config knobs

- `config/importance.json` — HIGH/MEDIUM/LOW rules, auto-publish levels, min score.
- `config/settings.json` — market hours (IST), dedupe thresholds, cooldown/caps, AI model.
- `config/feeds.json` — news feeds (`enabled: false` to disable).
- `config/sources.json` — source → tier hierarchy (also rendered into the AI prompt).
- `config/official_sources.json` — **empty by design**: add only verified official (BSE/SEBI/RBI) URLs; none are invented.

## Source hierarchy (`config/sources.json`)

| Tier | Label | Examples | Treatment |
|---|---|---|---|
| 1 | official | NSE, BSE, SEBI, RBI, Government, exchange filings | **Confirmed** |
| 2 | reputable_media | Reuters, Bloomberg, Economic Times, Business Standard, CNBC-TV18, Mint, Financial Express, BusinessLine | Reported |
| 3 | reputable_financial_press | Moneycontrol, NDTV Profit, PTI … | Reported |
| 4 | commentary_social | Twitter/X, YouTube, Reddit … | **Never** treated as confirmed fact |

The registry (`src/normalize/sources.js`) resolves source → tier at normalization
(match, alias, then containment; unknown sources keep the feed-declared tier).
The tier drives:

- the AI system prompt (hierarchy + per-article tier note),
- the Telegram **Status** line: `Confirmed` / `Reported` / `Awaiting official confirmation` / `Unconfirmed`,
- importance boosts (official) and penalties.

## AI analysis (`src/ai/prompt.js` + `src/ai/openaiService.js`)

Dedicated analyst system prompt: objective Indian-market news analyst; prioritises
primary sources; distinguishes confirmed vs reported; no speculation, sensational
language, guarantees, personalised advice or buy/sell recommendations; never
fabricates data, sources, quotations, prices or percentages.

Verdict schema (strict JSON, validated/coerced — never throws):

```json
{ "event_type": "", "headline": "", "summary": "", "facts": [],
  "market_relevance": "", "affected_sectors": [], "affected_stocks": [],
  "impact": "positive|negative|mixed|neutral|unclear",
  "confidence": "high|medium|low",
  "source_type": "official|reputable_media|other",
  "is_material": true, "publication_priority": "high|medium|low" }
```

AI is only consulted for HIGH/MEDIUM candidates; LOW is gated deterministically.
Disabled/failing AI (or an out-of-credit key) → rules-only fallback verdict with
`confidence: low` — single-source media then fails the verification gate and is held.

## Telegram output

Messages are delivered as **Telegram HTML** (`<b>`, `<i>`, `<u>`, `<code>`,
`<blockquote>`, `<a href>`) — MarkdownV2 is deliberately not used: gramjs'
MarkdownV2 parser ignores backslash escapes and mangles hyphens, which made
`\(Reuters\)` / `\-` render literally.

Every message is built by the shared template system (`src/telegram/theme.js`
for primitives, `format.js` for alerts/snapshot, `briefings.js` for scheduled
briefs) and framed with the brand block:

```
🌅 <b>NEW AGE ALGOS</b>
━━━━━━━━━━━━━━━━━━━━
📊 <b>PRE-MARKET INTELLIGENCE</b>
<i>04 OCT 2026 • 08:30 IST</i>
…
━━━━━━━━━━━━━━━━━━━━
⚡ <b>NEW AGE ALGOS</b>
<i>Data-driven • Systematic • Transparent</i>
```

Templates:

| Template | Function | Shape |
| --- | --- | --- |
| Breaking / high-impact alert | `formatBreakingAlert` | slug → fact → 📌 why it matters → 📊 market impact → 🧠 view (blockquote) → 🔗 source + ✅/🟡/⚠️ status |
| Regular market update | `formatIntradayAlert` | compact version of the same, with 👀 watch line |
| Market snapshot | `formatMarketSnapshot` | monospace `<code>` dashboard: indices, breadth, flows, leaders/laggards |
| Pre-market intelligence | `formatPreMarket` | WHAT MATTERS TODAY (≤5) → watch → global cues → Indian setup → key events → view |
| Market wrap | `formatClosing` | indices → breadth → key driver → what moved → laggards → movers → flows → global → tomorrow's watch → view |

Rules baked in:

- **Fact / relevance / interpretation are visually separated.** The view is only
  rendered when the AI actually produced a `trader_takeaway`; relevance only when
  `market_relevance` exists — nothing is invented in rules-only mode.
- **Confirmation status comes from the source hierarchy** (tier 1 → ✅ Confirmed,
  media on a regulatory topic → ⚠️ Awaiting official confirmation, tier 4 →
  Unconfirmed) — never from the model.
- **Sources are hyperlinked only when a real http(s) URL exists**, always escaped;
  otherwise the source name is plain text.
- **Every dynamic value is HTML-escaped** (`<`, `>`, `&`), including headlines
  like `C++ / 5% / (FY24)`.
- **Length budget 3600 chars**: density is reduced (fewer items, shorter
  paragraphs, optional sections dropped) before any split; split parts are
  labelled `part 1 of 2`.
- Missing metrics are omitted — never rendered as `0` or `NaN`.

Preview all five templates with real-looking fixtures (nothing is sent):

```bash
npm run samples        # scripts/print-samples.mjs
```

Briefings are built only from available data (snapshots from the inbox + recent
store events) — missing sections are omitted, never fabricated. Lists are capped
(5–8 items) so the feed stays concise.
