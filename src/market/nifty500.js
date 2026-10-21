/**
 * NIFTY 500 movers — the data stage behind the post-market wrap.
 *
 * Two public sources, both keyless:
 *
 *   1) Constituents — NSE publishes the live NIFTY 500 list as a CSV
 *      (nsearchives.nseindia.com). The NSE *JSON* API 404s from automation,
 *      so the archive CSV is the one endpoint that works. A bundled copy in
 *      config/nifty500.json is the fallback when the fetch fails.
 *
 *   2) Day % change — Yahoo's public spark endpoint answers up to 20 symbols
 *      per request (30+ is rejected with HTTP 400). Anything the batch
 *      misses is filled in with the per-symbol chart endpoint, which also
 *      returns the company's display name.
 *
 * Every rule here follows the product's core promise: a missing symbol is
 * skipped, never guessed, and a run that cannot see enough of the index
 * reports what it actually saw instead of inventing numbers.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_LIST = path.join(HERE, '..', '..', 'config', 'nifty500.json');

/** NSE archive CSV with the live NIFTY 500 constituents. */
export const NSE_NIFTY500_CSV_URL =
  'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };

/** Yahoo rejects spark requests with more than 20 symbols. */
export const SPARK_CHUNK_SIZE = 20;

/** Parallel spark requests — too many and Yahoo starts answering partially. */
export const SPARK_CONCURRENCY = 4;

/** A bar older than this many days is not "today's move" — it is stale. */
const MAX_SESSION_AGE_MS = 4 * 86_400_000;

const DAY_MS = 86_400_000;

/** Split one CSV line, honouring quoted cells. */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/**
 * "Company Name,Industry,Symbol,Series,ISIN Code" → [{symbol,name,industry}].
 * Rows without a usable symbol are dropped (never guessed).
 */
export function parseConstituentsCsv(csv) {
  const lines = String(csv ?? '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const iName = header.indexOf('company name');
  const iIndustry = header.indexOf('industry');
  const iSymbol = header.indexOf('symbol');
  if (iSymbol < 0) return [];

  const rows = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const symbol = cells[iSymbol] ?? '';
    if (!/^[A-Z0-9&.-]{1,20}$/.test(symbol)) continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    rows.push({
      symbol,
      name: (iName >= 0 ? cells[iName] : '') || symbol,
      industry: (iIndustry >= 0 ? cells[iIndustry] : '') || '',
    });
  }
  return rows;
}

/** Bundled fallback list (config/nifty500.json) — the last known constituents. */
export async function loadBundledConstituents(file = BUNDLED_LIST) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed?.constituents;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r && /^[A-Z0-9&.-]{1,20}$/.test(String(r.symbol ?? '')))
      .map((r) => ({
        symbol: String(r.symbol),
        name: String(r.name ?? r.symbol),
        industry: String(r.industry ?? ''),
      }));
  } catch {
    return [];
  }
}

/**
 * The NIFTY 500 constituents: live CSV first, bundled copy as the fallback.
 * @returns {Promise<{rows: Array<{symbol,name,industry}>, source: 'nse-csv'|'bundled'}>}
 */
