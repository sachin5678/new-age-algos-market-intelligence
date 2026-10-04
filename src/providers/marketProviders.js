import { Provider } from './base.js';
import { readInboxFile } from './inbox.js';

function toSnapshot(item, fallbackSource) {
  if (typeof item.name !== 'string' || typeof item.value !== 'number') return null;
  return {
    kind: 'snapshot',
    name: item.name,
    value: item.value,
    change: typeof item.change === 'number' ? item.change : null,
    pct_change: typeof item.pct_change === 'number' ? item.pct_change : null,
    asof: item.asof ?? null,
    source: item.source ?? fallbackSource,
    extras: item.extras ?? {},
  };
}

/**
 * MarketDataProvider — Indian market data snapshots (breadth, indices, movers),
 * fed from the `nse` MCP via state/inbox/market.json by the OpenCode agent.
 */
export class MarketDataProvider extends Provider {
  constructor({ inboxFile } = {}) {
    super({ name: 'market-data', kind: 'market' });
    this.inboxFile = inboxFile;
  }

  async collect(ctx = {}) {
    const raws = readInboxFile(this.inboxFile, ctx.logger ?? null);
    return raws.map((r) => toSnapshot(r.snapshot ?? r, r.source ?? 'nse-mcp')).filter(Boolean);
  }
}

/** GlobalMarketProvider — US/Asia, Gift Nifty, crude, gold, USDINR via `yfinance` MCP → state/inbox/global.json */
export class GlobalMarketProvider extends Provider {
  constructor({ inboxFile } = {}) {
    super({ name: 'global-market', kind: 'global' });
    this.inboxFile = inboxFile;
  }

  async collect(ctx = {}) {
    const raws = readInboxFile(this.inboxFile, ctx.logger ?? null);
    return raws.map((r) => toSnapshot(r.snapshot ?? r, r.source ?? 'yfinance-mcp')).filter(Boolean);
  }
}
