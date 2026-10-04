import { loadConfig } from '../src/config.js';

/** Fri 02 Oct 2026 09:30 IST (inside market hours) */
export const IN_HOURS = new Date('2026-10-02T04:00:00Z');
/** Fri 02 Oct 2026 18:30 IST (after close, still a weekday) */
export const AFTER_HOURS = new Date('2026-10-02T13:30:00Z');

/** Fresh copy of the real project config (offline, no env mutation issues). */
export function testConfig() {
  return loadConfig();
}

/** Article fixture in normalized shape. */
export function art(over = {}) {
  return {
    title: '',
    description: '',
    source: 'TestSource',
    url: 'https://example.test/story',
    published_at: '2026-10-02T06:00:00.000Z',
    category: 'OTHER',
    companies: [],
    sectors: [],
    institutions: [],
    source_type: 'media',
    trust_tier: 2,
    kind: 'article',
    detected_at: IN_HOURS.toISOString(),
    ...over,
  };
}

/** Transport that records sends instead of delivering. */
export class FakeTransport {
  constructor() {
    this.name = 'fake';
    this.sent = [];
    this.failNext = false;
  }

  async send(text, meta = {}) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated transport failure');
    }
    this.sent.push({ text, meta });
    return { message_id: 1000 + this.sent.length };
  }
}

/** Build an RSS 2.0 document from simple item descriptors. */
export function rssXml(items) {
  const body = items
    .map(
      (i) => `<item>
        <title><![CDATA[${i.title}]]></title>
        <link>${i.url}</link>
        <description><![CDATA[${i.description ?? ''}]]></description>
        <pubDate>${i.published ?? 'Fri, 02 Oct 2026 06:00:00 GMT'}</pubDate>
      </item>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Fixture</title>\n${body}\n</channel></rss>`;
}

/** Stub fetch: url → xml string (ok), Error (throws), or missing (404). */
export function stubFetch(map) {
  return async (url) => {
    const v = map[url];
    if (v === undefined) return { ok: false, status: 404, text: async () => '' };
    if (v instanceof Error) throw v;
    return { ok: true, status: 200, text: async () => v };
  };
}
