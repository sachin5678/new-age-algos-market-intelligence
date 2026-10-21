import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConstituentsCsv,
  parseSparkResponse,
  rankMovers,
  toYahooSymbol,
  fromYahooSymbol,
  fetchMovers,
} from '../src/market/nifty500.js';
import { buildMarketWrapContext } from '../src/briefings/context.js';
import { formatMarketWrap } from '../src/telegram/market-wrap.js';

/**
 * The post-market wrap replaced two briefings (pre-market + closing digest)
 * with ONE message: the day's top 3 gainers and top 3 losers from the NIFTY
 * 500 and the single biggest news of the day.
 *
 * The contract: real numbers only, one message, nothing invented.
 */

const NOW = new Date('2026-10-21T10:15:00Z'); // 15:45 IST

const lines = (text) => text.split('\n');
const content = (text) => lines(text).filter((l) => l.trim() !== '');

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

function assertEscaped(text, label) {
  const withoutEntities = text.replace(/&[a-z]+;/g, '');
  assert.ok(!withoutEntities.includes('&'), `${label}: unescaped '&' would fail Telegram's HTML parse`);
}

const CSV = `Company Name,Industry,Symbol,Series,ISIN Code
Reliance Industries Ltd.,Oil And Gas,RELIANCE,EQ,INE002A01018
Larsen & Toubro Ltd.,Construction,LT,EQ,INE001A01010
"Bajaj Finance Ltd.",Financial Services,BAJFINANCE,EQ,INE917I01010
Bad Row,Test,lowercase,EQ,X
`;

test('the NSE CSV parses into symbol/name/industry rows', () => {
  const rows = parseConstituentsCsv(CSV);
  assert.equal(rows.length, 3, `unexpected rows: ${JSON.stringify(rows)}`);
  assert.deepEqual(rows[0], { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', industry: 'Oil And Gas' });
  assert.equal(rows[1].symbol, 'LT');
  assert.equal(rows[2].name, 'Bajaj Finance Ltd.', 'quoted CSV cell must survive');
  assert.ok(!rows.some((r) => r.symbol === 'lowercase'), 'a non-NSE symbol slipped in');
});

test('a broken CSV never throws and never invents rows', () => {
  assert.deepEqual(parseConstituentsCsv(''), []);
  assert.deepEqual(parseConstituentsCsv('garbage'), []);
  // A header without a name column still yields the symbol, and the name
  // falls back to it — a ticker is never invented.
  const symbolOnly = parseConstituentsCsv('Symbol\nRELIANCE');
  assert.equal(symbolOnly.length, 1);
  assert.equal(symbolOnly[0].name, 'RELIANCE');
});

test('Yahoo symbols round-trip', () => {
  assert.equal(toYahooSymbol('RELIANCE'), 'RELIANCE.NS');
  assert.equal(toYahooSymbol('RELIANCE.NS'), 'RELIANCE.NS');
  assert.equal(fromYahooSymbol('RELIANCE.NS'), 'RELIANCE');
});

test('the day move comes from the last two closes', () => {
  const rows = parseSparkResponse({
    'RELIANCE.NS': {
      symbol: 'RELIANCE.NS',
      close: [100, 110, 121],
      timestamp: [1, 2, 1792570000],
      fulldayPrice: 121,
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'RELIANCE');
  assert.equal(rows[0].price, 121);
  assert.equal(Number(rows[0].pct.toFixed(2)), 10);
  assert.equal(rows[0].sessionAt, 1792570000000);
});

test("Yahoo's own percentage is used when the bar series is too short", () => {
  const rows = parseSparkResponse({
    'X.NS': { symbol: 'X.NS', close: [50], fulldayPrice: 50, fulldayChangePercent: -2.5, timestamp: [1792570000] },
  });
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].pct.toFixed(2)), -2.5);
});

test('a row without a usable price is dropped, never faked', () => {
  const rows = parseSparkResponse({
    'A.NS': { symbol: 'A.NS', close: [], fulldayPrice: null, fulldayChangePercent: 1 },
    'B.NS': { symbol: 'B.NS', close: [10], fulldayPrice: 0, fulldayChangePercent: 1 },
    'C.NS': null,
  });
  assert.equal(rows.length, 0, `rows leaked: ${JSON.stringify(rows)}`);
});

test('rankMovers returns the 3 best of each side and ignores flat names', () => {
  const rows = [
    { symbol: 'A', pct: 1 },
    { symbol: 'B', pct: 9 },
    { symbol: 'C', pct: 5 },
    { symbol: 'D', pct: 7 },
    { symbol: 'E', pct: 0 },
    { symbol: 'F', pct: -2 },
    { symbol: 'G', pct: -8 },
    { symbol: 'H', pct: -3 },
    { symbol: 'I', pct: -9 },
    { symbol: 'J', pct: -1 },
  ];
  const { gainers, losers } = rankMovers(rows, { cap: 3 });
  assert.deepEqual(gainers.map((g) => g.symbol), ['B', 'D', 'C']);
  assert.deepEqual(losers.map((l) => l.symbol), ['I', 'G', 'H']);
  assert.ok(!gainers.some((g) => g.symbol === 'E'), 'a flat name must not be a "gainer"');
});

test('a partial batch is repaired with the per-symbol chart endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/v8/finance/spark')) {
      // The batch answers only half the symbols — Yahoo throttles bursts.
      return {
        ok: true,
        json: async () => ({
          'AAA.NS': { symbol: 'AAA.NS', close: [10, 12], fulldayPrice: 12, timestamp: [1792570000] },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { regularMarketPrice: 50, chartPreviousClose: 60, regularMarketTime: 1792570000, shortName: 'BBB' },
              timestamp: [1792570000],
              indicators: { quote: [{ close: [55, 50] }] },
            },
          ],
        },
      }),
    };
  };

  const { rows, missing } = await fetchMovers({
    fetchImpl,
    symbols: ['AAA', 'BBB'],
    chunkSize: 20,
    now: NOW.getTime(),
  });
  assert.equal(rows.length, 2, `rows: ${JSON.stringify(rows)}`);
  assert.deepEqual(missing, []);
  const bbb = rows.find((r) => r.symbol === 'BBB');
  // The last two daily closes are the two sessions — chartPreviousClose on a
  // 5-day range is the close BEFORE the window and would be wrong.
  assert.equal(Number(bbb.pct.toFixed(2)), -9.09);
  assert.ok(calls.some((u) => u.includes('/v8/finance/chart/')), 'the gap must be filled by the chart endpoint');
});

