import { Provider } from './base.js';
import { fetchFeeds, normalizeRaw } from './http.js';

/** NewsProvider — RSS news feeds (direct HTTP; same feeds the rss MCP uses). */
export class NewsProvider extends Provider {
  constructor({ feeds = [], categorizer, extractor, timeoutMs = 10000, fetchImpl } = {}) {
    super({ name: 'news-rss', kind: 'news' });
    this.feeds = feeds;
    this.categorizer = categorizer;
    this.extractor = extractor;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async collect(ctx = {}) {
    const newsFeeds = this.feeds.filter((f) => (f.kind ?? 'news') === 'news' && f.enabled !== false);
    const { raws } = await fetchFeeds(newsFeeds, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      logger: ctx.logger ?? null,
      label: 'news feed',
    });
    return normalizeRaw(raws, this.categorizer, this.extractor);
  }
}
