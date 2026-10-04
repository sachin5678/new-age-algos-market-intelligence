import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAlert, formatBreakingAlert, formatIntradayAlert, statusLine, statusShort, chunkMessage, isBreaking } from '../src/telegram/format.js';
import { escapeHtml } from '../src/telegram/transport.js';
import { SEP } from '../src/telegram/theme.js';

const NOW = new Date('2026-10-04T05:00:00.000Z'); // 10:30 IST

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
  trader_takeaway: 'Watch index OI for confirmation before reading the move as trend-following.',
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

test('escapeHtml decodes residual entities before escaping (no &#39; leaks)', () => {
  assert.equal(escapeHtml('DLM&#39;s profit'), "DLM's profit");
  // &amp; round-trips: decode → & then re-escape for HTML safety.
  assert.equal(escapeHtml('A &amp; B'), 'A &amp; B');
  assert.equal(escapeHtml('A & B'), 'A &amp; B');
});

test('formatAlert matches the New Age Algos breaking wire format (Telegram HTML)', () => {
  const text = formatAlert(event, verdict, { now: NOW });
  const lines = text.split('\n');

  assert.equal(lines[0], '🚨 <b>NEW AGE ALGOS</b>');
  assert.equal(lines[1], SEP);
  assert.equal(lines[2], '⚡ <b>HIGH-IMPACT MARKET ALERT</b>');
  assert.match(lines[3], /^<i>\d{2} [A-Z]{3} \d{4} • \d{2}:\d{2} IST<\/i>$/);

  // WHAT HAPPENED — story slug from extracted entities, headline + facts.
  assert.ok(text.includes('🔴 <b>SEBI • DERIVATIVES</b>'), 'story slug missing');
  assert.ok(text.includes(escapeHtml(verdict.headline)), 'headline missing');
  assert.ok(text.includes(escapeHtml(verdict.summary)), 'summary missing');

  // WHY IT MATTERS — interpretation kept separate from the fact.
  assert.ok(text.includes('📌 <b>Why it matters</b>'), 'market relevance missing');

  // MARKET IMPACT — direction + related exposure, never per-sector guesses.
  assert.ok(text.includes('📊 <b>MARKET IMPACT</b>'), 'impact section missing');
  assert.ok(text.includes('🟢 <b>Positive</b>'), 'impact indicator missing');
  assert.ok(text.includes('<b>Related:</b> 🏦 Banking'), 'related sectors missing');
  assert.ok(text.includes('<b>Stocks:</b> RELIANCE'), 'affected stocks missing');

  // VIEW — interpretation in a blockquote, only when the analysis produced one.
  assert.ok(text.includes('🧠 <b>NEW AGE ALGOS VIEW</b>'), 'view section missing');
  assert.ok(text.includes('<blockquote>'), 'view must render as a blockquote');

  // SOURCE / CONFIRMATION STATUS — real hyperlink, status from source hierarchy.
  assert.ok(text.includes('<a href="https://x.test/story?a=1&amp;b=2">Moneycontrol</a>'), 'source hyperlink missing');
  assert.ok(text.includes('⚠️ <i>Awaiting official confirmation — reported by Moneycontrol</i>'), 'status missing');

  assert.ok(text.trimEnd().endsWith('<i>Data-driven • Systematic • Transparent</i>'), 'brand footer missing');
  assert.ok(!/\\[()\-.|]/.test(text), 'literal MarkdownV2 escapes leaked');
});

test('formatAlert never leaks raw scores or classification internals', () => {
  const text = formatAlert(event, verdict, { now: NOW });
  assert.ok(!text.includes('92'), 'raw importance score leaked');
  assert.ok(!/importance/i.test(text), 'importance internals leaked');
  assert.ok(!/\bscore\b/i.test(text), 'score internals leaked');
  assert.ok(!/analysis_source|publication_priority|is_material/i.test(text), 'verdict internals leaked');
});

test('formatAlert omits unsupported sections entirely', () => {
  const text = formatAlert(
    { ...event, sectors: [], companies: [], importance_level: 'MEDIUM' },
    { headline: 'Story', summary: 'Sum.', market_relevance: '', affected_sectors: [], affected_stocks: [], impact: 'unclear', confidence: 'medium', publication_priority: 'medium', trader_takeaway: '' },
    { now: NOW }
  );
  assert.ok(!text.includes('MARKET IMPACT'), 'empty impact section must be omitted');
  assert.ok(!text.includes('Why it matters'), 'empty relevance must be omitted');
  assert.ok(!text.includes('Stocks:'), 'empty stocks must be omitted');
  assert.ok(!text.includes('NEW AGE ALGOS VIEW'), 'empty view must be omitted');
  assert.ok(!text.includes('⚪'), 'unclear impact must not be shouted');
});

