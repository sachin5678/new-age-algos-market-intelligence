/**
 * Recap market data — free, keyless Yahoo Finance (no NSE blocking, no MCP).
 *
 * The NSE website API 404s from automation and the nse MCP returns empty
 * arrays when the market is closed, so the recap reads everything from
 * Yahoo's public chart endpoint:
 *
 *   fetchMovers      — day % change for a liquid NSE universe (one v8 chart
 *                      request per symbol, parallel; range=1mo gives BOTH the
 *                      day change and ~21 daily candles for the chart)
 *   fetchIndexPulse  — NIFTY 50 / NIFTY BANK / SENSEX closes
 *   newsForMover     — matches store events (the channel's own news feed)
 *                      against a mover for the on-screen news strip
 *
 * Everything degrades gracefully: a failed symbol is skipped, an empty
 * result is an error the CLI can explain — never fabricated numbers (§27).
 */

/** Liquid NSE universe for the daily recap (symbol → display name). */
export const UNIVERSE = Object.freeze([
  ['RELIANCE.NS', 'Reliance Industries'],
  ['TCS.NS', 'TCS'],
  ['HDFCBANK.NS', 'HDFC Bank'],
  ['ICICIBANK.NS', 'ICICI Bank'],
  ['INFY.NS', 'Infosys'],
  ['SBIN.NS', 'SBI'],
  ['BHARTIARTL.NS', 'Bharti Airtel'],
  ['ITC.NS', 'ITC'],
  ['LT.NS', 'Larsen & Toubro'],
  ['KOTAKBANK.NS', 'Kotak Bank'],
  ['AXISBANK.NS', 'Axis Bank'],
  ['HINDUNILVR.NS', 'Hindustan Unilever'],
  ['ASIANPAINT.NS', 'Asian Paints'],
  ['MARUTI.NS', 'Maruti Suzuki'],
  ['TITAN.NS', 'Titan'],
  ['SUNPHARMA.NS', 'Sun Pharma'],
  ['TATAMOTORS.NS', 'Tata Motors'],
  ['TATASTEEL.NS', 'Tata Steel'],
  ['WIPRO.NS', 'Wipro'],
  ['HCLTECH.NS', 'HCL Tech'],
  ['TECHM.NS', 'Tech Mahindra'],
  ['NTPC.NS', 'NTPC'],
  ['POWERGRID.NS', 'Power Grid'],
  ['ONGC.NS', 'ONGC'],
  ['COALINDIA.NS', 'Coal India'],
  ['JSWSTEEL.NS', 'JSW Steel'],
  ['ULTRACEMCO.NS', 'Ultratech Cement'],
  ['M&M.NS', 'Mahindra & Mahindra'],
  ['TATACONSUM.NS', 'Tata Consumer'],
  ['CIPLA.NS', 'Cipla'],
  ['DRREDDY.NS', "Dr Reddy's"],
  ['BAJFINANCE.NS', 'Bajaj Finance'],
  ['BAJAJFINSV.NS', 'Bajaj Finserv'],
  ['EICHERMOT.NS', 'Eicher Motors'],
  ['INDUSINDBK.NS', 'IndusInd Bank'],
  ['ADANIENT.NS', 'Adani Enterprises'],
  ['ADANIPORTS.NS', 'Adani Ports'],
  ['HEROMOTOCO.NS', 'Hero MotoCorp'],
  ['APOLLOHOSP.NS', 'Apollo Hospitals'],
  ['NESTLEIND.NS', 'Nestle India'],
]);

export const INDICES = Object.freeze([
  ['^NSEI', 'NIFTY 50'],
  ['^NSEBANK', 'NIFTY BANK'],
  ['^BSESN', 'SENSEX'],
]);

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const YF_TIMEOUT_MS = 15_000;

/**
 * Fetch daily OHLC from Yahoo's public chart endpoint.
 * @returns {Promise<{candles: Array<{o,h,l,c}>, closes: number[]}|null>}
 *          null on any network/shape failure (never throws).
 */
export async function fetchChart(symbol, { range = '1mo', fetchImpl = fetch, timeoutMs = YF_TIMEOUT_MS } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
      const res = await fetchImpl(url, { headers: UA, signal: controller.signal });
      if (!res.ok) return null;
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      if (!r) return null;
      const q = r.indicators?.quote?.[0];
      if (!q) return null;
      const candles = [];
      for (let i = 0; i < (r.timestamp?.length ?? 0); i += 1) {
        const o = q.open?.[i];
        const h = q.high?.[i];
        const l = q.low?.[i];
        const c = q.close?.[i];
        if ([o, h, l, c].every((v) => typeof v === 'number' && Number.isFinite(v))) {
          candles.push({ o, h, l, c });
        }
      }
      if (candles.length < 2) return null;
      return { candles, closes: candles.map((k) => k.c) };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Day % change from the last two closes. */
export function dayChange(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  const prev = closes[closes.length - 2];
  const last = closes[closes.length - 1];
  if (!(prev > 0) || !(last > 0)) return null;
  return { pct: ((last - prev) / prev) * 100, price: last };
}

/**
 * Top movers of the session across the liquid universe.
 * @returns {Promise<{gainers: Array, losers: Array, failed: number}>}
 */
export async function fetchMovers({ fetchImpl = fetch, universe = UNIVERSE, cap = 3 } = {}) {
  const rows = await Promise.all(
    universe.map(async ([sym, name]) => {
      const chart = await fetchChart(sym, { fetchImpl });
      if (!chart) return null;
      const ch = dayChange(chart.closes);
      if (!ch) return null;
      return { symbol: sym.replace(/\.NS$/, ''), name, pct: ch.pct, price: ch.price, candles: chart.candles };
    })
  );
  const ok = rows.filter(Boolean);
  const gainers = ok.filter((r) => r.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, cap);
  const losers = ok.filter((r) => r.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, cap);
  return { gainers, losers, failed: universe.length - ok.length };
}

/** Index pulse for the hook scene: [{name, value, pct}]. */
export async function fetchIndexPulse({ fetchImpl = fetch, indices = INDICES } = {}) {
  const rows = await Promise.all(
    indices.map(async ([sym, name]) => {
      const chart = await fetchChart(sym, { fetchImpl });
      if (!chart) return null;
      const ch = dayChange(chart.closes);
      if (!ch) return null;
      return { name, value: ch.price, pct: ch.pct };
    })
  );
  return rows.filter(Boolean);
}

function haystack(event) {
  return [
    event?.title,
    event?.description,
    event?.ai_summary,
    ...(Array.isArray(event?.companies) ? event.companies : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Best store event for a mover (own news feed, no API): title/description/
 * extracted companies mention the display name or the ticker root.
 * @returns {object|null}
 */
export function newsForMover(mover, events = [], cap = 1) {
  const terms = [
    mover.name.toLowerCase(),
    mover.symbol.toLowerCase(),
  ].filter((t) => t && t.length > 2);
  const hits = [];
  for (const ev of events) {
    const text = haystack(ev);
    if (terms.some((t) => text.includes(t))) hits.push(ev);
    if (hits.length >= cap) break;
  }
  return hits[0] ?? null;
}
