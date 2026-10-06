/**
 * Print the new 10–12 line text briefings from realistic sample data.
 *   node scripts/print-digest.mjs
 */
import { buildPreMarketContext, buildClosingContext } from '../src/briefings/context.js';
import { formatPreMarketDigest, formatClosingDigest, BRIEF_MAX_LINES } from '../src/telegram/briefing-digest.js';

const now = new Date('2026-10-06T03:00:00Z'); // 08:30 IST

const snapshots = [
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
  { name: 'NIFTY FMCG', value: 62100.2, pct_change: -0.4 },
  { name: 'TRENT', value: 6120.0, pct_change: 5.2 },
  { name: 'Zomato', value: 268.4, pct_change: -3.1 },
  { name: 'FII', value: -1240.5, pct_change: null },
  { name: 'DII', value: 890.2, pct_change: null },
];

const events = [
  {
    title: 'RBI holds repo rate at 5.50%, signals room for further cuts',
    source: 'Livemint',
    url: 'https://www.livemint.com/economy/rbi-policy-october',
    importance_level: 'HIGH',
    importance: 92,
    category: 'RBI',
    companies: ['HDFCBANK', 'ICICIBANK'],
    sectors: ['BANKING'],
    ai_summary: 'The Monetary Policy Committee voted to keep the repo rate unchanged at 5.50%.',
    ai_verdict: {
      market_relevance: 'Cheaper funding costs would lift margin profiles for banks and improve credit demand.',
      trader_takeaway: 'Rate-sensitive names stay in focus; watch the post-policy press conference for guidance.',
    },
  },
  {
    title: 'IT majors extend winning run as US deal pipeline improves',
    source: 'Economic Times',
    url: 'https://economictimes.indiatimes.com/tech/it-deal-pipeline',
    importance_level: 'MEDIUM',
    importance: 74,
    category: 'SECTOR',
    companies: ['TCS', 'INFY'],
    sectors: ['IT'],
    ai_verdict: {
      market_relevance: 'Fresh deal wins translate into revenue visibility over the next two quarters.',
    },
  },
  {
    title: 'SEBI tightens intraday position limits for index derivatives',
    source: 'Business Standard',
    url: 'https://www.business-standard.com/markets/sebi-fno-limits',
    importance_level: 'MEDIUM',
    importance: 70,
    category: 'SEBI',
    companies: ['ZERODHA'],
    sectors: ['FNO'],
  },
];

const pre = buildPreMarketContext({ snapshots, events, now, keyEvents: ['RBI policy outcome at 10:00 IST', 'US CPI at 6:00 PM IST'] });
pre.view = 'Rate-sensitive counters remain the trade of the day; wait for the press conference before adding exposure.';

const close = buildClosingContext({ snapshots, events, now, watchNext: ['RBI press conference', 'Q2 earnings season kicks off'] });
close.view = 'Breadth improved but stayed narrow; leadership still sits with IT and PSU banks.';

function show(name, text) {
  const all = text.split('\n');
  const content = all.filter((l) => l.trim() !== '');
  const ok = content.length <= BRIEF_MAX_LINES;
  console.log(`\n=== ${name}  (${content.length} content lines, cap ${BRIEF_MAX_LINES}; ${all.length} rendered with section gaps) ${ok ? 'OK' : 'OVER CAP'} ===`);
  console.log('-'.repeat(72));
  console.log(text);
  console.log('-'.repeat(72));
  console.log(`chars=${text.length}`);
}

show('PRE-MARKET', formatPreMarketDigest(pre, { now }));
show('MARKET WRAP', formatClosingDigest(close, { now: new Date('2026-10-06T10:15:00Z') }));

// Sparse context: every optional section missing must still render cleanly.
show('PRE-MARKET (no data at all)', formatPreMarketDigest({ now }, { now }));
show('MARKET WRAP (no data at all)', formatClosingDigest({ now }, { now }));
