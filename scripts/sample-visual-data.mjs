/**
 * SAMPLE / TEST DATA for the preview command (PART 31).
 *
 * Clearly-labelled fixtures used ONLY when `--sample` is passed or no live
 * store/inbox data exists. The production pipeline (src/index.js) never imports
 * this module. Every number below is fake-but-plausible; nothing here reaches
 * Telegram.
 *
 * Shape of the fixture (Mon 05 Oct 2026, 08:30 IST):
 *   - previous session = Thu 01 Oct 09:15–15:30 IST (02 Oct is Gandhi Jayanti,
 *     03/04 are the weekend) → 3 previous-session stories
 *   - overnight window  = Thu 01 Oct 15:30 IST → Mon 05 Oct 08:30 IST, which
 *     legitimately spans the weekend → 5 overnight stories
 *   - 3 look-ahead items on today's agenda
 *   - 1 duplicate report of the same event from a second outlet (dedupe check)
 *   - 1 FY24 relic with HIGH importance that MUST be dropped by the horizon
 *   - full snapshot set: Indian indices, US/Asia, crude, gold, USD/INR,
 *     breadth, FII/DII, sectors, movers
 */

export const SAMPLE_NOW = new Date('2026-10-05T03:00:00.000Z'); // Mon 05 Oct 2026, 08:30 IST

const at = (iso) => new Date(iso).toISOString();

// `trader_takeaway` must survive: it is the ONLY thing NEW AGE ALGOS VIEW is
// allowed to print — dropping it here silently emptied the section.
const verdict = ({ headline, relevance, impact, priority = 'medium', trader_takeaway = null }) => ({
  headline,
  market_relevance: relevance,
  impact,
  publication_priority: priority,
  confidence: 'high',
  affected_stocks: [],
  affected_sectors: [],
  ...(trader_takeaway ? { trader_takeaway } : {}),
});

function ev(o) {
  return {
    detection_status: 'NEW',
    trust_tier: 2,
    importance: 50,
    ...o,
    ai_verdict: verdict(o.ai_verdict ?? {}),
  };
}

// --------------------------------------------------------------- snapshots

const snap = (name, value, pct_change, source, extras = {}) => ({
  kind: 'snapshot',
  name,
  value,
  change: pct_change == null ? null : +(value * (pct_change / 100)).toFixed(2),
  pct_change: pct_change ?? null,
  asof: SAMPLE_NOW.toISOString(),
  source,
  extras,
});

const NSE = 'nseindia.com';
const YF = 'yfinance-native';

function buildSnapshots() {
  return [
    // Indian indices — previous session's close, as seen at 08:30 IST
    snap('NIFTY 50', 24685.35, 0.62, NSE),
    snap('NIFTY BANK', 52140.8, -0.36, NSE),
    snap('SENSEX', 80420.11, 0.54, NSE),
    // US
    snap('S&P 500', 6720.4, 0.01, YF),
    snap('NASDAQ', 22410.7, -0.14, YF),
    snap('DOW', 44810.2, 0.03, YF),
    // Asia
    snap('NIKKEI', 40120.5, 0.84, YF),
    snap('HANG SENG', 24118.9, -1.21, YF),
    snap('SHANGHAI', 3892.4, -0.37, YF),
    // Commodities / currency
    snap('BRENT', 78.42, 1.5, YF),
    snap('GOLD', 4182.6, -0.5, YF),
    snap('USD/INR', 88.26, 0.18, YF),
    // Breadth + flows (previous session)
    snap('ADVANCES', 1248, null, NSE),
    snap('DECLINES', 812, null, NSE),
    snap('FII', -2140.5, null, NSE),
    snap('DII', 1860.75, null, NSE),
    // Sectors
    snap('NIFTY IT', 44120.3, 1.24, NSE),
    snap('NIFTY BANK', 52140.8, -0.36, NSE),
    snap('NIFTY FMCG', 63102.4, 0.41, NSE),
    snap('NIFTY AUTO', 25840.7, -0.63, NSE),
    snap('NIFTY PHARMA', 22140.9, 0.88, NSE),
    snap('NIFTY METAL', 9840.2, -1.12, NSE),
    snap('NIFTY REALTY', 11420.6, 0.22, NSE),
    // Movers
    snap('RELIANCE INDUSTRIES', 1482.5, 2.31, NSE),
    snap('HDFC BANK', 1996.4, 1.84, NSE),
    snap('INFY', 1512.7, 1.42, NSE),
    snap('TCS', 3184.2, 0.96, NSE),
    snap('TATA MOTORS', 684.3, -2.14, NSE),
    snap('BAJAJ AUTO', 8940.5, -1.76, NSE),
    snap('JSW STEEL', 962.8, -1.32, NSE),
    snap('SUN PHARMA', 1742.1, -0.94, NSE),
  ];
}

