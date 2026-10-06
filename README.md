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
  short/         Market → Short factory (story + market-recap shorts, en/hinglish/hindi voice): script → edge-tts voice → scene PNGs → captions → ffmpeg MP4
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

| Workflow | Trigger | Times |
|---|---|---|
| `market-intelligence.yml` | `workflow_dispatch` only — called by **cron-job.org** | see the cron-job.org jobs below |
| `market-intelligence-external.yml` | `repository_dispatch` (`market-check`, `premarket`, `closing`, `market-news`, `health-check`) | on demand — optional alternative path; also `target`-guarded |
| `ci.yml` | push / PR | tests + Docker image to `ghcr.io` |

**Scheduling: cron-job.org, not GitHub's scheduler**

GitHub's `schedule:` trigger was removed on purpose — it never fired for this
account (0 runs in 26h, including a `*/5 * * * *` probe), and when it did fire
for this account it ran **hours late**, which for a market briefing means stale
content posted as if fresh. The three schedules now live in the cron-job.org
console, which POSTs `workflow_dispatch`:

| Job | cron-job.org schedule | `job_type` |
|---|---|---|
| Pre-market briefing | `0 3 * * 1-5` (08:30 IST) | `premarket` |
| Market check | `*/5 3-10 * * 1-5` (every 5 min, 09:15–15:30 IST) | `market-check` |
| Closing briefing | `15 10 * * 1-5` (15:45 IST) | `closing` |

Each job POSTs to
`/repos/OWNER/REPO/actions/workflows/market-intelligence.yml/dispatches`
with a JSON body of `{"ref":"main","inputs":{"job_type":"…","target":"live"}}`.
cron-job.org reports a job as healthy only on HTTP 2xx, and GitHub returns
`204` for an accepted dispatch, so a rejected request (401 expired token, 403
bad User-Agent) surfaces as a job failure with e-mail notification.

**The production guard:** `target` defaults to `test`, and only the exact value
`live` resolves `TELEGRAM_CHAT_ID` to the production secret. A cron job whose
body omits `target` — or is mis-typed — posts to the **test group**
`-1004497477393`, never to the main channel. To send to production, the job
body must literally contain `"target":"live"`.

**Repository secrets**

| Secret | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot API delivery in CI (stateless — no session file to carry between runs) |
| `TELEGRAM_CHAT_ID` | yes | Target chat/channel — production uses the main channel `-1003067155583` (@newagealgos) |
| `OPENAI_API_KEY` | optional | AI classification. Despite the name it accepts **any OpenAI-compatible key** — see below |

**AI provider (OpenAI-compatible)**

`config/settings.json` → `ai`:

| Key | Default | Purpose |
|---|---|---|
| `baseUrl` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint — Gemini `https://generativelanguage.googleapis.com/v1beta/openai`, Groq `https://api.groq.com/openai/v1`, OpenRouter `https://openrouter.ai/api/v1` |
| `model` | `gpt-4o-mini` | Model id at that endpoint |
| `maxRetries` | `4` | Retries `429`/`5xx` with exponential backoff + jitter; honours `Retry-After` |
| `backoffBaseMs` | `2000` | Backoff base: 2s → 4s → 8s → 16s |
| `maxEventsPerRun` | `20` | Hard cap on AI calls per run |

