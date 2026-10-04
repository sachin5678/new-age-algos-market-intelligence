import { parseFeed } from './parseFeed.js';
import { normalizeArticle } from '../normalize/normalizeArticle.js';

const USER_AGENT = 'NewAgeAlgos/1.0 (+market-intel-rss)';

/** Fetch one RSS/Atom feed and return raw parsed items. Throws on network/parse failure. */
export async function fetchFeed(feed, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const res = await fetchImpl(feed.url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const raws = parseFeed(xml, { source: feed.source, tier: feed.tier ?? 2, sourceType: feed.sourceType ?? 'media' });
  if (raws.length === 0 && !/<(item|entry)\b/i.test(xml)) {
    throw new Error('no <item>/<entry> elements found — not a feed?');
  }
  return raws;
}

/**
 * Fetch many feeds with per-feed failure isolation.
 * Returns { raws, failures } — one dead feed never kills the batch.
 */
export async function fetchFeeds(feeds, opts = {}) {
  const { logger = null, label = 'feed' } = opts;
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f, opts)));
  const raws = [];
  const failures = [];
  results.forEach((r, i) => {
    const feed = feeds[i];
    if (r.status === 'fulfilled') raws.push(...r.value);
    else {
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      failures.push({ source: feed.source, url: feed.url, error: err });
      logger?.warn('COLLECT', `${label} ${feed.source} failed: ${err}`);
    }
  });
  return { raws, failures };
}

/** Normalize a batch of raw items with a feed's default metadata. */
export function normalizeRaw(raws, categorizer, extractor) {
  return raws
    .map((r) => normalizeArticle(r, { defaultSource: r.source, categorizer, extractor, tier: r.tier ?? 2, sourceType: r.source_type ?? 'media' }))
    .filter(Boolean);
}
