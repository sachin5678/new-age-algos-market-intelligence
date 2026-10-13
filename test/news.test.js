import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoundupVerdict,
  cleanTitle,
  decodeEntities,
  fetchNewsRoundup,
  headlineTokens,
  istDateLabel,
  jaccard,
  parseRssItems,
  roundupEvent,
  scoreHeadline,
  selectTopStories,
} from '../src/short/news.js';

/** 13 Oct 2026, 13:00 IST — inside every fixture story's window. */
const NOW = Date.parse('2026-10-13T07:30:00Z');

const FEED_A = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Feed A</title>
  <item>
    <title>RBI holds repo rate, flags inflation risk</title>
    <link>https://a.example/1</link>
    <pubDate>Tue, 13 Oct 2026 09:00:00 +0530</pubDate>
  </item>
  <item>
    <title><![CDATA[Share market today: Nifty rallies 1% as banks surge]]></title>
    <link><![CDATA[https://a.example/2]]></link>
    <pubDate>Tue, 13 Oct 2026 10:00:00 +0530</pubDate>
  </item>
  <item>
    <title>Old story from last week &amp; then some</title>
    <link>https://a.example/old</link>
    <pubDate>Mon, 05 Oct 2026 10:00:00 +0530</pubDate>
  </item>
  <item>
    <title>No date story</title>
    <link>https://a.example/nodate</link>
  </item>
</channel></rss>`;

const FEED_B = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed B</title>
  <item>
    <title>Share market today: Nifty rallies 1% as banks &amp; NBFCs surge</title>
    <link>https://b.example/9</link>
    <pubDate>Tue, 13 Oct 2026 10:05:00 +0530</pubDate>
  </item>
  <item>
    <title>Jio Platforms IPO sees $20 billion in pre-IPO bids</title>
    <link>https://b.example/3</link>
    <pubDate>Tue, 13 Oct 2026 11:00:00 +0530</pubDate>
  </item>
</channel></rss>`;

const withSource = (xml, source) =>
  parseRssItems(xml).map((i) => ({ ...i, source }));

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(decodeEntities('banks &amp; NBFCs'), 'banks & NBFCs');
  assert.equal(decodeEntities('₹10 &#8377; or &#x20B9;'), '₹10 ₹ or ₹');
  assert.equal(decodeEntities('a &lt;b&gt; &quot;c&quot;'), 'a <b> "c"');
});

test('cleanTitle strips tags, entities and edge punctuation', () => {
  assert.equal(cleanTitle('<b>Big</b>  move &amp;  more!'), 'Big move & more!');
  assert.equal(cleanTitle(' | Lead story: Nifty up | '), 'Lead story: Nifty up');
});

test('parseRssItems parses CDATA, drops undated items', () => {
  const items = parseRssItems(FEED_A);
  assert.equal(items.length, 3); // 4 blocks, one without pubDate
  assert.equal(items[1].title, 'Share market today: Nifty rallies 1% as banks surge');
  assert.equal(items[1].link, 'https://a.example/2');
  assert.ok(items.every((i) => Number.isFinite(i.ts)));
});

test('scoreHeadline ranks market-moving words higher', () => {
  assert.ok(scoreHeadline('RBI holds repo rate, flags inflation') >
    scoreHeadline('Share market today: Nifty up 1%'));
  assert.ok(scoreHeadline('Fund house meets management') === 1);
  assert.equal(scoreHeadline(''), 0);
});

test('headlineTokens + jaccard detect syndicated duplicates', () => {
  const a = headlineTokens('Share market today: Nifty rallies 1% as banks surge');
  const b = headlineTokens('Share market today: Nifty rallies 1% as banks & NBFCs surge');
  assert.ok(jaccard(a, b) >= 0.55, `expected overlap, got ${jaccard(a, b)}`);
  assert.ok(jaccard(a, headlineTokens('Jio Platforms IPO sees record bids')) < 0.2);
});

test('selectTopStories: window filter, dedupe, top by score', () => {
  const items = [
    ...withSource(FEED_A, 'Feed A'),
    ...withSource(FEED_B, 'Feed B'),
  ];
  const top = selectTopStories(items, { now: NOW });

  assert.equal(top.length, 3);
  assert.ok(top[0].title.startsWith('RBI holds repo rate'), `top was: ${top[0].title}`);
  // the Nifty story appears once, from both feeds merged
  const nifty = top.filter((s) => s.title.includes('Nifty rallies'));
  assert.equal(nifty.length, 1);
  assert.deepEqual([...nifty[0].sources].sort(), ['Feed A', 'Feed B']);
  // last-week story stayed outside the 24h window
  assert.ok(!top.some((s) => s.link.includes('/old')));
});

test('istDateLabel converts to the IST calendar day', () => {
  assert.deepEqual(istDateLabel(Date.parse('2026-10-13T07:30:00Z')), {
    iso: '2026-10-13',
    label: '13 Oct 2026',
  });
  // 19:00 UTC is already past midnight IST
  assert.equal(istDateLabel(Date.parse('2026-10-13T19:00:00Z')).iso, '2026-10-14');
});

test('buildRoundupVerdict: renderable verdict, label in headline', () => {
  const stories = selectTopStories(
    [...withSource(FEED_A, 'Feed A'), ...withSource(FEED_B, 'Feed B')],
    { now: NOW }
  );
  const v = buildRoundupVerdict(stories, '13 Oct 2026');
  assert.equal(v.facts.length, 3);
  assert.ok(v.headline.includes('13 Oct 2026'));
  assert.ok(v.summary.includes('(1)'));
  assert.ok(v.market_relevance.includes('13 Oct 2026'));
  assert.ok(v.facts.every((f) => f.length <= 150));
});

test('roundupEvent carries a per-day id and the top story link', () => {
  const stories = selectTopStories(
    [...withSource(FEED_A, 'Feed A'), ...withSource(FEED_B, 'Feed B')],
    { now: NOW }
  );
  const event = roundupEvent(stories, buildRoundupVerdict(stories, '13 Oct 2026'), NOW);
  assert.equal(event.event_id, 'evt_news_roundup_20261013');
  assert.equal(event.url, stories[0].link);
  assert.equal(event.sample, false);
  assert.equal(event.importance_level, 'HIGH');
});

test('fetchNewsRoundup: tolerates a dead feed, merges the rest', async () => {
  const routes = {
    'https://feed.a': { body: FEED_A },
    'https://feed.b': { body: FEED_B },
    'https://feed.c': { status: 503 },
  };
  const fetchImpl = async (url) => {
    const r = routes[url] ?? { status: 404 };
    return {
      ok: !r.status,
      status: r.status ?? 200,
      text: async () => r.body ?? '',
    };
  };
  const { event, verdict, stories, failedFeeds } = await fetchNewsRoundup({
    now: NOW,
    fetchImpl,
    logger: null,
    feeds: [
      { source: 'A', url: 'https://feed.a' },
      { source: 'B', url: 'https://feed.b' },
      { source: 'C', url: 'https://feed.c' },
    ],
  });
  assert.equal(stories.length, 3);
  assert.equal(verdict.facts.length, 3);
  assert.equal(event.event_id, 'evt_news_roundup_20261013');
  assert.equal(failedFeeds.length, 1);
  assert.ok(failedFeeds[0].startsWith('C: HTTP 503'));
});

test('fetchNewsRoundup: refuses to build an empty roundup', async () => {
  await assert.rejects(
    fetchNewsRoundup({
      now: NOW,
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
      logger: null,
      feeds: [{ source: 'A', url: 'https://feed.a' }],
    }),
    /no market news found/
  );
});
