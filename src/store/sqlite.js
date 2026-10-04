import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  cluster_id TEXT,
  url TEXT,
  canonical_url TEXT UNIQUE,
  content_hash TEXT UNIQUE,
  title TEXT,
  description TEXT,
  source TEXT,
  source_type TEXT,
  trust_tier INTEGER,
  published_at TEXT,
  detected_at TEXT,
  first_seen_at TEXT,
  category TEXT,
  companies TEXT DEFAULT '[]',
  sectors TEXT DEFAULT '[]',
  institutions TEXT DEFAULT '[]',
  importance REAL DEFAULT 0,
  importance_level TEXT,
  importance_factors TEXT DEFAULT '{}',
  confidence TEXT,
  official_confirmation INTEGER DEFAULT 0,
  ai_summary TEXT,
  ai_verdict TEXT DEFAULT '{}',
  detection_status TEXT,
  event_status TEXT DEFAULT 'new',
  status TEXT DEFAULT 'new',
  mode_scope TEXT,
  run_id TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_cluster ON events(cluster_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(event_status);

CREATE TABLE IF NOT EXISTS clusters (
  cluster_id TEXT PRIMARY KEY,
  head_event_id TEXT,
  canonical_title TEXT,
  tokens TEXT DEFAULT '[]',
  companies TEXT DEFAULT '[]',
  sectors TEXT DEFAULT '[]',
  institutions TEXT DEFAULT '[]',
  numbers TEXT DEFAULT '[]',
  category TEXT,
  sources TEXT DEFAULT '[]',
  first_seen_at TEXT,
  last_seen_at TEXT,
  item_count INTEGER DEFAULT 1,
  publish_status TEXT DEFAULT 'unpublished',
  cooldown_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_clusters_last_seen ON clusters(last_seen_at);

CREATE TABLE IF NOT EXISTS published (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  cluster_id TEXT,
  chat_id TEXT,
  telegram_message_id TEXT,
  mode TEXT,
  template TEXT,
  text_hash TEXT,
  published_at TEXT,
  edited_at TEXT,
  raw_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_published_at ON published(published_at);
CREATE INDEX IF NOT EXISTS idx_published_cluster ON published(cluster_id);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  stats TEXT DEFAULT '{}',
  error TEXT
);
`;

const j = (v) => JSON.stringify(v ?? null);
const p = (s, fallback) => {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

function rowToEvent(r) {
  if (!r) return null;
  return {
    ...r,
    trust_tier: r.trust_tier ?? null,
    official_confirmation: Boolean(r.official_confirmation),
    companies: p(r.companies, []),
    sectors: p(r.sectors, []),
    institutions: p(r.institutions, []),
    importance_factors: p(r.importance_factors, {}),
    ai_verdict: p(r.ai_verdict, {}),
  };
}

function rowToCluster(r) {
  if (!r) return null;
  return {
    ...r,
    tokens: p(r.tokens, []),
    companies: p(r.companies, []),
    sectors: p(r.sectors, []),
    institutions: p(r.institutions, []),
    numbers: p(r.numbers, []),
    sources: p(r.sources, []),
    item_count: r.item_count ?? 1,
  };
}

export class SqliteStore {
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  getEvent(id) {
    return rowToEvent(this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(id));
  }

  getEventByCanonicalUrl(url) {
    return rowToEvent(this.db.prepare('SELECT * FROM events WHERE canonical_url = ?').get(url));
  }

  getEventByContentHash(hash) {
    return rowToEvent(this.db.prepare('SELECT * FROM events WHERE content_hash = ?').get(hash));
  }

  saveEvent(e) {
    this.db.prepare(`
      INSERT INTO events (event_id, cluster_id, url, canonical_url, content_hash, title, description,
        source, source_type, trust_tier, published_at, detected_at, first_seen_at, category,
        companies, sectors, institutions, importance, importance_level, importance_factors, confidence,
        official_confirmation, ai_summary, ai_verdict, detection_status, event_status, status, mode_scope, run_id, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET
        cluster_id=excluded.cluster_id, importance=excluded.importance,
        importance_level=excluded.importance_level, importance_factors=excluded.importance_factors,
        confidence=excluded.confidence, official_confirmation=excluded.official_confirmation,
        ai_summary=excluded.ai_summary, ai_verdict=excluded.ai_verdict,
        detection_status=excluded.detection_status, event_status=excluded.event_status,
        status=excluded.status, updated_at=excluded.updated_at
    `).run(
      e.event_id, e.cluster_id ?? null, e.url ?? null, e.canonical_url, e.content_hash, e.title,
      e.description ?? null, e.source, e.source_type ?? null, e.trust_tier ?? null,
      e.published_at ?? null, e.detected_at, e.first_seen_at ?? e.detected_at, e.category,
      j(e.companies), j(e.sectors), j(e.institutions), e.importance ?? 0, e.importance_level ?? null,
      j(e.importance_factors), e.confidence ?? null, e.official_confirmation ? 1 : 0,
      e.ai_summary ?? null, j(e.ai_verdict), e.detection_status ?? null,
      e.event_status ?? 'new', e.status ?? 'new', e.mode_scope ?? null,
      e.run_id ?? null, e.updated_at ?? e.detected_at
    );
    return e;
  }

  updateEvent(id, patch) {
    const cur = this.getEvent(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    this.saveEvent(next);
    return next;
  }

  getCluster(id) {
    if (!id) return null;
    return rowToCluster(this.db.prepare('SELECT * FROM clusters WHERE cluster_id = ?').get(id));
  }

  findRecentClusters(sinceIso) {
    const rows = this.db.prepare('SELECT * FROM clusters WHERE last_seen_at >= ?').all(sinceIso);
    return rows.map(rowToCluster);
  }

  saveCluster(c) {
    this.db.prepare(`
      INSERT INTO clusters (cluster_id, head_event_id, canonical_title, tokens, companies, sectors,
        institutions, numbers, category, sources, first_seen_at, last_seen_at, item_count, publish_status, cooldown_until)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cluster_id) DO UPDATE SET
        tokens=excluded.tokens, companies=excluded.companies, sectors=excluded.sectors,
        institutions=excluded.institutions, numbers=excluded.numbers, sources=excluded.sources,
        last_seen_at=excluded.last_seen_at,
        item_count=excluded.item_count, publish_status=excluded.publish_status,
        cooldown_until=excluded.cooldown_until
    `).run(
      c.cluster_id, c.head_event_id ?? null, c.canonical_title ?? null, j(c.tokens), j(c.companies),
      j(c.sectors), j(c.institutions ?? []), j(c.numbers), c.category ?? null, j(c.sources),
      c.first_seen_at, c.last_seen_at ?? c.first_seen_at, c.item_count ?? 1,
      c.publish_status ?? 'unpublished', c.cooldown_until ?? null
    );
    return c;
  }

  updateCluster(id, patch) {
    const cur = this.getCluster(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.saveCluster(next);
    return next;
  }

  isClusterPublished(clusterId) {
    const row = this.db.prepare('SELECT 1 AS x FROM published WHERE cluster_id = ? LIMIT 1').get(clusterId);
    return Boolean(row);
  }

  recordPublished(row) {
    const res = this.db.prepare(`
      INSERT INTO published (event_id, cluster_id, chat_id, telegram_message_id, mode, template, text_hash, published_at, raw_text)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      row.event_id ?? null, row.cluster_id ?? null, row.chat_id ?? null, row.message_id ?? null,
      row.mode ?? null, row.template ?? null, row.text_hash ?? null,
      row.published_at ?? new Date().toISOString(), row.raw_text ?? null
    );
    return { id: Number(res.lastInsertRowid), ...row };
  }

  lastPublishedAt() {
    const row = this.db.prepare('SELECT published_at FROM published ORDER BY published_at DESC LIMIT 1').get();
    return row?.published_at ?? null;
  }

  publishedCountSince(iso) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM published WHERE published_at >= ?').get(iso);
    return Number(row?.n ?? 0);
  }

  saveRun(run) {
    this.db.prepare(`
      INSERT INTO runs (run_id, mode, started_at, finished_at, status, stats, error)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET finished_at=excluded.finished_at, status=excluded.status,
        stats=excluded.stats, error=excluded.error
    `).run(run.run_id, run.mode ?? null, run.started_at ?? null, run.finished_at ?? null,
      run.status ?? null, j(run.stats), run.error ?? null);
    return run;
  }

  listRecentEvents(sinceIso, cap = 50) {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE detected_at >= ? ORDER BY importance DESC, detected_at DESC LIMIT ?')
      .all(sinceIso, cap);
    return rows.map(rowToEvent);
  }

  close() { this.db.close(); }
}
