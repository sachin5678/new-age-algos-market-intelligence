import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPreMarket, formatClosing } from '../src/telegram/briefings.js';
import {
  buildPreMarketContext,
  buildClosingContext,
  developmentsFromEvents,
  watchlistFromEvents,
  rankEvents,
} from '../src/briefings/context.js';

const fullPre = {
  date: '05 Oct 2026',
  us: ['S&P 500: 22,450 (-0.30%)', 'Nasdaq: 8,900 (-0.50%)'],
  asia: ['Nikkei 225: 41,200 (+0.20%)'],
  usdinr: '88.45 (+0.12%)',
  crude: '78.20 (-1.10%)',
  gold: '4,120.00 (+0.40%)',
  nifty: '24,700.00 (-0.40%)',
  banknifty: '55,300.00 (+0.20%)',
  developments: ['SEBI tightens F&O rules (Reuters)', 'RBI holds rates (Mint)'],
  watchlist: ['RELIANCE', 'HDFCBANK'],
  keyEvents: ['10:00 AM — India services PMI'],
};

test('pre-market brief renders every populated section in order', () => {
  const text = formatPreMarket(fullPre);
  const lines = text.split('\n');

  assert.equal(lines[0], '🌅 <b>NEW AGE ALGOS</b>');
  assert.equal(lines[1], '<b>PRE-MARKET BRIEF</b>');
  assert.equal(lines[2], '<i>05 Oct 2026</i>');

  const order = [
    '<b>🌍 GLOBAL CUES</b>',
    '<b>🇺🇸 US:</b>',
    '<b>🇯🇵 / 🇭🇰 / 🇨🇳 ASIA:</b>',
    '<b>💱 USD/INR:</b>',
    '<b>🛢️ CRUDE:</b>',
    '<b>🥇 GOLD:</b>',
    '<b>📊 INDIAN MARKET SETUP</b>',
    '<b>NIFTY:</b>',
    '<b>BANKNIFTY:</b>',
    '<b>🔥 TOP DEVELOPMENTS</b>',
    '1. SEBI tightens F&amp;O rules (Reuters)',
    '<b>🏭 STOCKS / SECTORS TO WATCH</b>',
    '• RELIANCE',
    "<b>⚠️ TODAY'S KEY EVENTS</b>",
    '• 10:00 AM — India services PMI',
  ];
  let last = -1;
  for (const marker of order) {
    const idx = text.indexOf(marker);
    assert.ok(idx > last, `marker missing or out of order: ${marker}`);
    last = idx;
  }

  assert.ok(text.trimEnd().endsWith('<i>Data-driven | Systematic | Transparent</i>'));
  // No MarkdownV2 escape residue must ever reach the reader.
  assert.ok(!/\\[()\-.|]/.test(text), 'literal backslash escapes leaked into the message');
});

test('pre-market brief caps developments/watch/key events (no 20+ item dumps)', () => {
  const text = formatPreMarket({
    date: '05 Oct 2026',
    developments: Array.from({ length: 12 }, (_, i) => `Story ${i + 1}`),
    watchlist: Array.from({ length: 15 }, (_, i) => `STOCK${i}`),
    keyEvents: Array.from({ length: 10 }, (_, i) => `Event ${i + 1}`),
  });
  assert.ok(text.includes('12.') === false, 'must not number beyond 5');
  assert.ok(!text.includes('6. Story 6'), 'developments must cap at 5');
  assert.ok(text.includes('5. Story 5'));
  assert.ok(!text.includes('• STOCK6'), 'watchlist must cap at 6');
  assert.ok(!text.includes('Event 7'), 'key events must cap at 6');
});

