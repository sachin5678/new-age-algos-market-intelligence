import { decodeEntities, stripHtml } from '../normalize/normalizeArticle.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Extract a tag's inner text; supports namespaced tags (content:encoded, dc:date). */
function extractTag(block, name) {
  const n = esc(name);
  const re = new RegExp(`<(?:[a-z0-9_]+:)?${n}(\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z0-9_]+:)?${n}>`, 'i');
  const m = block.match(re);
  return m ? m[2].trim() : '';
}

function unwrapCdata(s = '') {
  const m = String(s).match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

/** RSS <link>text</link> | Atom <link href="..."/> | Atom <id>fallback. */
function extractLink(block) {
  const text = unwrapCdata(extractTag(block, 'link')).trim();
  if (text && !text.startsWith('<')) return decodeEntities(text);
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
  if (href) return decodeEntities(href);
  const id = unwrapCdata(extractTag(block, 'id')).trim();
  return /^https?:\/\//i.test(id) ? decodeEntities(id) : '';
}

/**
 * Minimal RSS 2.0 / RDF / Atom parser (no dependencies).
 * Returns normalized raw article objects: { title, description, url, published_at, source, tier, source_type }.
 * Throws nothing — malformed individual items are skipped.
 */
export function parseFeed(xml, { source = 'Unknown', tier = 2, sourceType = 'media' } = {}) {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const items = [];
  for (const block of blocks) {
    const title = stripHtml(unwrapCdata(extractTag(block, 'title')));
    const url = extractLink(block);
    const description = stripHtml(
      unwrapCdata(
        extractTag(block, 'description') ||
          extractTag(block, 'summary') ||
          extractTag(block, 'encoded') ||
          extractTag(block, 'content')
      )
    );
    const published =
      unwrapCdata(extractTag(block, 'pubDate')) ||
      extractTag(block, 'published') ||
      extractTag(block, 'updated') ||
      extractTag(block, 'dc:date') ||
      '';
    if (!title || !url) continue;
    items.push({
      title,
      description,
      url,
      published_at: published || null,
      source,
      tier,
      source_type: sourceType,
    });
  }
  return items;
}
