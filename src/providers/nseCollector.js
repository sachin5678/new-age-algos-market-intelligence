import { Provider } from './base.js';
import fetch from 'node-fetch';

/**
 * Native NSE Market Data Collector
 * Fetches NSE indices, breadth, and movers directly from NSE public APIs
 * No OpenCode MCP dependency
 */
export class NSECollector extends Provider {
  constructor({ timeoutMs = 15000 } = {}) {
    super({ name: 'nse-market-data', kind: 'market' });
    this.timeoutMs = timeoutMs;
    this.baseUrl = 'https://www.nseindia.com/api';
    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  async collect(ctx = {}) {
    const logger = ctx.logger ?? null;
    const snapshots = [];

    try {
      // Fetch NSE indices (NIFTY 50, NIFTY BANK, etc.)
      const indices = await this.fetchIndices(logger);
      snapshots.push(...indices);

      // Fetch market breadth (advances/declines)
      const breadth = await this.fetchMarketBreadth(logger);
      snapshots.push(...breadth);

      // Fetch top gainers/losers
      const movers = await this.fetchMovers(logger);
      snapshots.push(...movers);

      // Fetch FII/DII data
      const fiidi = await this.fetchFIIDII(logger);
      snapshots.push(...fiidi);

    } catch (err) {
      logger?.error('NSE_COLLECTOR', `Failed to collect NSE data: ${err.message}`);
    }

    return snapshots;
  }

  async fetchWithRetry(url, options = {}, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        const response = await fetch(url, { ...options, signal: controller.signal, headers: this.headers });
        clearTimeout(timeout);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  async fetchIndices(logger) {
    const snapshots = [];
    try {
      const data = await this.fetchWithRetry(`${this.baseUrl}/equityStockIndices?index=NIFTY%2050`);
      if (data?.data) {
        for (const item of data.data) {
          if (item.indexName && item.lastPrice) {
            snapshots.push({
              kind: 'snapshot',
              name: item.indexName.replace(/\s+/g, ' ').trim(),
              value: Number(item.lastPrice),
              change: item.change ? Number(item.change) : null,
              pct_change: item.pChange ? Number(item.pChange) : null,
              asof: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString(),
              source: 'nse-api',
              extras: { indexType: 'equity' }
            });
          }
        }
      }
    } catch (err) {
      logger?.warn('NSE_COLLECTOR', `Failed to fetch indices: ${err.message}`);
    }
    return snapshots;
  }

  async fetchMarketBreadth(logger) {
    const snapshots = [];
    try {
      const data = await this.fetchWithRetry(`${this.baseUrl}/marketStatus`);
      if (data?.marketState) {
        const state = data.marketState[0];
        if (state.advances !== undefined) {
          snapshots.push({
            kind: 'snapshot',
            name: 'Advances',
            value: Number(state.advances),
            source: 'nse-api',
            extras: { type: 'breadth' }
          });
        }
        if (state.declines !== undefined) {
          snapshots.push({
            kind: 'snapshot',
            name: 'Declines',
            value: Number(state.declines),
            source: 'nse-api',
            extras: { type: 'breadth' }
          });
        }
      }
    } catch (err) {
      logger?.warn('NSE_COLLECTOR', `Failed to fetch market breadth: ${err.message}`);
    }
    return snapshots;
  }

  async fetchMovers(logger) {
    const snapshots = [];
    try {
      const data = await this.fetchWithRetry(`${this.baseUrl}/liveEquity?symbol=NIFTY 50`);
      if (data?.data) {
        for (const item of data.data.slice(0, 10)) {
          if (item.symbol && item.lastPrice && item.pChange !== undefined) {
            snapshots.push({
              kind: 'snapshot',
              name: item.symbol,
              value: Number(item.lastPrice),
              pct_change: Number(item.pChange),
              source: 'nse-api',
              extras: { type: 'mover', volume: item.totalTradedVolume }
            });
          }
        }
      }
    } catch (err) {
      logger?.warn('NSE_COLLECTOR', `Failed to fetch movers: ${err.message}`);
    }
    return snapshots;
  }

  async fetchFIIDII(logger) {
    const snapshots = [];
    try {
      const data = await this.fetchWithRetry(`${this.baseUrl}/fiidiiTradeReact`);
      if (data?.data) {
        for (const item of data.data) {
          if (item.category === 'FII' && item.netValue !== undefined) {
            snapshots.push({
              kind: 'snapshot',
              name: 'FII Net',
              value: Number(item.netValue),
              source: 'nse-api',
              extras: { type: 'fii_dii', date: item.date }
            });
          }
          if (item.category === 'DII' && item.netValue !== undefined) {
            snapshots.push({
              kind: 'snapshot',
              name: 'DII Net',
              value: Number(item.netValue),
              source: 'nse-api',
              extras: { type: 'fii_dii', date: item.date }
            });
          }
        }
      }
    } catch (err) {
      logger?.warn('NSE_COLLECTOR', `Failed to fetch FII/DII: ${err.message}`);
    }
    return snapshots;
  }
}

export class GlobalMarketCollector extends Provider {
  constructor({ timeoutMs = 15000, pythonPath = 'python3' } = {}) {
    super({ name: 'global-market-data', kind: 'global' });
    this.timeoutMs = timeoutMs;
    this.pythonPath = pythonPath;
  }

  async collect(ctx = {}) {
    const logger = ctx.logger ?? null;
    const snapshots = [];

    // Use Python yfinance to fetch global market data
    const script = `
import yfinance as yf
import json
import sys

symbols = {
    "S&P 500": "^GSPC",
    "Nasdaq": "^IXIC",
    "Dow Jones": "^DJI",
    "Nikkei 225": "^N225",
    "Hang Seng": "^HSI",
    "Shanghai Composite": "000001.SS",
    "USD/INR": "INR=X",
    "Brent Crude": "BZ=F",
    "Gold": "GC=F",
    "Gift Nifty": "NIFTYBEES.NS"
}

results = []
for name, symbol in symbols.items():
    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period="1d", interval="1m")
        if not hist.empty:
            last = hist.iloc[-1]
            prev_close = ticker.info.get('previousClose', last['Close'])
            change = last['Close'] - prev_close
            pct_change = (change / prev_close) * 100 if prev_close else 0
            results.append({
                "name": name,
                "value": round(float(last['Close']), 2),
                "change": round(float(change), 2),
                "pct_change": round(float(pct_change), 2),
                "asof": hist.index[-1].isoformat()
            })
    except Exception as e:
        print(f"Error fetching {name}: {e}", file=sys.stderr)

print(json.dumps(results))
`;

    try {
      const { spawn } = await import('child_process');
      const python = await new Promise((resolve, reject) => {
        const proc = spawn(this.pythonPath, ['-c', script], { timeout: this.timeoutMs });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `Exit code ${code}`)));
      });
      const data = JSON.parse(python);
      for (const item of data) {
        snapshots.push({
          kind: 'snapshot',
          name: item.name,
          value: item.value,
          change: item.change,
          pct_change: item.pct_change,
          asof: item.asof,
          source: 'yfinance-native',
          extras: {}
        });
      }
    } catch (err) {
      logger?.warn('GLOBAL_COLLECTOR', `Failed to fetch global data: ${err.message}`);
    }

    return snapshots;
  }
}