test('a stale quote is never reported as today’s move', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      'AAA.NS': { symbol: 'AAA.NS', close: [10, 12], fulldayPrice: 12, timestamp: [1_600_000_000] },
    }),
  });
  const { rows } = await fetchMovers({ fetchImpl, symbols: ['AAA'], now: NOW.getTime() });
  assert.equal(rows.length, 0, 'a bar from 2020 must not reach the wrap');
});

// ------------------------------------------------------------------ the wrap

function wrapContext() {
  return buildMarketWrapContext({
    snapshots: [
      { name: 'NIFTY 50', value: 22674.8, pct_change: -0.94 },
      { name: 'NIFTY BANK', value: 54771.55, pct_change: -1.29 },
      { name: 'SENSEX', value: 73292.3, pct_change: -0.76 },
    ],
    events: [
      {
        title: 'RBI holds repo rate at 5.50%, signals room for further cuts',
        source: 'Livemint',
        url: 'https://www.livemint.com/economy/rbi-policy-october',
        importance_level: 'HIGH',
        importance: 92,
        ai_verdict: { market_relevance: 'Cheaper funding costs would lift bank margins.' },
      },
      {
        title: 'IT majors extend winning run as US deal pipeline improves',
        source: 'Economic Times',
        url: 'https://economictimes.indiatimes.com/tech/it',
        importance_level: 'MEDIUM',
        importance: 74,
      },
    ],
    movers: {
      gainers: [
        { symbol: 'INDIACEM', name: 'India Cements Ltd.', pct: 9.92, price: 323.55 },
        { symbol: 'LTTS', name: 'L&T Technology Services Ltd.', pct: 9.88, price: 3968 },
        { symbol: 'FRACTAL', name: 'Fractal Analytics Ltd.', pct: 8.63, price: 775 },
        { symbol: 'EXTRA', name: 'Extra Ltd.', pct: 1.2, price: 10 },
      ],
      losers: [
        { symbol: 'BIRET', name: 'Brookfield India Real Estate Trust', pct: -17.65, price: 263.49 },
        { symbol: 'EMBASSY', name: 'EMBASSY OFFICE PARKS REIT', pct: -15.04, price: 369.92 },
        { symbol: 'HSCL', name: 'Himadri Speciality Chemical Ltd.', pct: -11.27, price: 537.55 },
        { symbol: 'EXTRA2', name: 'Extra2 Ltd.', pct: -1.2, price: 10 },
      ],
    },
    now: NOW,
  });
}