test('pre-market brief omits sections with no data (nothing fabricated)', () => {
  const text = formatPreMarket({ date: '05 Oct 2026' });
  assert.ok(!text.includes('GLOBAL CUES'));
  assert.ok(!text.includes('INDIAN MARKET SETUP'));
  assert.ok(!text.includes('TOP DEVELOPMENTS'));
  assert.ok(!text.includes('STOCKS / SECTORS TO WATCH'));
  assert.ok(!text.includes("TODAY'S KEY EVENTS"));
  assert.ok(text.includes('05 Oct 2026'));
  assert.ok(text.trimEnd().endsWith('<i>Data-driven | Systematic | Transparent</i>'));
});

const fullClose = {
  date: '02 Oct 2026',
  nifty: '24,700.00 (-0.40%)',
  banknifty: '55,300.00 (+0.20%)',
  advances: 1204,
  declines: 950,
  topSectors: ['PSU BANK: +1.40%', 'IT: +0.80%'],
  weakSectors: ['AUTO: -1.10%'],
  movers: ['RELIANCE: +2.30%', 'TCS: -1.50%'],
  developments: ['SEBI tightens F&O rules (Reuters)'],
  fii: ['FII: -1,204 Cr'],
  dii: ['DII: +850 Cr'],
  global: ['US (S&P 500): 22,450 (-0.30%)'],
  watchNext: ['RBI MPC minutes this week'],
};

test('closing brief renders every populated section in order', () => {
  const text = formatClosing(fullClose);
  assert.equal(text.split('\n')[0], '📊 <b>NEW AGE ALGOS</b>');
  assert.equal(text.split('\n')[1], '<b>INDIA MARKET CLOSE</b>');

  const order = [
    '<b>NIFTY:</b>',
    '<b>BANKNIFTY:</b>',
    '<b>📈 MARKET BREADTH</b>',
    '<b>Advances:</b> 1204',
    '<b>Declines:</b> 950',
    '<b>🏆 TOP SECTORS</b>',
    '<b>📉 WEAK SECTORS</b>',
    '<b>🔥 KEY STOCK MOVERS</b>',
    '<b>📰 IMPORTANT DEVELOPMENTS</b>',
    '<b>💰 FII / DII</b>',
    '<b>🌍 GLOBAL CUES</b>',
    '<b>📅 TOMORROW TO WATCH</b>',
  ];
  let last = -1;
  for (const marker of order) {
    const idx = text.indexOf(marker);
    assert.ok(idx > last, `marker missing or out of order: ${marker}`);
    last = idx;
  }
  assert.ok(text.trimEnd().endsWith('<i>Data-driven | Systematic | Transparent</i>'));
  assert.ok(!/importance|score/i.test(text), 'internals leaked into closing brief');
  assert.ok(!/\\[()\-.|]/.test(text), 'literal backslash escapes leaked into the message');
});

test('closing brief omits empty sections and caps lists', () => {
  const text = formatClosing({ date: '02 Oct 2026', movers: Array.from({ length: 9 }, (_, i) => `S${i}: +${i}%`) });
  assert.ok(!text.includes('MARKET BREADTH'));
  assert.ok(!text.includes('TOP SECTORS'));
  assert.ok(!text.includes('FII / DII'));
  assert.ok(!text.includes('TOMORROW TO WATCH'));
  assert.ok(!text.includes('S5:'), 'movers must cap at 5');
  assert.ok(text.includes('S4:'));
});

// ------------------------------------------------------------------ context

const snaps = [
  { kind: 'snapshot', name: 'NIFTY 50', value: 24700, pct_change: -0.4 },
  { kind: 'snapshot', name: 'NIFTY BANK', value: 55300, pct_change: 0.2 },
  { kind: 'snapshot', name: 'S&P 500', value: 22450, pct_change: -0.3 },
  { kind: 'snapshot', name: 'Nikkei 225', value: 41200, pct_change: 0.2 },
  { kind: 'snapshot', name: 'USD/INR', value: 88.45, pct_change: 0.12 },
  { kind: 'snapshot', name: 'Brent Crude', value: 78.2, pct_change: -1.1 },
  { kind: 'snapshot', name: 'Gold', value: 4120, pct_change: 0.4 },
  { kind: 'snapshot', name: 'Advances', value: 1204 },
  { kind: 'snapshot', name: 'Declines', value: 950 },
  { kind: 'snapshot', name: 'NIFTY AUTO', value: 25000, pct_change: -1.2 },
  { kind: 'snapshot', name: 'NIFTY IT', value: 43000, pct_change: 0.9 },
  { kind: 'snapshot', name: 'RELIANCE', value: 2900, pct_change: 2.3 },
  { kind: 'snapshot', name: 'FII Cash', value: -1204 },
  { kind: 'snapshot', name: 'DII Cash', value: 850 },
];

