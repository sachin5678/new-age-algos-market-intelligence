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

Messages are delivered as **Telegram HTML** (`<b>`, `<i>`, `<u>`, `<code>`).
MarkdownV2 is deliberately not used: gramjs' MarkdownV2 parser ignores backslash
escapes and mangles hyphens, which made `\(Reuters\)` / `\-` render literally.

- **Intraday alert** (`formatAlert`): `🚨 MARKET ALERT` wire format — headline, 2–3
  sentence summary, 📌 market relevance, 🏭 sectors, 📊 stocks (only when the
  information supports the relationship), 🔎 source, ⚠️ status, `— New Age Algos`.
  Empty sections are omitted; raw scores/classification internals never appear.
- **Pre-market brief** (`--briefing premarket`): global cues (US/Asia, USD/INR,
  crude, gold), Indian setup (NIFTY/BANKNIFTY), top 5 developments, 6 watch items,
  6 key events, tagline footer.
- **Closing brief** (`--briefing closing`): NIFTY/BANKNIFTY, breadth, top/weak
  sectors, 5 key movers, top 5 developments, FII/DII, global cues, tomorrow to
  watch, tagline footer.

Briefings are built only from available data (snapshots from the inbox + recent
store events) — missing sections are omitted, never fabricated. Lists are capped
(5–8 items) so the feed stays concise.
