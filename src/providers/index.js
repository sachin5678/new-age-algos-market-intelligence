import path from 'node:path';
import { NewsProvider } from './newsProvider.js';
import { OfficialAnnouncementProvider } from './officialProvider.js';
import { NSECollector, GlobalMarketCollector } from './nseCollector.js';

/**
 * Build the standard provider set. All four run independently and
 * failure-isolated via runProviders():
 *   NSECollector | NewsProvider | OfficialAnnouncementProvider | GlobalMarketCollector
 * 
 * NOTE: NSECollector and GlobalMarketCollector fetch data directly from APIs
 * (NSE India, yfinance) WITHOUT requiring OpenCode MCP agents or inbox files.
 */
export function createProviders({ settings, feeds, officialSources, categorizer, extractor, fetchImpl } = {}) {
  return [
    new NSECollector(),
    new NewsProvider({ feeds, categorizer, extractor, fetchImpl }),
    new OfficialAnnouncementProvider({
      sources: officialSources,
      inboxFile: null, // Inbox optional; HTTP feeds from officialSources work natively
      categorizer,
      extractor,
      fetchImpl,
    }),
    new GlobalMarketCollector(),
  ];
}

export { NewsProvider, OfficialAnnouncementProvider, NSECollector, GlobalMarketCollector };
export { Provider, runProviders } from './base.js';
export { parseFeed } from './parseFeed.js';
export { readInboxFile } from './inbox.js';
