import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from './helpers.js';
import { createCategorizer } from '../src/normalize/categorize.js';
import { createEntityExtractor } from '../src/normalize/extractEntities.js';
import { normalizeArticle } from '../src/normalize/normalizeArticle.js';
import { parseFeed } from '../src/providers/parseFeed.js';

const cfg = testConfig();
const categorize = createCategorizer(cfg.categories);
const extract = createEntityExtractor(cfg.entities);

test('normalizeArticle returns the canonical news shape', () => {
  const a = normalizeArticle(
    {
      title: '<b>SEBI</b> moves on F&amp;O limits',
      description: 'The regulator acted &amp; markets watched.',
      source: 'Moneycontrol',
      url: 'https://www.moneycontrol.com/news/markets/x.html?utm_source=rss',
      published_at: 'Fri, 02 Oct 2026 09:15:00 GMT',
    },
    { categorizer: categorize, extractor: extract }
  );

  assert.ok(a);
  assert.equal(a.title, 'SEBI moves on F&O limits');
  assert.equal(a.description, 'The regulator acted & markets watched.');
  assert.equal(a.source, 'Moneycontrol');
  assert.equal(a.published_at, '2026-10-02T09:15:00.000Z');
  assert.equal(a.category, 'SEBI');
  assert.deepEqual(a.companies, []);
  assert.ok(a.institutions.includes('SEBI'));

  for (const k of ['title', 'description', 'source', 'url', 'published_at', 'category', 'companies', 'sectors']) {
    assert.ok(k in a, `missing required key: ${k}`);
  }
});

test('normalizeArticle drops items without title or url', () => {
  assert.equal(normalizeArticle({ url: 'https://x.test/a' }, { categorizer: categorize }), null);
  assert.equal(normalizeArticle({ title: 'No link here' }, { categorizer: categorize }), null);
  assert.equal(normalizeArticle({}, { categorizer: categorize }), null);
});

test('category classification follows configured precedence', () => {
  assert.equal(categorize({ title: 'RBI keeps repo rate unchanged at 6.50 percent' }), 'RBI');
  assert.equal(categorize({ title: 'Infosys Q2 results: net profit jumps 12 percent' }), 'RESULTS');
  assert.equal(categorize({ title: 'Gold prices hit record high in Mumbai' }), 'COMMODITIES');
  assert.equal(categorize({ title: 'SEBI eases F&O norms for retail traders' }), 'SEBI'); // SEBI beats FNO
  assert.equal(categorize({ title: 'Nifty snaps four-day rally, Sensex ends flat' }), 'MARKET');
  assert.equal(categorize({ title: 'Company X launches a childrens book division' }), 'OTHER');
});

test('entity extraction finds companies, sectors and institutions', () => {
  const r = extract('Reliance Industries shares jump as banking stocks rally; NSE asks brokers to comply');
  assert.ok(r.companies.includes('RELIANCE'));
  assert.ok(r.sectors.includes('BANKING'));
  assert.ok(r.institutions.includes('NSE'));
  assert.equal(r.companies.includes('TCS'), false);
});

test('parseFeed parses RSS 2.0 with CDATA and decodes entities', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Feed</title>
<item>
  <title><![CDATA[SEBI &amp; you: F&amp;O rules change]]></title>
  <link>https://site.test/story?utm_source=rs&amp;b=2</link>
  <description><![CDATA[<p>Regulator acts</p>]]></description>
  <pubDate>Fri, 02 Oct 2026 06:00:00 GMT</pubDate>
</item>
<item>
  <title>Item without link</title>
  <description>skipped</description>
</item>
</channel></rss>`;

  const items = parseFeed(xml, { source: 'Test', tier: 2 });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'SEBI & you: F&O rules change');
  assert.equal(items[0].url, 'https://site.test/story?utm_source=rs&b=2');
  assert.equal(items[0].description, 'Regulator acts');
  assert.equal(items[0].published_at, 'Fri, 02 Oct 2026 06:00:00 GMT');
  assert.equal(items[0].source, 'Test');
});

test('parseFeed parses Atom entries (link href)', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <title>India manufacturing PMI</title>
  <link href="https://atom.test/pmi"/>
  <summary>PMI at 57</summary>
  <published>2026-10-02T05:30:00Z</published>
</entry></feed>`;
  const items = parseFeed(atom, { source: 'AtomFeed' });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://atom.test/pmi');
  assert.equal(items[0].published_at, '2026-10-02T05:30:00Z');
  assert.equal(items[0].description, 'PMI at 57');
});

test('parseFeed tolerates garbage input', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed('<html><body>not a feed</body></html>'), []);
  assert.deepEqual(parseFeed(null), []);
});

test('entity decoding iterates to a fixed point (nested entities)', () => {
  const a = normalizeArticle(
    { title: 'Cyient DLM&#39;s profit &amp;#39; up', url: 'https://x.test/ent' },
    {}
  );
  assert.equal(a.title, "Cyient DLM's profit ' up");

  const b = normalizeArticle(
    { title: 'Double-escaped &amp;amp; sign &amp; other', url: 'https://x.test/ent2' },
    {}
  );
  assert.equal(b.title, 'Double-escaped & sign & other');
});