export async function fetchConstituents({ fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  try {
    const res = await fetchImpl(NSE_NIFTY500_CSV_URL, {
      headers: UA,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const rows = parseConstituentsCsv(await res.text());
      if (rows.length >= 100) return { rows, source: 'nse-csv' };
    }
  } catch {
    /* fall through to the bundled list */
  }
  const bundled = await loadBundledConstituents();
  return { rows: bundled, source: bundled.length ? 'bundled' : 'none' };
}

/** Yahoo symbol for an NSE ticker ("RELIANCE" → "RELIANCE.NS"). */
export function toYahooSymbol(symbol) {
  return String(symbol ?? '').trim().toUpperCase().endsWith('.NS')
    ? String(symbol).trim()
    : `${String(symbol).trim()}.NS`;
}

/** "RELIANCE.NS" → "RELIANCE" */
export function fromYahooSymbol(symbol) {
  return String(symbol ?? '').replace(/\.NS$/i, '');
}

/**
 * One spark response → rows.
 *
 * The last daily bar and the bar before it give the session move; the
 * response's own `fulldayChangePercent` is only used when the bar series is
 * too short to compute it. Rows without a usable price are dropped.
 */
export function parseSparkResponse(payload) {
  const rows = [];
  for (const [symbol, v] of Object.entries(payload ?? {})) {
    if (!v || typeof v !== 'object') continue;

    const closes = Array.isArray(v.close) ? v.close.filter((c) => typeof c === 'number' && Number.isFinite(c)) : [];
    const stamps = Array.isArray(v.timestamp) ? v.timestamp : [];
    const price =
      typeof v.fulldayPrice === 'number' && Number.isFinite(v.fulldayPrice)
        ? v.fulldayPrice
        : closes.length
          ? closes[closes.length - 1]
          : null;

    let pct = null;
    if (closes.length >= 2) {
      const prev = closes[closes.length - 2];
      if (prev > 0) pct = ((price - prev) / prev) * 100;
    }
    if (pct == null && typeof v.fulldayChangePercent === 'number' && Number.isFinite(v.fulldayChangePercent)) {
      pct = v.fulldayChangePercent;
    }
    if (pct == null && typeof price === 'number' && typeof v.chartPreviousClose === 'number' && v.chartPreviousClose > 0) {
      pct = ((price - v.chartPreviousClose) / v.chartPreviousClose) * 100;
    }

    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) continue;

    const ts = stamps.length ? stamps[stamps.length - 1] : (v.timestamp?.[0] ?? null);
    rows.push({
      symbol: fromYahooSymbol(symbol),
      yahooSymbol: symbol,
      price,
      pct,
      sessionAt: typeof ts === 'number' && ts > 0 ? ts * 1000 : null,
    });
  }
  return rows;
}

/** One per-symbol chart request — the gap filler for a partial batch. */
export async function fetchChartRow(yahooSymbol, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`;
    const res = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
      (c) => typeof c === 'number' && Number.isFinite(c)
    );
    const stamps = result?.timestamp ?? [];
    const price = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : closes.at(-1);
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;

    let pct = null;
    if (closes.length >= 2 && closes[closes.length - 2] > 0) {
      pct = ((price - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
    } else if (typeof meta.regularMarketChangePercent === 'number') {
      pct = meta.regularMarketChangePercent;
    } else if (typeof meta.chartPreviousClose === 'number' && meta.chartPreviousClose > 0) {
      pct = ((price - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
    }
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;

    return {
      symbol: fromYahooSymbol(yahooSymbol),
      yahooSymbol,
      price,
      pct,
      sessionAt: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : (stamps.at(-1) ?? null) * 1000,
      name: meta.shortName ?? meta.longName ?? null,
    };
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `worker` over `items` with a fixed number of workers. */
async function pooled(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/**
 * Day % change for every symbol.
 *
 * @returns {Promise<{rows: Array, scanned: number, missing: string[]}>}
 *          `rows` carries the move, the price and the session timestamp;
 *          `missing` lists the symbols no endpoint could answer for.
 */
export async function fetchMovers({
  fetchImpl = fetch,
  symbols = [],
  concurrency = SPARK_CONCURRENCY,
  chunkSize = SPARK_CHUNK_SIZE,
  timeoutMs = 20_000,
  now = Date.now(),
} = {}) {
  const ysyms = symbols.map(toYahooSymbol).filter(Boolean);
  const found = new Map();

  const chunks = [];
  for (let i = 0; i < ysyms.length; i += chunkSize) chunks.push(ysyms.slice(i, i + chunkSize));

  await pooled(chunks, concurrency, async (chunk) => {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(chunk.join(','))}` +
      '&range=5d&interval=1d';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          if (res.status === 400) break; // too many symbols — the batch is unusable
          await sleep(400 * (attempt + 1));
          continue;
        }
        for (const row of parseSparkResponse(await res.json())) found.set(row.symbol, row);
        break;
      } catch {
        await sleep(400 * (attempt + 1));
      }
    }
  });

  // Gap fill: a partial batch (Yahoo throttles bursts) is repaired one
  // symbol at a time, which is slower but complete.
  const missing = ysyms.filter((s) => !found.has(fromYahooSymbol(s)));
  if (missing.length) {
    await pooled(missing, Math.max(2, Math.floor(concurrency / 2)), async (sym) => {
      const row = await fetchChartRow(sym, { fetchImpl, timeoutMs });
      if (row) found.set(row.symbol, row);
    });
  }

  const rows = [];
  for (const row of found.values()) {
    // A bar from days ago is not today's move — it is a stale quote.
    if (row.sessionAt && now - row.sessionAt > MAX_SESSION_AGE_MS) continue;
    rows.push(row);
  }

  return { rows, scanned: ysyms.length, missing: ysyms.map(fromYahooSymbol).filter((s) => !found.has(s)) };
}

/**
 * Top gainers and top losers of the session.
 * @returns {{gainers: Array, losers: Array}}
 */
export function rankMovers(rows = [], { cap = 3 } = {}) {
  const ok = rows
    .filter((r) => r && typeof r.pct === 'number' && Number.isFinite(r.pct))
    .sort((a, b) => b.pct - a.pct);
  return {
    gainers: ok.filter((r) => r.pct > 0).slice(0, cap),
    losers: ok
      .filter((r) => r.pct < 0)
      .sort((a, b) => a.pct - b.pct)
      .slice(0, cap),
  };
}

/**
 * The whole stage in one call: constituents → day change → ranked movers.
 *
 * @returns {Promise<{gainers: Array, losers: Array, scanned: number, universe: number, source: string, missing: string[]}>}
 */
export async function fetchNifty500Movers({
  fetchImpl = fetch,
  cap = 3,
  now = Date.now(),
  concurrency = SPARK_CONCURRENCY,
  chunkSize = SPARK_CHUNK_SIZE,
} = {}) {
  const { rows: constituents, source } = await fetchConstituents({ fetchImpl });
  if (!constituents.length) {
    return { gainers: [], losers: [], scanned: 0, universe: 0, source, missing: [] };
  }

  const names = new Map(constituents.map((c) => [c.symbol, c.name]));
  const { rows, scanned, missing } = await fetchMovers({
    fetchImpl,
    symbols: constituents.map((c) => c.symbol),
    now,
    concurrency,
    chunkSize,
  });

  const withNames = rows.map((r) => ({ ...r, name: r.name ?? names.get(r.symbol) ?? r.symbol }));
  const { gainers, losers } = rankMovers(withNames, { cap });
  return { gainers, losers, scanned, universe: constituents.length, source, missing };
}

/** "2026-10-21" (IST) for a session timestamp — used to label stale data. */
export function istDayKey(ms) {
  return new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
}

export { DAY_MS };
