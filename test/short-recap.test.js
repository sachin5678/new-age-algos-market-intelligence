import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecapShort,
  demoRecap,
  fmtNum,
  fmtPct,
} from '../src/short/recap.js';
import {
  dayChange,
  fetchMovers,
  fetchIndexPulse,
  newsForMover,
} from '../src/short/marketData.js';
import { candleChartSvg } from '../src/short/charts.js';
import { renderSceneHtml, SHORT_DIMS } from '../src/short/scenes.js';
import { CTA_SPEECH } from '../src/short/lang.js';

const candles = (n = 20, drift = 1) => {
  let p = 100;
  return Array.from({ length: n }, () => {
    const o = p;
    const c = o + drift + Math.sin(o) * 0.5;
    p = c;
    return { o: +o.toFixed(2), h: +(Math.max(o, c) + 1).toFixed(2), l: +(Math.min(o, c) - 1).toFixed(2), c: +c.toFixed(2) };
  });
};

const recapData = () => ({
  gainers: [
    { symbol: 'ITC', name: 'ITC', pct: 5.08, price: 462.35, candles: candles(20, 2) },
    { symbol: 'BAJFINANCE', name: 'Bajaj Finance', pct: 2.29, price: 985.4, candles: candles(20, 1) },
  ],
  losers: [
    { symbol: 'HCLTECH', name: 'HCL Tech', pct: -3.31, price: 1462.1, candles: candles(20, -2) },
    { symbol: 'HDFCBANK', name: 'HDFC Bank', pct: -2.27, price: 1988.6, candles: candles(20, -1) },
  ],
  pulse: [
    { name: 'NIFTY 50', value: 24812.35, pct: -0.42 },
    { name: 'NIFTY BANK', value: 55120.8, pct: -0.61 },
    { name: 'SENSEX', value: 81245.12, pct: -0.35 },
  ],
  events: [
    {
      title: 'HCL Tech slips 3% as IT spending outlook cools',
      description: 'Weak global tech cues.',
      source: 'Moneycontrol',
    },
  ],
  date: new Date('2026-10-05T10:00:00.000Z'),
});

// ------------------------------------------------------------- recap.js

test('buildRecapShort: scene order recap → gainers → losers → cta', () => {
  const short = buildRecapShort(recapData());
  const kinds = short.scenes.map((s) => s.kind);
  assert.equal(kinds[0], 'recap');
  assert.equal(kinds.at(-1), 'cta');
  assert.equal(kinds.filter((k) => k === 'mover').length, 4);
  // gainers ranked before losers
  assert.equal(short.scenes[1].dir, 'up');
  assert.equal(short.scenes[2].dir, 'up');
  assert.equal(short.scenes[3].dir, 'down');
  assert.equal(short.scenes[4].dir, 'down');
  assert.equal(short.scenes[1].rank, 'TOP GAINER 1');
  assert.equal(short.scenes[3].rank, 'TOP LOSER 1');
});