test('the wrap is ONE message with the index line, 3 gainers, 3 losers and one story', () => {
  const text = formatMarketWrap(wrapContext(), { now: NOW });
  assert.ok(text.length < 4096, 'must fit one Telegram message without chunking');
  assertBalanced(text, 'wrap');
  assertEscaped(text, 'wrap');

  // The market-closing-wrap format: title + date, session headline, the
  // benchmark line, key highlights, the story, the movers.
  assert.ok(text.includes('MARKET CLOSING WRAP'), 'the wrap must say what it is');
  assert.ok(text.includes('21 OCT 2026'), 'the date is missing');
  assert.ok(text.includes('NIFTY 50 FALLS'), 'the session headline is missing');
  assert.ok(text.includes('NIFTY 50: 22,674.80'), 'the index line is missing');

  const gainers = content(text).filter((l) => /^🟢 [A-Z&0-9.]+: \+/.test(l));
  const losers = content(text).filter((l) => /^🔴 [A-Z&0-9.]+: -/.test(l));
  assert.equal(gainers.length, 3, `expected 3 gainers, got ${gainers.length}`);
  assert.equal(losers.length, 3, `expected 3 losers, got ${losers.length}`);
  assert.ok(!text.includes('EXTRA'), 'a 4th mover must not be printed');

  assert.ok(text.includes('RBI holds repo rate at 5.50%'), 'the biggest story is missing');
  assert.ok(!text.includes('IT majors extend winning run'), 'only ONE story is printed');
  assert.ok(
    text.includes('<a href="https://www.livemint.com/economy/rbi-policy-october">Livemint</a>'),
    'the source must be hyperlinked'
  );
});

test('the movers are listed as one line per stock, gainers then losers', () => {
  const text = formatMarketWrap(wrapContext(), { now: NOW });
  const moverLines = content(text).filter((l) => /^(🟢|🔴) [A-Z&0-9.]+:/.test(l));
  assert.equal(moverLines.length, 6, `expected 6 mover lines, got ${moverLines.length}`);
  assert.ok(moverLines[0].startsWith('🟢 INDIACEM: +9.92%'), moverLines[0]);
  assert.ok(moverLines[3].startsWith('🔴 BIRET: -17.65%'), moverLines[3]);
  assert.ok(text.includes('TOP MOVERS'), 'the movers section header is missing');
  assert.ok(text.includes('KEY HIGHLIGHTS'), 'the highlights section header is missing');
  assert.ok(text.includes('BIGGEST NEWS'), 'the news section header is missing');
});

test('an ampersand in a company name is escaped', () => {
  const ctx = wrapContext();
  ctx.gainers[0] = { symbol: 'LT', name: 'Larsen & Toubro Ltd.', pct: 5.2, price: 3968 };
  const text = formatMarketWrap(ctx, { now: NOW });
  assert.ok(text.includes('Larsen &amp; Toubro Ltd.'), 'the ampersand must be an entity');
  assert.ok(!/Larsen & Toubro/.test(text), 'a raw & would break Telegram HTML parsing');
});

test('nothing is invented when the data is missing', () => {
  const text = formatMarketWrap({ now: NOW }, { now: NOW });
  assert.ok(!text.includes('%'), 'a percentage appeared with no source');
  assert.ok(!text.includes('TOP GAINERS'), 'a gainers section was fabricated');
  assert.ok(!text.includes('TOP LOSERS'), 'a losers section was fabricated');
  assert.ok(!text.includes('BIGGEST NEWS'), 'a news section was fabricated');
  assertBalanced(text, 'empty wrap');
});

test('one missing side still prints the other', () => {
  const ctx = wrapContext();
  ctx.losers = [];
  const text = formatMarketWrap(ctx, { now: NOW });
  assert.ok(text.includes('INDIACEM'), 'the gainers must survive');
  assert.ok(!/^🔴 /m.test(text), 'a loser line appeared with no losers');
  assert.ok(text.includes('TOP MOVERS'), 'the movers section header is missing');
});

test('the story is the most important event of the day, not the newest', () => {
  const ctx = buildMarketWrapContext({
    snapshots: [],
    events: [
      { title: 'Minor update', source: 'X', importance_level: 'LOW', importance: 10 },
      { title: 'Big policy call', source: 'Y', importance_level: 'HIGH', importance: 95 },
      { title: 'Medium thing', source: 'Z', importance_level: 'MEDIUM', importance: 60 },
    ],
    movers: { gainers: [], losers: [] },
    now: NOW,
  });
  assert.equal(ctx.story.headline, 'Big policy call');
});
