import { Provider } from './base.js';
import { fetchFeeds, normalizeRaw } from './http.js';
import { readInboxFile } from './inbox.js';

/**
 * OfficialAnnouncementProvider — tier-1 sources (exchange/regulator/government).
 *   1) HTTP feeds listed in config/official_sources.json (empty by default — only verified URLs go there)
 *   2) MCP-fed inbox file state/inbox/official.json (nse circulars, firecrawl-fetched SEBI/RBI pages)
 * Items are stamped source_type='official', tier 1 unless stated.
 */
export class OfficialAnnouncementProvider extends Provider {
  constructor({ sources = [], inboxFile, categorizer, extractor, timeoutMs = 10000, fetchImpl } = {}) {
    super({ name: 'official', kind: 'official' });
    this.sources = sources;
    this.inboxFile = inboxFile;
    this.categorizer = categorizer;
    this.extractor = extractor;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async collect(ctx = {}) {
    const logger = ctx.logger ?? null;
    const items = [];

    const enabled = this.sources.filter((s) => s.enabled !== false && s.url);
    if (enabled.length) {
      // official_sources.json calls the field `name`; http.js reads `source`.
      // Normalise here so a feed added later gets a real label instead of the
      // literal "undefined" appearing in COLLECT warnings and in item provenance.
      const feeds = enabled.map((s) => ({
        ...s,
        source: s.source ?? s.name,
        tier: s.tier ?? 1,
        sourceType: 'official',
      }));
      const { raws } = await fetchFeeds(feeds, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, logger, label: 'official feed' });
      items.push(...normalizeRaw(raws, this.categorizer, this.extractor).map((a) => ({ ...a, source_type: 'official', trust_tier: a.trust_tier || 1 })));
    }

    if (this.inboxFile) {
      const inboxItems = readInboxFile(this.inboxFile, logger); // throws on malformed JSON → isolated by runProviders
      const articles = inboxItems.filter((i) => i.kind !== 'snapshot' && i?._kind !== 'snapshot');
      const normalized = normalizeRaw(
        articles.map((i) => ({ ...i, source_type: i.source_type ?? 'official', tier: i.tier ?? 1 })),
        this.categorizer,
        this.extractor
      );
      items.push(...normalized.map((a) => ({ ...a, source_type: 'official', trust_tier: a.trust_tier || 1 })));
    }

    return items;
  }
}
