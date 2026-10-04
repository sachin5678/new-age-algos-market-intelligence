import path from 'node:path';
import { NewsProvider } from './newsProvider.js';
import { OfficialAnnouncementProvider } from './officialProvider.js';
import { MarketDataProvider, GlobalMarketProvider } from './marketProviders.js';

/**
 * Build the standard provider set. All four run independently and
 * failure-isolated via runProviders():
 *   MarketDataProvider | NewsProvider | OfficialAnnouncementProvider | GlobalMarketProvider
 */
export function createProviders({ settings, feeds, officialSources, categorizer, extractor, fetchImpl } = {}) {
  const inbox = settings.paths.inbox;
  return [
    new MarketDataProvider({ inboxFile: path.join(inbox, 'market.json') }),
    new NewsProvider({ feeds, categorizer, extractor, fetchImpl }),
    new OfficialAnnouncementProvider({
      sources: officialSources,
      inboxFile: path.join(inbox, 'official.json'),
      categorizer,
      extractor,
      fetchImpl,
    }),
    new GlobalMarketProvider({ inboxFile: path.join(inbox, 'global.json') }),
  ];
}

export { NewsProvider, OfficialAnnouncementProvider, MarketDataProvider, GlobalMarketProvider };
export { Provider, runProviders } from './base.js';
export { parseFeed } from './parseFeed.js';
export { readInboxFile } from './inbox.js';
