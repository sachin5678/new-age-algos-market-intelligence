const HTML_TAG_RE = /<[^>]+>/g;
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', rsquo: '’',
};

/**
 * Repair ORPHANED numeric entities — publishers (e.g. Moneycontrol RSS) ship
 * titles like `Cyient DLM#39;s` where the leading `&` was already lost upstream,
 * so no decoder can find them. Only `&`-less `#39;` / `#x27;` forms are touched;
 * real `&#39;` is left to the normal passes. Control/unassigned code points are
 * skipped so a stray `#1;` in a headline can never become a control character.
 */
function repairOrphanEntities(s) {
  return s.replace(/(^|[^&#])#(x[0-9a-f]+|\d+);/gi, (m, pre, body) => {
    const code = body[0].toLowerCase() === 'x' ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    // Skip controls (C0/C1) and unassigned-looking high values; keep printable text.
    const isControl = code < 32 || (code >= 127 && code <= 159);
    if (!Number.isFinite(code) || isControl || code > 0x2fff) return m;
    return pre + String.fromCodePoint(code);
  });
}

export function decodeEntities(text = '') {
  // Iterate to a fixed point: "&amp;#39;" needs two passes to become "'".
  let out = String(text);
  for (let i = 0; i < 3; i += 1) {
    const next = repairOrphanEntities(
      out
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

export function stripHtml(text = '') {
  return decodeEntities(String(text).replace(HTML_TAG_RE, ' ')).replace(/\s+/g, ' ').trim();
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Normalize a raw article into the canonical news shape:
 * { title, description, source, url, published_at, category, companies, sectors, ... }
 * Returns null when the item is unusable (missing title or url).
 */
export function normalizeArticle(raw, opts = {}) {
  const {
    defaultSource = 'Unknown',
    sourceType = 'media',
    tier = 2,
    categorizer = null,
    extractor = null,
    sourceRegistry = null,
  } = opts;

  const title = stripHtml(raw?.title ?? '').trim();
  const url = String(raw?.url ?? raw?.link ?? '').trim();
  if (!title || !url) return null;

  const description = stripHtml(raw?.description ?? raw?.summary ?? raw?.content ?? '').slice(0, 2000);
  const source = String(raw?.source ?? raw?.publisher ?? defaultSource).trim() || defaultSource;
  const publishedAt = parseDate(raw?.published_at ?? raw?.pubDate ?? raw?.published ?? null);
  const text = `${title} ${description}`;

  const category = raw?.category && typeof raw.category === 'string' && raw.category !== 'AUTO'
    ? raw.category
    : (categorizer ? categorizer({ title, description, source }) : 'OTHER');

  const extracted = extractor ? extractor(text) : { companies: [], sectors: [], institutions: [] };
  const companies = dedupe([...(raw?.companies ?? []), ...extracted.companies]);
  const sectors = dedupe([...(raw?.sectors ?? []), ...extracted.sectors]);
  const institutions = dedupe([...(raw?.institutions ?? []), ...extracted.institutions]);

  // Source-hierarchy registry wins on a match; otherwise keep feed-declared tier.
  const resolved = sourceRegistry ? sourceRegistry.resolve(source) : null;
  const trustTier = resolved?.matched ? resolved.tier : Number(raw?.tier ?? raw?.trust_tier ?? tier);
  const finalSourceType = resolved?.official ? 'official' : (raw?.source_type ?? sourceType);

  return {
    title,
    description,
    source,
    url,
    published_at: publishedAt,
    category,
    companies,
    sectors,
    institutions,
    source_type: finalSourceType,
    trust_tier: trustTier,
    kind: 'article',
  };
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}
