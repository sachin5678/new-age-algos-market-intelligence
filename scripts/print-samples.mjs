/**
 * Sample output generator — renders every New Age Algos template with
 * realistic, clearly-marked TEST fixtures so the exact Telegram-ready HTML can
 * be inspected before anything is delivered.
 *
 *   npm run samples
 *
 * Nothing is sent: this script only prints.
 */
import { formatAlert, formatBreakingAlert, formatIntradayAlert, formatMarketSnapshot } from '../src/telegram/format.js';
import { formatPreMarket, formatClosing } from '../src/telegram/briefings.js';
import {
  buildPreMarketContext,
  buildClosingContext,
} from '../src/briefings/context.js';

const NOW = new Date('2026-10-04T05:00:00.000Z'); // 10:30 IST

// ---------------------------------------------------------------- fixtures
// All data below is TEST DATA for visual inspection only.

const baseEvent = {
  event_id: 'test-1',
  title: 'RBI signals 25 bps repo-rate increase after inflation review',
  description: 'TEST DATA.',
  url: 'https://economictimes.indiatimes.com/markets/stocks/news/rbi-rate-test',
  source: 'Economic Times',
  trust_tier: 2,
  source_type: 'media',
  category: 'RBI',
  institutions: ['RBI'],
  companies: ['HDFCBANK', 'ICICIBANK'],
  sectors: ['BANKING', 'REALTY'],
  importance: 92,
  importance_level: 'HIGH',
  detection_status: 'NEW',
};

const breakingVerdict = {
  event_type: 'monetary_policy',
  headline: 'RBI signals a 25 bps repo-rate increase after reviewing inflation and crude risks.',
  summary:
    'TEST DATA: The Monetary Policy Committee voted to raise the repo rate by 25 basis points to 6.75%, citing persistent food inflation and a weaker rupee. The stance was changed to “withdrawal of accommodation”.',
  facts: ['Repo rate raised 25 bps to 6.75%', 'Stance changed to withdrawal of accommodation'],
  market_relevance:
    'Higher borrowing costs pressure rate-sensitive sectors while net-interest margins may improve for banks.',
  affected_sectors: ['BANKING', 'REALTY'],
  affected_stocks: ['HDFCBANK', 'ICICIBANK'],
  impact: 'mixed',
  confidence: 'high',
  source_type: 'reputable_media',
  is_material: true,
  publication_priority: 'high',
  trader_takeaway:
    'Watch the banking reaction around the policy address rather than the headline number; confirmation would be sustained follow-through in NIFTY BANK and stable bond yields.',
};

const mediaEvent = {
  ...baseEvent,
  event_id: 'test-2',
  title: 'TCS beats Q2 expectations as discretionary spending returns',
  url: 'https://www.moneycontrol.com/news/business/tcs-q2-test',
  source: 'Moneycontrol',
  trust_tier: 3,
  category: 'STOCK',
  institutions: [],
  companies: ['TCS'],
  sectors: ['IT'],
  detection_status: 'NEW',
};

const mediaVerdict = {
  event_type: 'earnings',
  headline: 'TCS beats Q2 expectations as discretionary spending returns',
  summary: 'TEST DATA: Revenue grew 14% YoY with deal wins of USD 12.4 bn, the strongest this fiscal.',
  facts: [],
  market_relevance: 'Sets the tone for the IT earnings season and for NIFTY IT direction this week.',
  affected_sectors: ['IT'],
  affected_stocks: ['TCS'],
  impact: 'positive',
  confidence: 'medium',
  source_type: 'reputable_media',
  is_material: true,
  publication_priority: 'medium',
  trader_takeaway: '',
};

