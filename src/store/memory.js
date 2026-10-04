/**
 * In-memory store — same interface as SqliteStore. Used by unit tests and
 * as a fallback when SQLite is unavailable.
 *
 * Interface (all stores implement this):
 *   getEventByCanonicalUrl(url) / getEventByContentHash(hash) / getEvent(id)
 *   saveEvent(event) / updateEvent(id, patch)
 *   getCluster(id) / findRecentClusters(sinceIso) / saveCluster(cluster) / updateCluster(id, patch)
 *   isClusterPublished(clusterId) / recordPublished(row) / lastPublishedAt() / publishedCountSince(iso)
 *   saveRun(run) / close()
 */
export class MemoryStore {
  constructor() {
    this.events = new Map();
    this.byUrl = new Map();
    this.byHash = new Map();
    this.clusters = new Map();
    this.published = [];
    this.runs = [];
  }

  getEvent(id) { return this.events.get(id) ?? null; }

  getEventByCanonicalUrl(url) {
    const id = this.byUrl.get(url);
    return id ? this.events.get(id) ?? null : null;
  }

  getEventByContentHash(hash) {
    const id = this.byHash.get(hash);
    return id ? this.events.get(id) ?? null : null;
  }

  saveEvent(event) {
    this.events.set(event.event_id, { ...event });
    this.byUrl.set(event.canonical_url, event.event_id);
    this.byHash.set(event.content_hash, event.event_id);
    return event;
  }

  updateEvent(id, patch) {
    const cur = this.events.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    this.events.set(id, next);
    return next;
  }

  getCluster(id) {
    if (!id) return null;
    return this.clusters.get(id) ?? null;
  }

  findRecentClusters(sinceIso) {
    return [...this.clusters.values()].filter((c) => (c.last_seen_at ?? c.first_seen_at) >= sinceIso);
  }

  saveCluster(cluster) {
    this.clusters.set(cluster.cluster_id, { ...cluster });
    return cluster;
  }

  updateCluster(id, patch) {
    const cur = this.clusters.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.clusters.set(id, next);
    return next;
  }

  isClusterPublished(clusterId) {
    return this.published.some((p) => p.cluster_id === clusterId);
  }

  recordPublished(row) {
    const rec = { id: `pub_${this.published.length + 1}`, published_at: new Date().toISOString(), message_id: null, ...row };
    this.published.push(rec);
    return rec;
  }

  lastPublishedAt() {
    if (!this.published.length) return null;
    return this.published.map((p) => p.published_at).sort().at(-1);
  }

  publishedCountSince(iso) {
    return this.published.filter((p) => p.published_at >= iso).length;
  }

  saveRun(run) { this.runs.push(run); return run; }

  listRecentEvents(sinceIso, cap = 50) {
    return [...this.events.values()]
      .filter((e) => (e.detected_at ?? e.first_seen_at ?? '') >= sinceIso)
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
      .slice(0, cap);
  }

  close() { /* nothing to close */ }
}
