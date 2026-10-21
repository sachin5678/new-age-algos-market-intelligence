import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarketWrapCard,
  renderMarketWrapCardHtml,
  sessionHeadline,
  keyHighlights,
} from '../src/visual/market-wrap-card.js';
import { cleanHeadline } from '../src/briefings/context.js';
import { pickLeadStory } from '../src/short/news.js';

/**
 * The post-market card is the channel's ONE daily post. It must be honest
 * (every number traceable to the data), complete (the benchmark line, the
 * day's biggest story, the movers) and safe to render (escaped, never
 * overflowing its canvas).
 */

const NOW = new Date('2026-10-21T10:15:00Z'); // 15:45 IST

const ctx = {
  indices: [
    { name: 'NIFTY 50', value: 22811.35, pct_change: -0.34 },
    { name: 'NIFTY BANK', value: 54976.9, pct_change: -0.92 },
    { name: 'SENSEX', value: 73709.69, pct_change: -0.19 },
  ],
  gainers: [
    { symbol: 'INDIACEM', name: 'India Cements Ltd.', pct: 12.04, price: 323.9 },
    { symbol: 'LTTS', name: 'L&T Technology Services Ltd.', pct: 10.66, price: 3983.9 },
  ],
  losers: [{ symbol: 'BIRET', name: 'Brookfield India Real Estate Trust', pct: -17.65, price: 263.49 }],
  story: {
    headline: 'RBI holds repo rate at 5.50%, signals room for further cuts',
    relevance: 'Cheaper funding costs would lift bank margins.',
    source: 'Livemint',
    url: 'https://www.livemint.com/economy/rbi-policy',
  },
};

test('the card carries the benchmark line, the story and the movers', () => {
  const card = buildMarketWrapCard(ctx, { now: NOW });
  assert.equal(card.date, '21 OCT 2026');
  assert.equal(card.time, '15:45 IST');
  assert.equal(card.indices.length, 3);
  assert.equal(card.gainers.length, 2);
  assert.equal(card.losers.length, 1);
  assert.equal(card.story.headline, ctx.story.headline);
});

test('the session headline is derived from the numbers, never invented', () => {
  const down = sessionHeadline(ctx.indices, ctx.gainers, ctx.losers);
  assert.ok(down.includes('NIFTY 50 FALLS'), down);
  assert.ok(down.includes('INDIACEM LEADS THE TAPE'), down);
  // 0.34% of ~22,889 is ~78 points
  assert.ok(/FALLS 7[0-9] POINTS/.test(down), down);

  const up = sessionHeadline([{ name: 'NIFTY 50', value: 22674.8, pct_change: 1.25 }], ctx.gainers, []);
  assert.ok(up.includes('GAINS'), up);
  assert.ok(/GAINS 2[0-9][0-9] POINTS/.test(up), up);

  const flat = sessionHeadline([{ name: 'NIFTY 50', value: 22674.8, pct_change: 0 }], [], []);
  assert.ok(flat.includes('ENDS FLAT'), flat);
  assert.ok(!flat.includes('LEADS'), flat);
});

test('the key highlights are facts, not adjectives', () => {
  const hl = keyHighlights(ctx.indices, ctx.gainers, ctx.losers, ctx.story);
  assert.ok(hl.some((h) => h.includes('22,811.35')), hl.join(' | '));
  assert.ok(hl.some((h) => h.includes('INDIACEM') && h.includes('12.04')), hl.join(' | '));
  assert.ok(hl.some((h) => h.includes('BIRET') && h.includes('17.65')), hl.join(' | '));
  assert.ok(hl.length <= 4);
});

test('the card HTML escapes every dynamic value', () => {
  const card = buildMarketWrapCard(
    {
      ...ctx,
      gainers: [{ symbol: 'X&Y', name: 'A & B <Ltd>', pct: 5, price: 1 }],
      story: { headline: 'RBI <b>hikes</b> & cuts', source: 'The "Wire"', url: 'https://x.test/a?b=1&c=2' },
    },
    { now: NOW }
  );
  const html = renderMarketWrapCardHtml(card, { width: 1080, height: 1600, scale: 2, exact: true });
  assert.ok(!html.includes('X&Y'), 'a raw & would break the HTML');
  assert.ok(html.includes('X&amp;Y'));
  assert.ok(html.includes('A &amp; B &lt;Ltd&gt;'));
  assert.ok(!html.includes('<b>hikes</b>'), 'a headline must not inject markup');
  assert.ok(html.includes('https://x.test/a?b=1&amp;c=2'), 'the link must stay valid');
});

test('a card with no data renders a shell, not a fake one', () => {
  const card = buildMarketWrapCard({}, { now: NOW });
  const html = renderMarketWrapCardHtml(card, { width: 1080, height: 1600, scale: 2, exact: true });
  // The visible text — the stylesheet legitimately talks in percentages.
  const visible = html.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  assert.ok(!visible.includes('TOP MOVERS'), 'a movers section appeared with no movers');
  assert.ok(!visible.includes('BIGGEST NEWS'), 'a news section appeared with no story');
  assert.ok(!visible.includes('%'), 'a percentage appeared with no source');
  assert.ok(visible.includes('MARKET CLOSING WRAP'), 'the card still identifies itself');
});

test('a long headline is cut at a word boundary, never mid-word', () => {
  const long =
    'RBI holds the repo rate steady and signals room for further cuts as inflation eases across the economy and banks brace for margin relief next quarter';
  assert.ok(long.length > 140);
  const card = buildMarketWrapCard({ ...ctx, story: { ...ctx.story, headline: long } }, { now: NOW });
  assert.ok(card.story.headline.length <= 141, `${card.story.headline.length}`);
  assert.ok(card.story.headline.endsWith('…'));
  assert.ok(card.story.headline.includes(' '), 'the cut landed on a space');
});

test('SEO furniture is stripped from the headline, the headline is not rewritten', () => {
  assert.equal(
    cleanHeadline('Infosys Q2 results, dividend 2026 amount, record date announcement date-time: Preview, earnings schedule, history, yield'),
    'Infosys Q2 results, dividend 2026 amount, record date announcement date-time'
  );
  assert.equal(cleanHeadline('Gold may test 4,000-mark if oil extends rally'), 'Gold may test 4,000-mark if oil extends rally');
  assert.equal(cleanHeadline('Sensex ends higher | Full Story'), 'Sensex ends higher');
});

test('the lead story is the best-READING headline of the day', () => {
  const stories = [
    { title: 'Infosys Q2 results, dividend 2026 amount, record date announcement date-time: Preview, earnings schedule, history, yield' },
    { title: 'RBI holds repo rate at 5.50%, signals room for further cuts' },
  ];
  const lead = pickLeadStory(stories);
  assert.equal(lead.title, stories[1].title);
  assert.equal(pickLeadStory([]), null);
  assert.equal(pickLeadStory([{ title: 'Only one story here' }]).title, 'Only one story here');
});
