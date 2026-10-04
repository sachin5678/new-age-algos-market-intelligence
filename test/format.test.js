import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatAlert, statusLine, chunkMessage } from '../src/telegram/format.js';

const verdict = {
  event_type: 'regulatory',
  headline: 'SEBI raises F&O position limits',
  summary: 'The regulator raised index position limits for retail participants.',
  facts: ['Position limits raised to 1,500 contracts'],
  market_relevance: 'Derivative volumes may rise; brokers see higher activity.',
  affected_sectors: ['BANKING'],
  affected_stocks: ['RELIANCE'],
  impact: 'positive',
  confidence: 'high',
  source_type: 'reputable_media',
  is_material: true,
  publication_priority: 'high',
};

const event = {
  title: 'SEBI raises F&O position limits',
  url: 'https://x.test/story?a=1&b=2',
  source: 'Moneycontrol',
  trust_tier: 2,
  source_type: 'media',
  category: 'FNO',
  institutions: ['SEBI'],
  importance: 92,
  importance_level: 'HIGH',
};

test('escapeHtml neutralises Telegram HTML metacharacters', () => {
  assert.equal(escapeHtml('<b> & "x"'), '&lt;b&gt; &amp; "x"');
});

test('formatAlert matches the New Age Algos wire format', () => {
  const text = formatAlert(event, verdict);
  const lines = text.split('\n');

  assert.equal(lines[0], '🚨 MARKET ALERT');
  assert.ok(text.includes(escapeHtml(verdict.headline)));
  assert.ok(text.includes(verdict.summary));
  assert.ok(text.includes('📌 Market relevance:'));
  assert.ok(text.includes('🏭 Sectors:'));
  assert.ok(text.includes('BANKING'));
  assert.ok(text.includes('📊 Stocks potentially affected:'));
  assert.ok(text.includes('RELIANCE'));
  assert.ok(text.includes('🔎 Source:'));
  assert.ok(text.includes('Moneycontrol'));
  assert.ok(text.includes('⚠️ Status:'));
  assert.ok(text.trimEnd().endsWith('— New Age Algos'), 'brand footer missing');
});

test('formatAlert never leaks raw scores or classification internals', () => {
  const text = formatAlert(event, verdict);
  assert.ok(!text.includes('92'), 'raw importance score leaked');
  assert.ok(!/importance/i.test(text), 'importance internals leaked');
  assert.ok(!/\bscore\b/i.test(text), 'score internals leaked');
  assert.ok(!/\bHIGH\b/.test(text), 'importance level leaked');
});

test('formatAlert omits unsupported sectors/stocks sections entirely', () => {
  const text = formatAlert(
    { ...event, sectors: [] },
    { headline: 'Story', summary: 'Sum.', affected_sectors: [], affected_stocks: [] }
  );
  assert.ok(!text.includes('🏭 Sectors:'), 'empty sectors section must be omitted');
  assert.ok(!text.includes('📊 Stocks potentially affected:'), 'unsupported stocks must be omitted');
});

test('statusLine follows the source hierarchy', () => {
  assert.ok(statusLine({ source: 'NSE', trust_tier: 1, source_type: 'official' }).startsWith('Confirmed'));
  assert.ok(
    statusLine({ source: 'Moneycontrol', trust_tier: 2, category: 'SEBI', institutions: ['SEBI'] }).startsWith(
      'Awaiting official confirmation'
    )
  );
  assert.ok(statusLine({ source: 'Reuters', trust_tier: 2, category: 'MARKET' }).startsWith('Reported'));
  assert.ok(statusLine({ source: 'Random Blog', trust_tier: 4 }).startsWith('Unconfirmed'));
});

test('formatAlert escapes injected HTML in headline and summary', () => {
  const text = formatAlert(evilEvent(), {
    ...verdict,
    headline: '<script>alert(1)</script>',
    summary: '<b>bold?</b>',
  });
  assert.ok(!text.includes('<script>'));
  assert.ok(!text.includes('<b>bold?</b>'));
  assert.ok(text.includes('&lt;script&gt;'));
});

function evilEvent() {
  return { ...event, title: '<script>alert(1)</script>', url: 'https://x.test/z?x=<img>' };
}

test('fallback verdict (facts, no summary) still renders a summary line', () => {
  const text = formatAlert(event, {
    headline: 'Plain story',
    facts: ['Fact one.', 'Fact two.'],
    affected_sectors: [],
    affected_stocks: [],
  });
  assert.ok(text.includes('Fact one. Fact two.'));
});

test('chunkMessage respects the 4096-char Telegram limit', () => {
  const para = 'Market context line about Indian equities and global cues. '.repeat(4);
  const big = Array(30).fill(para).join('\n\n');
  assert.ok(big.length > 4096);

  const chunks = chunkMessage(big, 4096);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 4096, `chunk too long: ${c.length}`);
  assert.equal(chunks.join('').replace(/\s+/g, ''), big.replace(/\s+/g, ''), 'content lost while chunking');

  assert.deepEqual(chunkMessage('short', 4096), ['short']);
});