test('isBreaking: official sources and material updates break; unverified media does not', () => {
  assert.ok(isBreaking({ trust_tier: 1, source_type: 'official' }, {}));
  assert.ok(isBreaking({ source_type: 'official' }, {}));
  assert.ok(isBreaking({ detection_status: 'UPDATED' }, {}));
  assert.ok(isBreaking({}, { publication_priority: 'high', confidence: 'high' }));
  assert.ok(!isBreaking({ trust_tier: 3 }, { publication_priority: 'high', confidence: 'medium' }));
});

test('regular updates use the MARKET UPDATE template, not the breaking one', () => {
  const text = formatAlert(
    { ...event, trust_tier: 3, source_type: 'media' },
    { ...verdict, confidence: 'medium' },
    { now: NOW }
  );
  assert.ok(text.includes('📈 <b>MARKET UPDATE</b>'), 'regular update template missing');
  assert.ok(!text.includes('HIGH-IMPACT MARKET ALERT'), 'regular update must not claim breaking');
  assert.ok(text.includes('👀 <b>Watch</b>: RELIANCE • BANKING'), 'watch line missing');
});

test('formatAlert escapes injected HTML in headline and summary', () => {
  const text = formatAlert(evilEvent(), {
    ...verdict,
    headline: '<script>alert(1)</script>',
    summary: '<b>bold?</b>',
  }, { now: NOW });
  assert.ok(!text.includes('<script>'));
  assert.ok(!text.includes('<b>bold?</b>'));
  assert.ok(text.includes('&lt;script&gt;'));
  assert.ok(text.includes('&lt;b&gt;bold?&lt;/b&gt;'));
});

function evilEvent() {
  return { ...event, title: '<script>alert(1)</script>', url: 'https://x.test/z?x=<img>' };
}

test('an unusable URL is shown as plain text, never as a fabricated link', () => {
  const text = formatAlert({ ...event, url: 'not-a-url' }, verdict, { now: NOW });
  assert.ok(!text.includes('<a href'), 'invalid URL must not become a hyperlink');
  assert.ok(text.includes('Moneycontrol'), 'source name must still be shown');
});

test('fallback verdict (facts, no summary) still renders a factual body', () => {
  const text = formatAlert(event, {
    headline: 'Plain story',
    facts: ['Fact one.', 'Fact two.'],
    affected_sectors: [],
    affected_stocks: [],
  }, { now: NOW });
  assert.ok(text.includes('Fact one. Fact two.'));
});

test('statusLine follows the source hierarchy and statusShort stays compact', () => {
  assert.ok(statusLine({ source: 'NSE', trust_tier: 1, source_type: 'official' }).startsWith('Confirmed'));
  assert.ok(
    statusLine({ source: 'Moneycontrol', trust_tier: 2, category: 'SEBI', institutions: ['SEBI'] }).startsWith(
      'Awaiting official confirmation'
    )
  );
  assert.ok(statusLine({ source: 'Reuters', trust_tier: 2, category: 'MARKET' }).startsWith('Reported'));
  assert.ok(statusLine({ source: 'Random Blog', trust_tier: 4 }).startsWith('Unconfirmed'));

  assert.equal(statusShort({ trust_tier: 1 }), 'Confirmed');
  assert.equal(statusShort({ trust_tier: 2, category: 'MARKET' }), 'Reported');
  assert.equal(statusShort({ trust_tier: 2, category: 'RBI' }), 'Awaiting official confirmation');
  assert.equal(statusShort({ trust_tier: 4 }), 'Unconfirmed');
});

test('templates render from a fixed clock (dates are never hardcoded)', () => {
  const breaking = formatBreakingAlert(event, verdict, { now: NOW });
  const intraday = formatIntradayAlert(event, verdict, { now: NOW });
  assert.ok(breaking.includes('<i>04 OCT 2026 • 10:30 IST</i>'));
  assert.ok(intraday.includes('<i>04 OCT 2026 • 10:30 IST</i>'));
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

test('chunkMessage balances HTML tags across split points', () => {
  const para = '<b>Bold market context that keeps going and going. </b>'.repeat(40);
  const big = Array(6).fill(para).join('\n\n');
  assert.ok(big.length > 4096);

  const chunks = chunkMessage(big, 4096);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    const opens = [...c.matchAll(/<b>/g)].length;
    const closes = [...c.matchAll(/<\/b>/g)].length;
    assert.equal(opens, closes, `unbalanced <b> in chunk: ${c.slice(0, 60)}…`);
  }
  // Every chunk after the first reopens the carried tag so bold survives.
  assert.ok(chunks[0].includes('<b>'));
  assert.ok(chunks[chunks.length - 1].includes('</b>'));
});
