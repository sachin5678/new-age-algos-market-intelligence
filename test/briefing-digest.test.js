import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreMarketContext, buildClosingContext } from '../src/briefings/context.js';
import {
  formatPreMarketDigest,
  formatClosingDigest,
  BRIEF_MAX_LINES,
} from '../src/telegram/briefing-digest.js';

/**
 * The channel used to receive one image PER PAGE: 5–7 messages twice a day,
 * plus 12 event messages in 22 seconds. The reader-facing contract now is:
 * one briefing = ONE text message of 10–12 lines, and alerts are plain text.
 */

const NOW = new Date('2026-10-06T03:00:00Z'); // 08:30 IST

function richSnapshots() {
  return [
    { name: 'NIFTY 50', value: 24612.35, pct_change: -0.42 },
    { name: 'Bank Nifty', value: 51340.1, pct_change: 0.18 },
    { name: 'S&P 500', value: 6720.4, pct_change: 0.21 },
    { name: 'Nasdaq 100', value: 24810.7, pct_change: 0.44 },
    { name: 'USD/INR', value: 88.42, pct_change: 0.09 },
    { name: 'Brent Crude', value: 78.1, pct_change: -1.2 },
    { name: 'Advances', value: 1420 },
    { name: 'Declines', value: 950 },
    { name: 'NIFTY IT', value: 43120.5, pct_change: 1.24 },
    { name: 'NIFTY PSU BANK', value: 6820.3, pct_change: 0.86 },
    { name: 'TRENT', value: 6120.0, pct_change: 5.2 },
    { name: 'FII', value: -1240.5 },
    { name: 'DII', value: 890.2 },
  ];
}

function events() {
  return [
    {
      title: 'RBI holds repo rate at 5.50%, signals room for further cuts',
      source: 'Livemint',
      url: 'https://www.livemint.com/economy/rbi-policy-october',
      importance_level: 'HIGH',
      importance: 92,
      category: 'RBI',
      companies: ['HDFCBANK'],
      sectors: ['BANKING'],
      ai_verdict: { market_relevance: 'Cheaper funding costs would lift margin profiles for banks.' },
    },
    {
      title: 'IT majors extend winning run as US deal pipeline improves',
      source: 'Economic Times',
      url: 'https://economictimes.indiatimes.com/tech/it',
      importance_level: 'MEDIUM',
      importance: 74,
      category: 'SECTOR',
      companies: ['TCS'],
      sectors: ['IT'],
    },
  ];
}