test('buildRecapShort: narration joins scene speeches, title ≤100 with #Shorts', () => {
  const short = buildRecapShort(recapData());
  assert.equal(short.narration, short.scenes.map((s) => s.speech).join(' '));
  assert.ok(short.title.length <= 100);
  assert.match(short.title, /#Shorts$/);
  assert.match(short.description, /Top gainers: ITC/);
  assert.match(short.description, /Top losers: HCLTECH/);
  assert.match(short.description, /NIFTY 50 24,812/);
});

test('buildRecapShort: hinglish narration uses spoken templates', () => {
  const short = buildRecapShort({ ...recapData(), lang: 'hinglish' });
  assert.match(short.scenes[0].speech, /Aaj ka market recap/);
  assert.match(short.narration, /bandh hua/);
  assert.match(short.narration, /\bgira\b/); // HCL fell
  assert.match(short.narration, /\bchadha\b/); // ITC rose
  assert.equal(short.scenes.at(-1).speech, CTA_SPEECH.hinglish);
  // on-screen copy stays English
  assert.match(short.scenes[1].text, /ITC/);
});

test('buildRecapShort: hindi narration is Devanagari', () => {
  const short = buildRecapShort({ ...recapData(), lang: 'hindi' });
  assert.match(short.scenes[0].speech, /[\u0900-\u097F]/);
  assert.match(short.narration, /बंद हुआ/);
  assert.equal(short.scenes.at(-1).speech, CTA_SPEECH.hindi);
});

test('buildRecapShort: matches store news onto movers', () => {
  const short = buildRecapShort(recapData());
  const hcl = short.scenes.find((s) => s.symbol === 'HCLTECH');
  assert.ok(hcl.news, 'HCL should get its news event');
  assert.match(hcl.news.title, /HCL Tech slips/);
  const itc = short.scenes.find((s) => s.symbol === 'ITC');
  assert.equal(itc.news, null);
});

test('buildRecapShort: throws with no data at all', () => {
  assert.throws(() => buildRecapShort({}), /at least one mover/);
});

test('mover scene hides the company name when it just repeats the symbol', () => {
  const short = buildRecapShort(recapData());
  const hcl = short.scenes.find((s) => s.symbol === 'HCLTECH');
  const dupHtml = renderSceneHtml(hcl, { date: '05 OCT 2026' }, SHORT_DIMS);
  assert.equal(/class="co"/.test(dupHtml), false, 'HCLTECH + HCL Tech must not double up');
  const itc = short.scenes.find((s) => s.symbol === 'ITC');
  const itcHtml = renderSceneHtml(itc, { date: '05 OCT 2026' }, SHORT_DIMS);
  assert.equal(/class="co"/.test(itcHtml), false, 'ITC + ITC must not double up');
  // a real distinct name still shows
  const named = { ...hcl, name: 'HCL Technologies Ltd' };
  const namedHtml = renderSceneHtml(named, { date: '05 OCT 2026' }, SHORT_DIMS);
  assert.match(namedHtml, /HCL Technologies Ltd/);
});

test('demoRecap: labelled sample with full data', () => {
  const d = demoRecap();
  assert.equal(d.sample, true);
  assert.ok(d.gainers.length >= 2 && d.losers.length >= 2);
  assert.equal(d.pulse.length, 3);
  assert.ok(d.events.length >= 1);
  const short = buildRecapShort(d);
  assert.equal(short.sample, true);
  assert.ok(short.narration.length > 40);
  // synthetic candles are scaled so the chart's last close matches the price
  for (const m of [...d.gainers, ...d.losers]) {
    assert.ok(Math.abs(m.candles.at(-1).c - m.price) < 0.01, `${m.symbol} chart close must equal its price`);
  }
});

test('fmtNum / fmtPct format Indian-style with sign', () => {
  assert.equal(fmtNum(24812.35, 0), '24,812');
  assert.equal(fmtPct(5.08), '+5.1%');
  assert.equal(fmtPct(-3.31), '−3.3%');
  assert.equal(fmtPct(NaN), '—');
});

// ---------------------------------------------------------- marketData.js

test('dayChange computes last-two-close change', () => {
  const ch = dayChange([100, 102, 101]);
  // (101 − 102) / 102 × 100
  assert.ok(Math.abs(ch.pct - -0.9803921568627451) < 1e-9);
  assert.equal(ch.price, 101);
  assert.equal(dayChange([100]), null);
  assert.equal(dayChange(null), null);
});

test('fetchMovers splits and sorts gainers/losers from chart JSON', async () => {
  const mkChart = (closes) => ({
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: closes.map((_, i) => 1700000000 + i * 86400),
            indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes }] },
          },
        ],
      },
    }),
    ok: true,
  });
  const universe = [
    ['AAA.NS', 'Alpha'],   // +10%
    ['BBB.NS', 'Beta'],    // -5%
    ['CCC.NS', 'Gamma'],   // +2%
    ['DDD.NS', 'Delta'],   // no data → skipped
  ];
  const fetchImpl = async (url) => {
    if (url.includes('AAA')) return mkChart([100, 110]);
    if (url.includes('BBB')) return mkChart([100, 95]);
    if (url.includes('CCC')) return mkChart([100, 102]);
    return { ok: false, json: async () => ({}) };
  };
  const { gainers, losers, failed } = await fetchMovers({ fetchImpl, universe, cap: 3 });
  assert.equal(gainers.length, 2);
  assert.equal(gainers[0].symbol, 'AAA');
  assert.equal(gainers[0].pct, 10);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].symbol, 'BBB');
  assert.equal(failed, 1);
});

