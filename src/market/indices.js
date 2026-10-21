/**
 * Index pulse for the post-market wrap — NIFTY 50, NIFTY BANK and SENSEX.
 *
 * The NSE JSON API 404s from automation (see providers/nseCollector.js), so
 * the wrap cannot depend on it: the numbers below come from Yahoo's public
 * spark endpoint, the same source the movers use.
 *
 * This is a fallback, not a replacement: when the market providers do return
 * index snapshots, those win, because they carry the exchange's own close.
 */

import { parseSparkResponse } from './nifty500.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };

/** Yahoo symbol → the name the wrap prints. */
export const INDICES = Object.freeze([
  ['^NSEI', 'NIFTY 50'],
  ['^NSEBANK', 'NIFTY BANK'],
  ['^BSESN', 'SENSEX'],
]);

/**
 * The three Indian benchmarks as snapshot rows the briefing context can read.
 * @returns {Promise<Array<{name:string,value:number,pct_change:number}>>}
 */
export async function fetchIndexPulse({ fetchImpl = fetch, indices = INDICES, timeoutMs = 20_000 } = {}) {
  const symbols = indices.map(([sym]) => sym).join(',');
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbols)}&range=5d&interval=1d`;
    const res = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const rows = parseSparkResponse(await res.json());
    const bySymbol = new Map(rows.map((r) => [r.yahooSymbol, r]));
    const out = [];
    for (const [sym, name] of indices) {
      const row = bySymbol.get(sym);
      if (!row) continue;
      out.push({ kind: 'snapshot', name, value: row.price, pct_change: row.pct, source: 'yahoo-spark' });
    }
    return out;
  } catch {
    return [];
  }
}