/** Tag balance — Telegram's parser rejects anything unclosed. */
function assertBalanced(text, label) {
  const stack = [];
  const re = /<\/?([a-z]+)(?:\s[^>]*)?>/g;
  let m;
  while ((m = re.exec(text))) {
    const [raw, tag] = m;
    if (raw.startsWith('</')) {
      assert.equal(stack.pop(), tag, `${label}: </${tag}> closes the wrong tag`);
    } else if (!raw.endsWith('/>')) {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, [], `${label}: unclosed tags`);
}

/** Telegram rejects a bare '&' — every one must be part of an entity. */
function assertEscaped(text, label) {
  const withoutEntities = text.replace(/&[a-z]+;/g, '');
  assert.ok(!withoutEntities.includes('&'), `${label}: unescaped '&' would fail Telegram's HTML parse`);
}

function richPre() {
  const ctx = buildPreMarketContext({
    snapshots: richSnapshots(),
    events: events(),
    now: NOW,
    keyEvents: ['RBI policy outcome at 10:00 IST'],
  });
  ctx.view = 'Rate-sensitive counters stay in focus.';
  return ctx;
}

function richClose() {
  const ctx = buildClosingContext({
    snapshots: richSnapshots(),
    events: events(),
    now: NOW,
    watchNext: ['RBI press conference'],
  });
  ctx.view = 'Breadth improved but stayed narrow.';
  return ctx;
}

test('pre-market digest is a single message of 10–12 lines', () => {
  const text = formatPreMarketDigest(richPre(), { now: NOW });
  const lines = text.split('\n');
  assert.ok(lines.length <= BRIEF_MAX_LINES, `too many lines: ${lines.length}`);
  assert.ok(lines.length >= 10, `reader asked for 10–12 lines, got ${lines.length}`);
  assert.ok(text.length < 4096, 'must fit one Telegram message without chunking');
  assertBalanced(text, 'pre-market');
  assertEscaped(text, 'pre-market');
});

test('closing digest is a single message of 10–12 lines', () => {
  const text = formatClosingDigest(richClose(), { now: NOW });
  const lines = text.split('\n');
  assert.ok(lines.length <= BRIEF_MAX_LINES, `too many lines: ${lines.length}`);
  assert.ok(lines.length >= 10, `reader asked for 10–12 lines, got ${lines.length}`);
  assertBalanced(text, 'closing');
  assertEscaped(text, 'closing');
});

test('the interpretation line is never shed to make room', () => {
  // It sits last in the message, so a naive bottom-up trim drops it first.
  for (const text of [formatPreMarketDigest(richPre(), { now: NOW }), formatClosingDigest(richClose(), { now: NOW })]) {
    assert.ok(text.includes('🧠 <blockquote>'), 'NEW AGE ALGOS VIEW went missing');
  }
});

test('every section with data survives; nothing is fabricated when empty', () => {
  const pre = formatPreMarketDigest(richPre(), { now: NOW });
  for (const marker of ['📈', '🌍', '🔥 <b>WHAT MATTERS TODAY</b>', '👀', '⚠️', '🧠']) {
    assert.ok(pre.includes(marker), `pre-market lost section ${marker}`);
  }

  const empty = formatPreMarketDigest({ now: NOW }, { now: NOW });
  const lines = empty.split('\n');
  assert.equal(lines.length, 3, 'header + rule + tail, no invented sections');
  for (const marker of ['📈', '🌍', '🔥', '👀', '⚠️', '🧠']) {
    assert.ok(!empty.includes(marker), `empty briefing fabricated section ${marker}`);
  }
});

test('stories keep their headline and source link', () => {
  const pre = formatPreMarketDigest(richPre(), { now: NOW });
  assert.ok(pre.includes('RBI holds repo rate at 5.50%'), 'lead headline missing');
  assert.ok(
    pre.includes('<a href="https://www.livemint.com/economy/rbi-policy-october">Livemint</a>'),
    'source must be hyperlinked'
  );
  // short, well-formed content must never be clipped
  assert.ok(!/RBI holds repo rate[^<]*…/.test(pre), 'a short headline must not be truncated');
});

test('S&P 500 is escaped — a raw & fails Telegram HTML parsing', () => {
  const pre = formatPreMarketDigest(richPre(), { now: NOW });
  assert.ok(pre.includes('S&amp;P 500'), 'S&P must be entity-escaped');
  assert.ok(!/S&P 500/.test(pre), 'raw S&P leaked');
});

test('an index is never listed as a stock mover', () => {
  const close = formatClosingDigest(richClose(), { now: NOW });
  const movers = close.split('\n').find((l) => l.includes('MOVERS')) ?? '';
  assert.ok(!/bank nifty/i.test(movers), `Bank Nifty leaked into MOVERS: ${movers}`);
  assert.ok(movers.includes('TRENT +5.20%'), `real mover missing: ${movers}`);
});

test('a full closing context sheds the least useful line, not the view', () => {
  // Every optional section populated puts content over the budget, so cap()
  // runs its shed order. Global cues go first; indices and view never do.
  const close = formatClosingDigest(richClose(), { now: NOW });
  assert.equal(close.split('\n').length, BRIEF_MAX_LINES, 'cap must still be met');
  assert.ok(close.includes('📈'), 'index line must survive');
  assert.ok(close.includes('🧠 <blockquote>'), 'view must survive');
  assert.ok(close.includes('🔮'), 'tomorrow matters more than global cues');
  assert.ok(!close.includes('🌍'), 'global cues are shed first');
});

test('reads the same context the long-form templates use', () => {
  // Swapping formatPreMarket() for the digest must not touch the data layer.
  const ctx = buildClosingContext({ snapshots: richSnapshots(), events: events(), now: NOW });
  const text = formatClosingDigest(ctx, { now: NOW });
  assert.ok(text.includes('24,612.35'), 'index value from buildClosingContext missing');
  assert.ok(text.includes('Adv 1,420'), 'breadth from buildClosingContext missing');
  assert.ok(text.includes('FII:'), 'FII flows from buildClosingContext missing');
});

test('digest never invents a number that is not in the context', () => {
  const text = formatClosingDigest({ now: NOW }, { now: NOW });
  // Only the computed timestamp may carry digits — no prices, no percentages.
  assert.ok(!text.includes('%'), 'a figure appeared with no source snapshot');
  assert.equal(text.split('\n').length, 3, 'header + rule + tail, nothing else');
});
