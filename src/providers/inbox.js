import fs from 'node:fs';
import path from 'node:path';

/**
 * Read an MCP-fed inbox file.
 *
 * OpenCode agents drop MCP results here (rss/nse/yfinance/firecrawl tools):
 *   { "source": "nse-mcp", "sourceType": "official", "tier": 1,
 *     "items": [ {title, url, description, published_at, category?} ] }
 *   { "source": "nse-mcp", "items": [ {kind:'snapshot', name, value, change, pct_change} ] }
 *
 * Missing file → empty list (not an error). Malformed JSON → throws (caller isolates).
 */
export function readInboxFile(filePath, logger = null) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`inbox file ${path.basename(filePath)} is not valid JSON: ${err.message}`);
  }
  const items = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(items)) throw new Error(`inbox file ${path.basename(filePath)} has no items[] array`);
  const meta = Array.isArray(parsed) ? {} : parsed;
  const enriched = items.map((it) => ({
    ...it,
    source: it.source ?? meta.source,
    tier: it.tier ?? meta.tier,
    source_type: it.source_type ?? meta.sourceType ?? meta.source_type,
  }));
  logger?.debug('COLLECT', `inbox ${path.basename(filePath)}: ${enriched.length} item(s)`);
  return enriched;
}