test('fetchIndexPulse returns named rows and drops failures', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('BROKEN')) return { ok: false, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        chart: {
          result: [
            {
              timestamp: [1, 2],
              indicators: { quote: [{ open: [1, 1], high: [1, 1], low: [1, 1], close: [100, 101] }] },
            },
          ],
        },
      }),
    };
  };
  const pulse = await fetchIndexPulse({
    fetchImpl,
    indices: [['^NSEI', 'NIFTY 50'], ['^BROKEN', 'BROKEN']],
  });
  assert.equal(pulse.length, 1);
  assert.equal(pulse[0].name, 'NIFTY 50');
  assert.ok(Math.abs(pulse[0].pct - 1) < 1e-9);
});

test('newsForMover matches on name or symbol, else null', () => {
  const events = [
    { title: 'HCL Tech slips 3% on weak guidance' },
    { title: 'RBI holds rates steady' },
  ];
  const hit = newsForMover({ symbol: 'HCLTECH', name: 'HCL Tech' }, events);
  assert.match(hit.title, /HCL Tech/);
  assert.equal(newsForMover({ symbol: 'ZZZ', name: 'Zzz Corp' }, events), null);
});

// ------------------------------------------------------------- charts.js

test('candleChartSvg renders themed candles without NaN', () => {
  const svg = candleChartSvg({ candles: candles(20), width: 488, height: 190 });
  assert.match(svg, /<svg /);
  assert.match(svg, /viewBox="0 0 488 190"/);
  // one wick + one body per candle
  const rects = (svg.match(/<rect /g) ?? []).length;
  assert.ok(rects >= 20, `expected candle bodies, got ${rects} rects`);
  assert.equal(/NaN|undefined/.test(svg), false);
  assert.match(svg, /22C55E|EF4444/); // theme positive/negative hexes
});

test('candleChartSvg returns empty string for degenerate input', () => {
  assert.equal(candleChartSvg({ candles: [] }), '');
  assert.equal(candleChartSvg({ candles: [{ o: 1, h: 1, l: 1, c: 1 }] }), '');
  assert.equal(candleChartSvg({}), '');
});

// ------------------------------------------------------------- scenes.js

test('recap hook scene renders pulse + sample banner', () => {
  const short = buildRecapShort({ ...demoRecap(), lang: 'en' });
  const html = renderSceneHtml(short.scenes[0], { sample: true, date: '05 OCT 2026' }, SHORT_DIMS);
  assert.match(html, /Market recap/);
  assert.match(html, /sh-pulse/);
  assert.match(html, /NIFTY 50/);
  assert.match(html, /SAMPLE \/ TEST DATA/);
});

test('mover scene renders rank, %, chart svg and news strip', () => {
  const short = buildRecapShort(recapData());
  const hcl = short.scenes.find((s) => s.symbol === 'HCLTECH');
  const html = renderSceneHtml(hcl, { date: '05 OCT 2026' }, SHORT_DIMS);
  assert.match(html, /TOP LOSER 1/);
  assert.match(html, /HCLTECH/);
  assert.match(html, /m-down/);
  assert.match(html, /<svg /);
  assert.match(html, /sh-news/);
  assert.match(html, /HCL Tech slips/);
  // QA semantics: visible text only (the <style> block embeds base64 fonts
  // whose random bytes may contain "NaN" — validateImage strips <style> too)
  const visible = html.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  assert.equal(/NaN|undefined/.test(visible), false);
});