const events = [
  {
    title: 'High story',
    source: 'Reuters',
    importance_level: 'HIGH',
    importance: 95,
    companies: ['RELIANCE'],
    sectors: ['ENERGY'],
  },
  { title: 'Mid story', source: 'Mint', importance_level: 'MEDIUM', importance: 60, companies: [], sectors: ['IT'] },
  { title: 'Low story', source: 'PTI', importance_level: 'LOW', importance: 10, companies: [], sectors: [] },
];

test('buildPreMarketContext maps snapshots to the right fields', () => {
  const ctx = buildPreMarketContext({ snapshots: snaps, events, now: new Date('2026-10-05T00:00:00Z') });
  assert.equal(ctx.nifty, '24,700 (-0.40%)');
  assert.equal(ctx.banknifty, '55,300 (+0.20%)');
  assert.equal(ctx.usdinr, '88.45 (+0.12%)');
  assert.equal(ctx.crude, '78.2 (-1.10%)');
  assert.ok(ctx.us.some((l) => l.includes('S&P 500')));
  assert.ok(ctx.asia.some((l) => l.includes('Nikkei')));
  assert.equal(ctx.developments.length, 3);
  assert.ok(ctx.developments[0].t.includes('High story'), 'HIGH ranks first');
  assert.ok(ctx.watchlist.includes('RELIANCE'));
});

test('buildPreMarketContext with no data omits sections (no fabrication)', () => {
  const ctx = buildPreMarketContext({ snapshots: [], events: [] });
  assert.equal(ctx.us, undefined);
  assert.equal(ctx.nifty, undefined);
  assert.equal(ctx.developments, undefined);
  assert.equal(ctx.watchlist, undefined);
  const text = formatPreMarket(ctx);
  assert.ok(!text.includes('NIFTY:'));
  assert.ok(!text.includes('GLOBAL CUES'));
});

test('buildClosingContext maps breadth, sectors, movers, FII/DII', () => {
  const ctx = buildClosingContext({ snapshots: snaps, events, now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(ctx.advances, 1204);
  assert.equal(ctx.declines, 950);
  assert.ok(ctx.topSectors[0].includes('IT:'), 'IT (+0.9%) ranks above AUTO (-1.2%)');
  assert.ok(ctx.weakSectors[0].includes('AUTO:'), 'weakest sector listed first');
  assert.ok(ctx.movers[0].startsWith('RELIANCE:'), 'biggest mover first');
  assert.ok(ctx.fii[0].includes('FII'));
  assert.ok(ctx.dii[0].includes('DII'));
  assert.ok(ctx.developments[0].t.includes('High story'));
  assert.ok(ctx.global.some((l) => l.includes('Crude')));
});

test('developments/watchlist are ranked and capped', () => {
  const dev = developmentsFromEvents(events, 5);
  assert.equal(dev.length, 3);
  assert.ok(dev[0].t.startsWith('High story'));
  assert.deepEqual(rankEvents(events, 2).map((e) => e.title), ['High story', 'Mid story']);

  const many = Array.from({ length: 10 }, (_, i) => ({
    title: `S${i}`,
    importance_level: 'HIGH',
    importance: 90 - i,
    companies: [`SYM${i}`],
    sectors: [],
  }));
  const watch = watchlistFromEvents(many, 6);
  assert.equal(watch.length, 6);
  assert.equal(watch[0], 'SYM0');
});