// ------------------------------------------------------------------ events

// Previous session — Thu 01 Oct 09:15–15:30 IST  (03:45Z – 10:00Z)
const PREV_SESSION = [
  at('2026-10-01T04:20:00.000Z'),
  at('2026-10-01T07:05:00.000Z'),
  at('2026-10-01T09:30:00.000Z'),
];
// Overnight — Thu 01 Oct 15:30 IST → Mon 05 Oct 08:30 IST
const OVERNIGHT = [
  at('2026-10-02T14:40:00.000Z'),
  at('2026-10-03T05:15:00.000Z'),
  at('2026-10-04T14:05:00.000Z'),
  at('2026-10-04T23:30:00.000Z'),
  at('2026-10-05T01:20:00.000Z'),
];
// Look-ahead items published ahead of today's session
const LOOK_AHEAD = [
  at('2026-10-04T16:00:00.000Z'),
  at('2026-10-04T18:30:00.000Z'),
  at('2026-10-05T00:10:00.000Z'),
];

function buildEvents() {
  return [
    // ---------------------------------------------------- previous session
    ev({
      event_id: 'sample-prev-1',
      title: 'Nifty snaps three-day losing streak as banking heavyweights rally',
      source: 'Economic Times',
      url: 'https://economictimes.indiatimes.com/markets/nifty-snaps-three-day-losing-streak',
      published_at: PREV_SESSION[0],
      first_seen_at: PREV_SESSION[0],
      detected_at: PREV_SESSION[0],
      category: 'MARKET',
      importance_level: 'MEDIUM',
      importance: 62,
      sectors: ['Banking'],
      companies: ['HDFC BANK'],
      institutions: [],
      ai_summary:
        'The Nifty 50 ended 0.62% higher at 24,685.35, ending a three-day losing run as banking heavyweights led the recovery. HDFC Bank added 1.84% and was the single largest contributor to the index move. Breadth was positive with 1,248 advances against 812 declines.',
      ai_verdict: {
        headline: 'Nifty snaps three-day losing streak as banks lead the recovery',
        relevance:
          'Rate-sensitive sectors — banking, NBFCs and real estate — will keep taking cues from this week’s policy tone.',
        impact: 'positive',
        // Present on a previous-session story too: a quiet overnight must still
        // leave NEW AGE ALGOS VIEW with something to analyse.
        trader_takeaway:
          'A one-day reversal led by a single index heavyweights group is not yet a trend — the recovery has to be confirmed by breadth holding above 1,200 advances for a second session. Watch whether banks follow through before treating the pullback as complete.',
      },
    }),
    ev({
      event_id: 'sample-prev-2',
      title: 'SEBI tightens intraday position limits for prop desks from next month',
      source: 'Moneycontrol',
      url: 'https://www.moneycontrol.com/news/markets/sebi-intraday-position-limits-prop-desks',
      published_at: PREV_SESSION[1],
      first_seen_at: PREV_SESSION[1],
      detected_at: PREV_SESSION[1],
      category: 'SEBI',
      importance_level: 'HIGH',
      importance: 84,
      trust_tier: 2,
      sectors: ['Capital Markets'],
      companies: ['BROKERS'],
      institutions: ['SEBI'],
      ai_summary:
        'SEBI has asked brokerages to cap intraday positions per client from next month, a move aimed at reducing concentrated risk on proprietary desks. Broker bodies said the limits are workable but will compress intraday volumes for high-turnover operators. The circular did not specify a transition period beyond the effective date.',
      ai_verdict: {
        headline: 'SEBI caps intraday positions for prop desks from next month',
        relevance:
          'Derivatives volumes and broker revenue expectations may soften; hedging costs for large desks rise.',
        impact: 'negative',
      },
    }),
    ev({
      event_id: 'sample-prev-3',
      title: 'FIIs sell ₹2,140 crore in cash; DIIs absorb the selling with ₹1,860 crore of buying',
      source: 'Business Standard',
      url: 'https://www.business-standard.com/markets/fii-dii-flow-cash-market',
      published_at: PREV_SESSION[2],
      first_seen_at: PREV_SESSION[2],
      detected_at: PREV_SESSION[2],
      category: 'MARKET',
      importance_level: 'MEDIUM',
      importance: 58,
      sectors: [],
      companies: [],
      institutions: [],
      ai_summary:
        'Foreign investors net sold ₹2,140.5 crore of Indian equities in the cash market while domestic institutions bought ₹1,860.75 crore. The gap between the two kept the index from extending gains in the last hour of trade.',
      ai_verdict: {
        headline: 'FII selling offsets DII buying in the cash market',
        relevance: 'Sustained FII selling limits upside even when domestic flows are strong.',
        impact: 'mixed',
      },
    }),

    // ---------------------------------------------------------- overnight
    ev({
      event_id: 'sample-ov-1',
      title: 'Brent slips below $78 as OPEC+ signals a faster supply restore',
      source: 'Reuters',
      url: 'https://www.reuters.com/business/energy/brent-opec-supply-restore',
      published_at: OVERNIGHT[0],
      first_seen_at: OVERNIGHT[0],
      detected_at: OVERNIGHT[0],
      category: 'COMMODITIES',
      importance_level: 'HIGH',
      importance: 88,
      sectors: ['Oil & Gas'],
      companies: ['RELIANCE INDUSTRIES'],
      institutions: ['OPEC'],
      ai_summary:
        'Brent crude fell 1.5% to $78.42 after OPEC+ signalled it would restore supply faster than the market had priced. Cheaper crude eases India’s import bill and supports oil marketing companies and airline margins, while easing the inflation impulse that has kept policy attention on food and fuel.',
      ai_verdict: {
        headline: 'Brent below $78 after OPEC+ signals faster supply restore',
        relevance:
          'Higher crude widens the import bill when it rallies — OMCs, paint and airline margins re-rate with every dollar.',
        impact: 'positive',
      },
    }),
    ev({
      event_id: 'sample-ov-2',
      title: 'US payrolls beat estimates; treasury yields climb and the dollar firms',
      source: 'Bloomberg',
      url: 'https://www.bloomberg.com/news/articles/us-payrolls-treasury-yields-dollar',
      published_at: OVERNIGHT[1],
      first_seen_at: OVERNIGHT[1],
      detected_at: OVERNIGHT[1],
      category: 'GLOBAL',
      importance_level: 'HIGH',
      importance: 86,
      sectors: [],
      companies: [],
      institutions: ['US FED'],
      ai_summary:
        'US non-farm payrolls came in above consensus, pushing two-year treasury yields higher and strengthening the dollar index. Rate-cut expectations for the next meeting were pushed back, which historically weighs on emerging-market inflows and keeps the rupee under pressure.',
      ai_verdict: {
        headline: 'US payrolls beat; yields climb and the dollar firms',
        relevance: 'A firmer dollar and higher US yields typically slow FFI inflows into Indian equities.',
        impact: 'negative',
      },
    }),
    ev({
      event_id: 'sample-ov-3',
      title: 'Hang Seng closes 1.2% lower as China stimulus bets cool',
      source: 'CNBC',
      url: 'https://www.cnbc.com/2026/10/04/hang-seng-close-china-stimulus.html',
      published_at: OVERNIGHT[2],
      first_seen_at: OVERNIGHT[2],
      detected_at: OVERNIGHT[2],
      category: 'GLOBAL',
      importance_level: 'MEDIUM',
      importance: 54,
      sectors: [],
      companies: [],
      institutions: [],
      ai_summary:
        'Hong Kong’s Hang Seng index fell 1.21% and Shanghai comp 0.37% as expectations for fresh Chinese stimulus faded. Asian risk appetite into the Indian open is therefore muted despite a firm Nikkei.',
      ai_verdict: {
        headline: 'Hang Seng falls 1.2% as China stimulus bets cool',
        relevance: 'Weak Asian cues often set a soft tone for the Indian open before domestic flows arrive.',
        impact: 'mixed',
      },
    }),
    ev({
      event_id: 'sample-ov-4',
      title: 'RBI likely to hold repo rate this week, but tone is the swing factor',
      source: 'LiveMint',
      url: 'https://www.livemint.com/economy/rbi-policy-preview-repo-rate-tone',
      published_at: OVERNIGHT[3],
      first_seen_at: OVERNIGHT[3],
      detected_at: OVERNIGHT[3],
      category: 'RBI',
      importance_level: 'HIGH',
      importance: 92,
      sectors: ['Banking'],
      companies: ['HDFC BANK', 'ICICI BANK'],
      institutions: ['RBI'],
      ai_summary:
        'Consensus expects the Monetary Policy Committee to keep the repo rate unchanged at 5.50%, with attention on whether the stance shifts back toward neutrality. Bond yields and banking margins are both positioned around that wording rather than the rate itself.',
      ai_verdict: {
        headline: 'RBI seen holding rate this week; the stance wording is the swing factor',
        relevance: 'Rate-sensitive sectors — banking, NBFCs and real estate — will react to the stance language.',
        impact: 'mixed',
        priority: 'high',
        trader_takeaway:
          'With a rate hold fully priced, the market’s reaction will come from the stance wording rather than the number. Banking has already recovered on the previous session’s strength, so the risk is a sell-the-news open if the commentary stays hawkish.',
      },
    }),
    ev({
      event_id: 'sample-ov-5',
      title: 'USD/INR opens near 88.26; importers eye dollar demand',
      source: 'Moneycontrol',
      url: 'https://www.moneycontrol.com/news/currency/usd-inr-open-dollar-demand',
      published_at: OVERNIGHT[4],
      first_seen_at: OVERNIGHT[4],
      detected_at: OVERNIGHT[4],
      category: 'CURRENCY',
      importance_level: 'MEDIUM',
      importance: 52,
      sectors: [],
      companies: [],
      institutions: [],
      ai_summary:
        'The rupee is indicated at 88.26 to the dollar, a touch weaker, with month-end importers expected to meet dollar demand. The Reserve Bank is seen active near 88.40, limiting sharp moves.',
      ai_verdict: {
        headline: 'Rupee indicated at 88.26 with importers looking for dollars',
        relevance: 'A weaker rupee adds to imported inflation and can weigh on IT receipts in rupee terms.',
        impact: 'neutral',
      },
    }),

    // ------------------------------------------------------- look-ahead
    ev({
      event_id: 'sample-today-1',
      title: 'Q2 earnings season kicks off: TCS and HCLTech report this week',
      source: 'The Economic Times',
      url: 'https://economictimes.indiatimes.com/tech/q2-earnings-tcs-hcltech',
      published_at: LOOK_AHEAD[0],
      first_seen_at: LOOK_AHEAD[0],
      detected_at: LOOK_AHEAD[0],
      category: 'RESULTS',
      importance_level: 'MEDIUM',
      importance: 60,
      sectors: ['IT'],
      companies: ['TCS', 'HCL TECHNOLOGIES'],
      institutions: [],
      ai_summary:
        'The September-quarter reporting season opens with TCS and HCLTech, setting the tone for IT services guidance. Deal pipeline commentary will be watched more closely than headline revenue, which is expected to be flat quarter-on-quarter in dollar terms.',
      ai_verdict: {
        headline: 'Q2 opens with TCS and HCLTech; deal pipeline is the number to watch',
        relevance: 'IT services sentiment feeds the whole sector — peers usually re-rate on the first guidance print.',
        impact: 'neutral',
      },
    }),
    ev({
      event_id: 'sample-today-2',
      title: 'Index rebalancing effective today: three stocks enter the Nifty 50',
      source: 'Business Standard',
      url: 'https://www.business-standard.com/markets/nifty-rebalance-effective-today',
      published_at: LOOK_AHEAD[1],
      first_seen_at: LOOK_AHEAD[1],
      detected_at: LOOK_AHEAD[1],
      category: 'CORPORATE_ACTION',
      importance_level: 'MEDIUM',
      importance: 56,
      sectors: ['Capital Markets'],
      companies: ['TATA MOTORS', 'JSW STEEL'],
      institutions: ['NSE'],
      ai_summary:
        'The quarterly Nifty reshuffle takes effect today, with three entries and three exits. Passive funds tracking the index must trade at the close, which usually lifts volumes in the last thirty minutes of the session.',
      ai_verdict: {
        headline: 'Nifty reshuffle takes effect today; expect a heavy closing auction',
        relevance: 'Closing-auction volumes spike on rebalance days — execution costs rise for large orders.',
        impact: 'neutral',
      },
    }),
    ev({
      event_id: 'sample-today-3',
      title: 'Weekly F&O expiry shifts attention to 24,500 put writing',
      source: 'Moneycontrol',
      url: 'https://www.moneycontrol.com/news/markets/fno-expiry-put-writing-24500',
      published_at: LOOK_AHEAD[2],
      first_seen_at: LOOK_AHEAD[2],
      detected_at: LOOK_AHEAD[2],
      category: 'FNO',
      importance_level: 'MEDIUM',
      importance: 55,
      sectors: ['Banking'],
      companies: [],
      institutions: [],
      ai_summary:
        'Open interest is concentrated at the 24,500 strike on the put side ahead of the weekly expiry, with writers defending that level through the morning. A sustained move below it would force unwinding and add to downside momentum.',
      ai_verdict: {
        headline: 'Expiry focus sits at 24,500 put writing',
        relevance: 'A break of the 24,500 put base usually accelerates the move rather than starting one.',
        impact: 'mixed',
      },
    }),

    // ------------------------------------------------- duplicate coverage
    ev({
      event_id: 'sample-dup-sebi',
      title: 'SEBI tightens intraday position limits for prop desks',
      source: 'The Economic Times',
      url: 'https://economictimes.indiatimes.com/markets/sebi-intraday-position-limits',
      published_at: at('2026-10-01T07:40:00.000Z'),
      first_seen_at: at('2026-10-01T07:40:00.000Z'),
      detected_at: at('2026-10-01T07:40:00.000Z'),
      category: 'SEBI',
      importance_level: 'HIGH',
      importance: 70,
      sectors: ['Capital Markets'],
      companies: ['BROKERS'],
      institutions: ['SEBI'],
      ai_summary:
        'A second report of the same SEBI circular, confirming the effective date for the intraday position cap on proprietary desks.',
      ai_verdict: {
        headline: 'SEBI tightens intraday position limits for prop desks',
        relevance: 'Same circular as the primary report — the effective date is the only new detail.',
        impact: 'negative',
      },
    }),

    // ------------------------------------------------- MUST be dropped
    ev({
      event_id: 'sample-stale-1',
      title: "Cyient DLM's FY24 profit after tax surges 93%",
      source: 'Archived Feed',
      url: 'https://archive.example.com/cyient-dlm-fy24-pat',
      published_at: at('2024-06-15T08:00:00.000Z'),
      first_seen_at: at('2026-10-04T06:00:00.000Z'),
      detected_at: at('2026-10-04T06:00:00.000Z'),
      category: 'RESULTS',
      importance_level: 'HIGH',
      importance: 99,
      sectors: ['Defence'],
      companies: ['CYIENT'],
      institutions: [],
      ai_summary: 'Archived FY24 result note retained in the store for reference.',
      ai_verdict: {
        headline: "Cyient DLM's FY24 profit after tax surges 93%",
        relevance: 'Historical figure from a completed financial year.',
        impact: 'positive',
      },
    }),
  ];
}

// ---------------------------------------------------------------- exports

export function sampleData() {
  return {
    label: 'SAMPLE/TEST DATA — not production output',
    now: SAMPLE_NOW,
    snapshots: buildSnapshots(),
    events: buildEvents(),
  };
}

/**
 * The PART 32 edge case: a genuinely quiet overnight. Every global snapshot is
 * still present and the previous session still happened, so the page must fill
 * from YESTERDAY'S SESSION, KEEP AN EYE ON TODAY and TODAY'S CATALYSTS while
 * stating plainly that nothing new came in overnight.
 */
export function quietOvernightSample() {
  const base = sampleData();
  return {
    label: 'SAMPLE/TEST DATA — quiet overnight edge case',
    now: SAMPLE_NOW,
    snapshots: base.snapshots,
    events: base.events.filter(
      (e) =>
        e.published_at >= '2026-10-01T03:45:00.000Z' && e.published_at < '2026-10-01T10:00:00.000Z'
    ),
  };
}