Retries are load-bearing: without them a single `429` makes the provider chain
fall through to `RulesOnlyProvider`, which always emits `confidence: "low"` — and
`shouldPublish` then rejects the event as `unverified`. One rate limit would
silently disable alerting for that event, which is why the code waits and retries
instead (Google's prescribed handling for `429`).

The bot must be an **administrator of the channel** with *Post messages* right.

Transport selection is automatic: `TELEGRAM_BOT_TOKEN` present → Bot API,
otherwise the local GramJS session. `DRY_RUN` is `false` unless the `dry_run`
input is set, so a cron run with no inputs delivers for real.

State (`state/market.db`, `state/inbox`, `state/logs`) survives between runs
through `actions/cache`, so dedupe, cooldowns and the event graph persist.
`workflow_dispatch` input `no_ai: true` skips the OpenAI call.

Manual run (posts to the **test group** unless `target=live`):

```bash
gh workflow run market-intelligence.yml -f job_type=closing -f dry_run=false
```

External cron POST (the form cron-job.org uses — note `target`, not `event_type`):

```json
{ "ref": "main", "inputs": { "job_type": "market-check", "target": "live" } }
```

```bash
curl -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/OWNER/REPO/actions/workflows/market-intelligence.yml/dispatches \
  -d '{"ref":"main","inputs":{"job_type":"market-check","target":"live"}}'
```

Omit `target` (or set `"test"`) to keep the run in the test group.

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

## Visual Briefing System

In addition to the text templates above, the pipeline can render **deterministic PNG images** for scheduled briefings and breaking alerts — no AI image generation, no paid SaaS, no external services. Pure HTML+CSS → headless Chromium (Puppeteer-core driving system Chrome) → exact pixel output.

**Delivery format: PNG only.** Each image is sent with a single-line caption saying what it is — for example `Pre-Market Intelligence | Monday, 05 October 2026, 08:30 IST | Overnight global cues, yesterday's session and today's agenda — including sources. | Page 1 of 7` (page 2 gets its own short caption when a report spills over). The A4 PDF renderer still exists but is off by default (`VISUAL_PDF=true` to opt in) because several PDF viewers drop painted page backgrounds, so the dark theme renders inconsistently.

### Templates

Every briefing is **content-sized**. The renderer measures the packed content and gives each page the smallest height that actually contains it (rounded up to 20 px). `VISUAL_HEIGHT` is a **ceiling, never a fixed size** — so a light report renders shorter than 1600 px instead of printing an empty lower third, and a rich one flows to a second page instead of shrinking the type.

| Template | Width | Height | Trigger | Caption (one line) |
|---|---|---|---|---|
| 🟦 **Pre-Market Intelligence** | 1080 | content, ≤ 1600 (page 1 ≥ 1080) | `--mode premarket --briefing premarket --visual` | `Pre-Market Intelligence \| <date> \| <blurb> \| Page 1 of N` |
| ⬛ **Market Close** | 1080 | content, ≤ 1600 (page 1 ≥ 1080) | `--mode closing --briefing closing --visual` | `Market Close \| <date> \| <blurb> \| Page 1 of N` |
| 🟥 **Breaking Market Alert** | 1080 | content, 760–1080 | `VISUAL_ALERTS=true` on HIGH-importance events | `Breaking news • <time> IST` |

### What’s in the images

**Pre-Market (multi-page):**
- **Page 1 — executive:** header, MARKET PULSE, 🌅 OVERNIGHT / GLOBAL CUES, WHAT HAPPENED YESTERDAY
- **Then, in order:** editorial cards, 🌙 OVERNIGHT DEVELOPMENTS, 👀 KEEP AN EYE ON TODAY, STOCKS TO WATCH, SECTORS TO WATCH, TODAY’S CATALYSTS, RISKS, 🎯 NEW AGE ALGOS VIEW, SOURCES
- Sections with no reliable data are **omitted**, never rendered as empty decoration
- A quiet overnight prints `No major new overnight developments identified in this window.` and the report still fills from yesterday’s session, the look-ahead agenda, global cues, stocks and sectors — it is never an empty page

**Market Close (multi-page):**
- HEADER, MARKET PULSE, WHAT DROVE THE MARKET (editorial synthesis — never a copy of a headline), KEY DEVELOPMENTS, MARKET BREADTH, FII/DII, TOP GAINERS, TOP LOSERS, SECTOR MOVEMENT, TOMORROW’S WATCH, CATALYSTS, RISKS, NEW AGE ALGOS VIEW, SOURCES

**Editorial news card** — the unit both reports are built from:
- `01  SECTION LABEL  🏷️ WINDOW TAG` — numbered, window-classified
- Full headline, wrapping to 1–3 lines — never clipped
- Summary printed **word for word** (3–4 sentences; nothing in the pipeline truncates)
- `WHY IT MATTERS` — 1–2 sentences
- `SOURCE • TIME` — `LiveMint • 06:17 IST`, or `Moneycontrol • 01 Oct 2026` when the story is from another day
- Impact + status badges; supporting outlets listed as `Also covered by: The Economic Times`

**Alert (1080 × content, 760–1080):**
- Sample banner, ⚡ BREAKING MARKET ALERT + category chip, full headline, why it matters, AFFECTED chips, IMPACT / CONFIRMATION, source + time, footer
- The canvas is measured first and only grows to 1080 when the content needs it — a light alert never prints a band of empty background

### Optional A4 PDF (off by default)

4 pages, selectable text, clickable links — pre-market/closing only (not alerts). Enable with `VISUAL_PDF=true`:

1. **Executive Summary** — view + market pulse + top 3 headlines
2. **Market & Global Cues** — full indices table + breadth/flows (closing) + global cues table
3. **Top Developments** — full stories with clickable source links + key driver (closing)
4. **Stocks/Sectors/Risks/View/Sources** — tables + bullets + source list + disclaimer

Not used in production: PNG is the delivery format because PDF viewers disagree about painting dark page backgrounds.

### Content selection (windows, relevance, quotas)

The report is built around **three windows**, not around article freshness:

| Window | Pre-market | Market close |
|---|---|---|
| 🌅 / 🌙 **Overnight** | previous close → 08:30 IST today | previous close → today’s open |
| 👀 / 📊 **Previous session** | yesterday’s session (holiday-aware) | today’s session |
| 📅 **Look ahead** | today’s catalysts and agenda | tomorrow’s watchlist |

- **Windows are holiday-aware** — Monday 05 Oct 2026 resolves its “yesterday” to Thursday 01 Oct because Friday 02 Oct is Gandhi Jayanti, not to Friday.
- **Event relevance beats article freshness.** A two-day-old policy thread with unresolved market implications scores above an hour-old trivia piece (`relevanceScore`).
- Every story is classified `NEW / ONGOING / UPDATED / FOLLOW-UP / PREVIOUS SESSION — STILL RELEVANT` and carries the matching tag.
- **Bucket quotas** guarantee each named window is actually present (`PREMARKET_QUOTA = {updated:1, overnight:3, session:2, earlier:1}`, `CLOSING_QUOTA = {updated:1, closing_session:3, overnight:2, earlier:1}`); unused slots are then backfilled in rank order up to the cap.
- **Stories are never shortened to fit.** Raising or lowering the cap adds or removes whole stories; the summary always prints in full.
- **One event, one card.** Reports of the same circular from different outlets are merged — headline similarity plus “same institution + same category” — with the rest kept as `supporting_sources`, and the visible numbering renumbered 01..N.
- `WHAT DROVE THE MARKET` is an editorial synthesis of the session; `KEY DEVELOPMENTS` are the individual events. The two never repeat each other.

### Pagination

1. `buildPagePlan` slices the report into indivisible fragments (a fragment never shrinks).
2. `measureFragments` measures every fragment in **one** Chromium pass.
3. `packPages` packs them with lookahead: a `keepWithNext` heading is only placed if the block it introduces also fits, so no section title is ever stranded at the foot of a page.
4. Each page gets the **smallest** height that contains it — `PAGE_PAD` reserved, footer reserved, 6 px of measurement safety, rounded up to 20 px.

The page cap is **advisory**: content is never discarded to stay under it. `hardMaxPages` (10) aborts the render instead of shipping an absurd album, and the render failure falls back to the text briefing. The adaptive re-plan loop (up to 4 passes) drops the story cap rather than the story text when a plan overflows.

**Page-count reality** (measured on the sample fixture): non-story sections alone need ≈5 pages, and each full-width editorial card costs one page. So a loaded day is 7–8 pages at `imageCap: 3`, while the PDF carries the full `developments_full` selection (cap 10). Content volume — not font size — sets the page count.

### Local commands

```bash
npm run render:premarket   → artifacts/preview/premarket-p1..pN.png + .pdf
npm run render:closing     → artifacts/preview/closing-p1..pN.png + .pdf
npm run render:alert       → artifacts/preview/alert.png

# Direct preview harness (sample/fixture data, no network, no store)
node scripts/render-preview.mjs premarket --sample              # full pre-market
node scripts/render-preview.mjs premarket --sample --quiet      # empty-overnight edge case
node scripts/render-preview.mjs closing  --sample
node scripts/render-preview.mjs alert    --sample
node scripts/render-preview.mjs premarket --sample --json       # briefing JSON for inspection

# Empty-band check: decodes the PNG and reports the longest run of pure
# background rows (fails above 90 px)
node scripts/gh-pngscan.mjs artifacts/preview/premarket-p1.png

npm run premarket -- --visual --dry-run   # full pipeline, saves files, prints JSON, no send
```

### Production behaviour (GitHub Actions)

- `VISUAL_BRIEFING=true` on pre-market/closing scheduled steps (`VISUAL_PDF` stays `false` — PNG only)
- `VISUAL_ALERTS=true` on intraday market-check step
- Target chat comes from the `TELEGRAM_CHAT_ID` secret — production points at the main channel **@newagealgos** (`-1003067155583`); the bot must be an admin with *Post messages*
- Artifacts uploaded as `visual-briefings` (7-day retention)
- Render failure → logged, falls back to text briefing, never sends broken image
- No browser install needed — ubuntu-latest runners ship Google Chrome
- No secrets exposed; Bot API transport only

### Design guarantees

- **Content decides the box** — page height is measured from content (rounded up to 20 px); `VISUAL_HEIGHT` is a ceiling, so there is no fixed empty space and no footer pinned over a void
- **Zero truncation** — no `text-overflow: ellipsis`, no `-webkit-line-clamp`, no truncation helper in the component layer, and no `overflow:hidden` on editorial containers; headlines and summaries wrap and the page grows instead. Enforced by `test/visual-layout.test.js`
- **Minimum type size** — nothing renders below `MIN_FONT` (12 logical px = 24 output px) anywhere in the theme
- **Never an orphan heading** — a section title travels with its first block (`packPages` lookahead)
- **Deterministic rendering** — same data → byte-identical PNG (verified by QA gate)
- **Correct dimensions** — every page is checked against the dimensions it was rendered at (page 1 ≥ 1080, all pages ≤ 1600, alert 760–1080)
- **QA gate before send** — file exists, non-empty, correct dimensions, no `undefined`/`null`/`[object Object]`/`NaN` in visible text, no duplicate stories, no fabricated URLs, content does not overflow the canvas
- **Empty-band scan** — `scripts/gh-pngscan.mjs` decodes the PNG and rejects any run of pure-background rows over 90 px
- **Performance** — PNG < 10s, PDF < 15s (typical 2.5–3.5s)
- **Font embedding** — Inter (400/500/600/700) as base64 woff2 in CSS; zero network at render time
- **No AI visuals** — AI generates structured content only; the visual is pure code
- **Missing data = N/A** — never hallucinated prices/percentages/sources/URLs/dates; a section with no reliable data is omitted rather than rendered empty
- **Confirmation labels** from source hierarchy only: Confirmed / Reported / Awaiting official confirmation / Unconfirmed
- **Analysis, not advice** — `NEW AGE ALGOS VIEW` is a synthesis of what is already on the page; never a BUY/SELL call and never personalised advice
- **Test posts only reach the test group** — `-1004497477393`, never the main channel (see `## Telegram output`)

## Market → Short factory (`src/short/`)

Turns one market event into a publishable 9:16 Short — fully local and fully free:

```
event + verdict → script → voice → scene PNGs → burned captions → short.mp4 → Telegram → YouTube
```

| Stage | Module | Free tool |
|---|---|---|
| Script (hook → facts → why → CTA) | `src/short/script.js` | deterministic — reuses the pipeline's stored AI verdict (no model call) |
| Voice + word timings | `src/short/voice.js` | `edge-tts` (Microsoft neural voices, en-IN-Prabhat/Neerja) |
| Scene PNGs 1080×1920 | `src/short/scenes.js` | headless Chrome via the existing visual engine |
| Burned captions | `src/short/captions.js` | ffmpeg + libass (styled ASS from word timings) |
| Video assembly | `src/short/assemble.js` | ffmpeg (segment → concat → burn → mux) |
| QA gate | `src/short/qa.js` | ffprobe checks before anything leaves the box |

### Local commands

```bash
npm run short                  # newest store event → artifacts/shorts/run-<ts>/short.mp4 + meta.json
npm run recap                  # today's market recap: top gainers/losers + candle charts + store news
npm run short -- --demo        # labelled SAMPLE event, no store needed
npm run short -- --event <id>  # a specific event
npm run short -- --ai          # fresh (free-tier) AI verdict instead of the stored one
npm run short -- --lang hinglish   # Hinglish voiceover (English visuals, Hinglish captions)
npm run short -- --lang hindi      # Hindi voiceover (Devanagari narration, hi-IN voice)
npm run recap  -- --type recap ... # recap: --lang works the same way
npm run short -- --notify      # also send the MP4 to the Telegram content queue
npm run short -- --upload      # publish the finished MP4 to YouTube (free Data API v3)
npm run short -- --upload-all  # publish every finished run not yet on YouTube (no render)
npm run short -- --voice en-IN-NeerjaNeural --rate +8%
```

Requirements (all free, one-time local setup):

- `edge-tts` — `pip install edge-tts` (free neural TTS, emits SRT timings)
- `ffmpeg`/`ffprobe` — discovered via `PATH` or `%LOCALAPPDATA%\ffmpeg` (or set `FFMPEG_PATH`)
- Chrome/Edge — already used by the briefing renderer

### Hinglish / Hindi narration (`--lang`)

- **On-screen text stays English** (punchy, fast to read — standard for Indian
  finance Shorts); what changes is the spoken narration, which flows into
  edge-tts and therefore into the burned captions automatically.
- Rewrite order: **free Gemini tier** (`settings.ai`, `langMode: ai`) →
  deterministic **lexicon fallback** when no key is configured (`langMode: lexicon`).
  CTA + "why it matters" are per-language templates; recap narration is fully
  template-based (`langMode: template`), so recap shorts never need the AI.
- Voice presets: `en` → `en-IN-NeerjaNeural` at `+14%` (channel default — female
  Indian English, fast Shorts pace), `hinglish` → `en-IN-PrabhatNeural` (reads
  Romanized Hinglish well), `hindi` → `hi-IN-MadhurNeural` (Devanagari).
  Override with `--voice` / `--rate`.

### Market recap (`--type recap` / `npm run recap`)

A second short type built from live data instead of a single event:

```
top gainers/losers + index pulse + store news → scenes with candle charts → short.mp4
```

| Stage | Module | Free source |
|---|---|---|
| Movers + index pulse | `src/short/marketData.js` | Yahoo Finance public chart API (keyless; NSE site/MCP were unreliable — 404s / empty at close) |
| News on a mover | `src/short/marketData.js` | the pipeline's own store events (title/description/company match) |
| Candlestick chart | `src/short/charts.js` | deterministic inline SVG themed by the central theme |
| Scenes (hook + movers + CTA) | `src/short/recap.js` + `src/short/scenes.js` | template narration per language, no AI call |

- Scene flow: `MARKET RECAP` hook (NIFTY 50 / NIFTY BANK / SENSEX pulse) →
  top 3 gainers + top 3 losers (rank chip, % move, close, 20-session candle
  chart, NEWS strip when the store has a matching event) → brand CTA.
- Failed quotes are skipped, never fabricated; zero movers (Yahoo unreachable)
  fails with a hint to use `--demo`. `npm run recap -- --demo` renders a
  labelled SAMPLE fixture with synthetic candles.
- Weekends/holidays exit early ("no new session to recap") so a closed market
  can never re-publish the previous session's movers under a new date.

### Auto-upload to YouTube (`--upload`)

`src/youtube.js` publishes finished shorts through the **free YouTube Data
API v3** (10 000 quota units/day; one upload = 1 600 → six uploads/day, we
need two). Uploads use OAuth refresh tokens — nothing paid, nothing third-party.

One-time Google setup (~3 minutes, follow the steps the script prints):

1. Google Cloud Console → enable **YouTube Data API v3**
2. OAuth consent screen → External → add `youtube.upload` scope + yourself as
   test user → **PUBLISH APP** (in "Testing" mode Google expires the refresh
   token after 7 days)
3. Credentials → OAuth client ID → **Desktop app** → download JSON → save as
   `~/.secrets/youtube-client.json`
4. `node scripts/youtube-auth.mjs` → approve in the browser once → the refresh
   token is stored in `~/.secrets/youtube-auth.json` (gitignored)
5. For **CI uploads** (the scheduled runs), also add the same values as repo
   secrets — GitHub repo → Settings → Secrets and variables → Actions →
   `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`
   (+ optional `YOUTUBE_PRIVACY`) — `loadCredentials` reads them from env

Guarantees:

- **Dedup registry** `state/youtube-uploads.json` keys every short
  (`event:<id>` / `recap:<YYYY-MM-DD>`) — re-renders, retries and backfills
  never post the same content twice; story selection prefers never-published
  events. Instagram cross-posts reuse the same file with `insta:`-prefixed
  keys (`insta:event:<id>`), so the workflow cache version never changes
- **Samples never upload** — demo/labelled test data stays on disk (§27)
- Thumbnail = hook-scene PNG (soft-fail if >2 MB); `YOUTUBE_PRIVACY=public|unlisted|private`

### Auto-upload to Instagram Reels (`--upload`, free Graph API)

`src/instagram.js` cross-posts the **same MP4** as a Reel through the official
**Instagram Content Publishing API** (free; quota 100 API-published posts per
rolling 24 h, the schedule needs two). No third-party tools, no unofficial
scrapers — the channel account can never be shadow-banned for automation.

One-time Meta setup (~10 minutes, all free, no app review for our own account):

1. Instagram → Settings → Account → **Switch to professional account →
   Creator**; the account must be **public** (private accounts cannot
   publish via API)
2. Create a **Facebook Page** for the brand from your personal Facebook
   account (facebook.com → Menu/Pages → **Create new Page**, ~1 min) and
   link it to Instagram — either IG → **Edit profile → Page → Connect**
   or FB Page → **Settings → Permissions → Linked accounts → Instagram**
   (Accounts Center "Sharing across profiles" alone is NOT the link the
   API needs — it must be the Page link)
3. developers.facebook.com → *Get Started* → **Apps → Create App → Business**
   → add the **Instagram Graph API** product
4. **Graph API Explorer** → select the app → add permissions
   `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`
   → **Generate Access Token** → copy it (plus *App ID* / *App Secret* from
   app Settings → Basic)
5. `node scripts/instagram-auth.mjs <token> <app-id> <app-secret>` —
   exchanges it for a long-lived **page token**, discovers the Page +
   Instagram ids, writes `~/.secrets/instagram-auth.json` (gitignored)
6. Add repo secrets `IG_ACCESS_TOKEN` + `IG_USER_ID` — scheduled runs then
   cross-post every short automatically (local runs read the auth file)

Notes:

- **Hosting**: Meta fetches the video from a public URL, so each run pushes
  the MP4 to a free temp host first (`tmpfiles.org` 60 min → `uguu.se` 24 h
  → `catbox.moe` last resort) — it only needs to survive the seconds Meta
  takes to grab it (`0x0.st` stopped accepting uploads in 2026, so it is
  out of the chain)
- **Missing secrets are a no-op**: the run logs `⚠ Instagram not configured`
  and still exits green
- Reel spec compliance is automatic: our 1080×1920 H.264 MP4 (~40 s, ~1–3 MB)
  sits well inside Meta's limits (≤15 min, ≤300 MB, 23–60 fps)

### Twice-daily schedule (cron-job.org → GitHub Actions)

The schedule lives where the rest of the fleet lives: **cron-job.org dispatches
`short-factory.yml`** — cloud runs, PC not required:

| cron-job.org job | Fires (Mon–Fri) | Dispatches |
|---|---|---|
| `New Age Algos \| Story Short (09:00 IST)` | 09:00 IST | `short-factory.yml` `type=story lang=en upload=true` |
| `New Age Algos \| Recap Short (16:15 IST)` | 16:15 IST | `short-factory.yml` `type=recap lang=en upload=true` |

Each CI run: `apt ffmpeg` + `pip --user edge-tts` (both free) → restore the
shared `market-state-` cache (upload registry + prior state) → refresh its own
events via `market-check --dry-run` (fetch + store, no sends) →
`make-short --type … --upload` (YouTube + Instagram Reels) → save state back
→ publish the
`short-<type>-<run_id>` artifact (MP4 + meta + SRT, kept 7 days).

- Events are self-fetched every run, so a cold or missing cache never blocks
  the story (no cross-workflow dependency on the 08:30 pre-market run's save)
- Job ids for API edits: story = `8588155`, recap = `8588157`
- No YouTube secrets yet → logs "not authorised" and still renders — the
  consent step never blocks rendering
- Change time/language: edit the two jobs in the cron-job.org console (API:
  `PATCH /api/jobs/<id>`) or the `lang` default in `short-factory.yml`

**Local fallback (registered, disabled):** Windows tasks
`NewAgeShorts-Story` / `NewAgeShorts-Recap` + wrapper
`scripts/scheduled-short.ps1` (logs in `logs/`). Re-enable with
`schtasks /Change /TN NewAgeShorts-Story /ENABLE` or re-register via
`scripts/register-short-tasks.ps1`. ⚠️ Never run both at once — local and CI
keep **separate** dedup registries → double uploads. Once CI owns publishing,
skip manual `--upload-all` from this machine too.

### Outputs per run

`artifacts/shorts/run-<ts>/` (gitignored):

- `short.mp4` — 1080×1920 h264/aac, ~35–50s, captions burned in
- `meta.json` — YouTube-ready `title` (≤100 chars + #Shorts), `description`, hashtags, per-scene timings
- `scene-*.png`, `voice.mp3`/`.srt`, `captions.ass` — intermediates kept for debugging

### Design guarantees

- **QA gate before delivery** — duration 18–75s, exact 1080×1920, h264+aac, size floor
- **Scene ↔ speech sync** — TTS word timings map each scene to its spoken window (proportional fallback if text diverges)
- **Same visual system as briefings** — central theme, no hard-coded colors (§27), deterministic rendering
- **No AI visuals, no paid API anywhere** — script text comes from the stored verdict (the only model call in the chain is the optional free-tier Hinglish/Hindi rewrite); voice/scenes/video are local free tools
- **Caption zone reserved** — scene layout keeps the bottom band clear of the Shorts UI