const snapshots = [
  { kind: 'snapshot', name: 'S&P 500', value: 6720.4, pct_change: -0.32 },
  { kind: 'snapshot', name: 'Nasdaq', value: 22450.1, pct_change: -0.51 },
  { kind: 'snapshot', name: 'Nikkei 225', value: 41200.3, pct_change: 0.21 },
  { kind: 'snapshot', name: 'Hang Seng', value: 24110.7, pct_change: 0.44 },
  { kind: 'snapshot', name: 'USD/INR', value: 88.45, pct_change: 0.12 },
  { kind: 'snapshot', name: 'Brent Crude', value: 78.2, pct_change: -1.1 },
  { kind: 'snapshot', name: 'Gold', value: 4120.0, pct_change: 0.4 },
  { kind: 'snapshot', name: 'NIFTY 50', value: 24850.35, pct_change: 0.72 },
  { kind: 'snapshot', name: 'NIFTY BANK', value: 52410.8, pct_change: 0.48 },
  { kind: 'snapshot', name: 'NIFTY IT', value: 43120.5, pct_change: 1.24 },
  { kind: 'snapshot', name: 'NIFTY AUTO', value: 26110.2, pct_change: 0.86 },
  { kind: 'snapshot', name: 'NIFTY PHARMA', value: 22140.9, pct_change: -0.42 },
  { kind: 'snapshot', name: 'NIFTY METAL', value: 9820.4, pct_change: 1.61 },
  { kind: 'snapshot', name: 'Advances', value: 1284 },
  { kind: 'snapshot', name: 'Declines', value: 932 },
  { kind: 'snapshot', name: 'FII', value: 1240.5 },
  { kind: 'snapshot', name: 'DII', value: 980.2 },
  { kind: 'snapshot', name: 'TCS', value: 4180.5, pct_change: 2.31 },
  { kind: 'snapshot', name: 'RELIANCE', value: 2912.4, pct_change: 1.42 },
  { kind: 'snapshot', name: 'VEDL', value: 468.9, pct_change: 3.05 },
];

const events = [
  {
    ...baseEvent,
    ai_summary: breakingVerdict.summary,
    ai_verdict: breakingVerdict,
  },
  {
    ...mediaEvent,
    ai_summary: mediaVerdict.summary,
    ai_verdict: mediaVerdict,
  },
  {
    event_id: 'test-3',
    title: 'SEBI tightens F&O position limits for retail traders',
    url: 'https://www.livemint.com/markets/sebi-fno-test',
    source: 'Livemint',
    trust_tier: 2,
    source_type: 'media',
    category: 'SEBI',
    institutions: ['SEBI'],
    companies: ['RELIANCE'],
    sectors: ['BANKING'],
    importance: 78,
    importance_level: 'HIGH',
    ai_verdict: {
      market_relevance: 'Derivative volumes may compress for index-heavy names.',
      trader_takeaway: 'Watch open interest in index futures for confirmation.',
    },
  },
];

// ---------------------------------------------------------------- templates

const preCtx = buildPreMarketContext({
  snapshots,
  events,
  now: NOW,
  keyEvents: ['10:00 AM — India services PMI', '2:30 PM — Auto sales data'],
});
preCtx.watchlist = ['TCS', 'RELIANCE', 'HDFCBANK', 'IT sector', 'Banking sector', 'Metals sector'];

const closingCtx = buildClosingContext({
  snapshots,
  events,
  now: NOW,
  watchNext: ['RBI policy address', 'Crude inventories', 'FII flow trend', 'IT earnings season'],
});

const samples = [
  ['1. PRE-MARKET', formatPreMarket(preCtx, { now: NOW })],
  ['2. BREAKING ALERT', formatBreakingAlert(baseEvent, breakingVerdict, { now: NOW })],
  ['3. INTRADAY ALERT', formatIntradayAlert(mediaEvent, mediaVerdict, { now: NOW })],
  [
    '4. MARKET SNAPSHOT',
    formatMarketSnapshot(
      {
        now: NOW,
        indices: [
          { name: 'NIFTY 50', value: 24850.35, pct_change: 0.72 },
          { name: 'NIFTY BANK', value: 52410.8, pct_change: 0.48 },
        ],
        breadth: { advances: 1284, declines: 932 },
        flows: [
          { name: 'FII', value: '₹+1,240 Cr' },
          { name: 'DII', value: '₹+980 Cr' },
        ],
        leaders: ['TCS', 'VEDL', 'RELIANCE'],
        laggards: ['SUNPHARMA', 'DRREDDY'],
      },
      { now: NOW }
    ),
  ],
  ['5. CLOSING', formatClosing(closingCtx, { now: NOW })],
  ['6. DISPATCH (formatAlert auto-picks breaking vs update)', formatAlert(mediaEvent, mediaVerdict, { now: NOW })],
];

for (const [name, text] of samples) {
  const words = text.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  console.log(`\n${'='.repeat(72)}\n${name}  —  ${text.length} chars / ~${words} words\n${'='.repeat(72)}\n`);
  console.log(text);
}
