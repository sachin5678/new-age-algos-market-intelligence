/**
 * Readability + pagination contract (PART 17/20/24).
 *
 * These are the invariants the redesign is judged on, checked mechanically
 * rather than by eye:
 *
 *   1. Nothing can produce an ellipsis — no line-clamp, no text-overflow, no
 *      truncation helper left in the component layer.
 *   2. Nothing renders below MIN_FONT, so a page can never become unreadable.
 *   3. `overflow:hidden` lives on the canvas, never on editorial text.
 *   4. Packed pages contain every section, and a section heading is never
 *      left alone at the foot of a page.
 *   5. Two outlets reporting one event become ONE card with supporting sources,
 *      and the card numbers stay contiguous.
 *   6. Windows are holiday-aware and events classify into the right bucket.
 *   7. Bucket quotas are honoured, and no two watch rows repeat a reason.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { baseCss, esc, MIN_FONT, VISUAL_DEFAULTS } from '../src/visual/theme.js';
import {
  buildVisualBriefing,
  buildAlertBriefing,
  classifyEvent,
  dedupeStories,
  EVENT_TAGS,
  renumber,
  selectStories,
  sessionWindow,
  sourceKey,
  stocksToWatch,
  usedSources,
  viewText,
} from '../src/visual/data.js';
import {
  buildPagePlan,
  packPages,
  renderAlertHtml,
  renderPreMarketHtml,
} from '../src/visual/templates.js';
import { sampleData, quietOvernightSample } from '../scripts/sample-visual-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = baseCss();
const fixture = sampleData();
// Friday 02 Oct 2026 is Gandhi Jayanti, an NSE holiday. Without it the previous
// session for Monday 05 Oct resolves to Friday, and every "yesterday" story in
// the fixture is filed into the wrong window — so the tests carry it explicitly.
const HOLIDAYS = ['2026-10-02'];

const briefFor = (type, f = fixture, opts = {}) =>
  buildVisualBriefing({
    type,
    snapshots: f.snapshots,
    events: f.events,
    now: f.now,
    holidays: HOLIDAYS,
    marketHours: {},
    sample: true,
    imageCap: 3,
    ...opts,
  });

// --------------------------------------------------------------- readability

test('CSS contains no line-clamp and no text-overflow: ellipsis', () => {
  assert.ok(!/-webkit-line-clamp/.test(css), 'line-clamp would clip editorial text');
  assert.ok(!/line-clamp/.test(css), 'line-clamp would clip editorial text');
  assert.ok(!/text-overflow\s*:\s*ellipsis/.test(css), 'ellipsis would hide the tail of a headline');
  assert.ok(!/text-overflow/.test(css), 'no text-overflow mode is permitted at all');
});

test('every CSS font-size is at least MIN_FONT', () => {
  const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 20, 'expected the theme to declare real type sizes');
  const tooSmall = sizes.filter((n) => n < MIN_FONT);
  assert.deepEqual(tooSmall, [], `font sizes below ${MIN_FONT}px: ${tooSmall.join(', ')}`);
  assert.ok(Math.min(...sizes) >= MIN_FONT);
});

test('overflow:hidden is confined to the canvas, never editorial text', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sel: m[1].trim(),
    body: m[2],
  }));
  const editorial = ['story', 'hl', 'sum', 'why', 'al-headline', 'al-sum', 'note-box', 'sec-h'];
  const offenders = [];
  for (const r of rules) {
    if (!/overflow\s*:\s*hidden/.test(r.body)) continue;
    for (const sel of r.sel.split(',').map((s) => s.trim())) {
      if (editorial.some((c) => sel.includes(`.${c}`))) offenders.push(sel);
    }
  }
  assert.deepEqual(offenders, [], `overflow:hidden on editorial containers: ${offenders.join(', ')}`);
});

test('the component layer has no truncation helper and no ellipsis literal', () => {
  const src = readFileSync(path.join(ROOT, 'src/visual/components.js'), 'utf8');
  assert.ok(!/function\s+truncate\s*\(/.test(src), 'truncate() must not exist anywhere');
  assert.ok(!/export\s+function\s+truncate/.test(src));
  // The only '…' permitted is inside a comment, if any.
  const literals = src
    .split('\n')
    .filter((l) => l.includes('…') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'));
  assert.deepEqual(literals, [], 'ellipsis literal found in components.js');
});

test('rendered pre-market page prints every summary in full', () => {
  const brief = briefFor('premarket');
  assert.ok(brief.developments.length > 0, 'fixture must produce developments');
  const html = renderPreMarketHtml(brief, { width: 1080, height: 1600 }, { page: 1, pageCount: 1 });
  for (const d of brief.developments) {
    assert.ok(
      html.includes(esc(d.summary)),
      `summary truncated or missing for "${d.headline.slice(0, 40)}…"`
    );
    assert.ok(html.includes(esc(d.headline)), `headline missing for "${d.headline.slice(0, 40)}"`);
    if (d.why_it_matters) assert.ok(html.includes(esc(d.why_it_matters)), 'why-it-matters missing');
  }
  assert.ok(!html.includes('…'), 'rendered page contains an ellipsis');
});

// ----------------------------------------------------------------- pagination

const H = { hdr: 40, c0: 60, h: 20, c1: 80 };

test('packPages moves a heading with its block instead of stranding it', () => {
  const sections = [
    { key: 'c0' },
    { key: 'h', keepWithNext: true },
    { key: 'c1' },
  ];
  // 130 would fit `h` alone after `c0` (40+60+9+20 = 129) — the lookahead must
  // refuse, because the block it introduces does not fit on the same page.
  const pages = packPages({
    header1Key: 'hdr',
    headerNKey: 'hdr',
    sections,
    heights: H,
    maxContent: 150,
    hardMaxPages: 6,
  });

  assert.equal(pages.length, 2);
  assert.deepEqual(
    pages[0].keys.map((k) => k.key),
    ['c0']
  );
  assert.deepEqual(
    pages[1].keys.map((k) => k.key),
    ['h', 'c1']
  );
  for (const p of pages) {
    const last = p.keys[p.keys.length - 1];
    assert.ok(!last?.keepWithNext, `page ends with a stranded heading (${last?.key})`);
  }
});

test('packPages never discards content', () => {
  const sections = [
    { key: 'c0' },
    { key: 'h', keepWithNext: true },
    { key: 'c1' },
    { key: 'c2' },
  ];
  const pages = packPages({
    header1Key: 'hdr',
    headerNKey: 'hdr',
    sections,
    heights: { ...H, c2: 70 },
    maxContent: 150,
    hardMaxPages: 6,
  });
  const placed = pages.flatMap((p) => p.keys.map((k) => k.key));
  assert.deepEqual([...placed].sort(), ['c0', 'c1', 'c2', 'h']);
});

test('packPages aborts rather than emitting an absurd image count', () => {
  const sections = [{ key: 'c0' }, { key: 'c1' }];
  assert.throws(
    () =>
      packPages({
        header1Key: 'hdr',
        headerNKey: 'hdr',
        sections,
        heights: { hdr: 40, c0: 100, c1: 100 },
        maxContent: 140,
        hardMaxPages: 1,
      }),
    /refusing to render/
  );
});

test('page geometry is the documented one', () => {
  assert.equal(VISUAL_DEFAULTS.width, 1080);
  assert.equal(VISUAL_DEFAULTS.height, 1600);
  assert.equal(VISUAL_DEFAULTS.minPageHeight, 1080);
  assert.equal(VISUAL_DEFAULTS.pageStep, 20);
  assert.equal(VISUAL_DEFAULTS.scale, 2);
  assert.ok(VISUAL_DEFAULTS.hardMaxPages > VISUAL_DEFAULTS.maxPages);
  assert.ok(VISUAL_DEFAULTS.alertMinHeight < VISUAL_DEFAULTS.alertHeight);
});

// --------------------------------------------------------------------- dedup

const sebiPrimary = {
  rank: 1,
  headline: 'SEBI caps intraday positions for prop desks from next month',
  source_name: 'Moneycontrol',
  source_url: 'https://moneycontrol.example/sebi-caps',
  slug: 'SEBI • SEBI',
};
const sebiSecond = {
  rank: 2,
  headline: 'SEBI tightens intraday position limits for prop desks',
  source_name: 'The Economic Times',
  source_url: 'https://et.example/sebi-limits',
  slug: 'SEBI • SEBI',
};
const unrelated = {
  rank: 3,
  headline: 'Nifty snaps three-day losing streak as banks lead the recovery',
  source_name: 'Economic Times',
  source_url: 'https://et.example/nifty',
  slug: '• MARKET',
};

test('one event, several outlets → one card plus supporting sources', () => {
  const out = dedupeStories([sebiPrimary, sebiSecond, unrelated]);
  assert.equal(out.length, 2, 'the two SEBI reports must merge');
  assert.equal(out[0].headline, sebiPrimary.headline);
  assert.deepEqual(
    out[0].supporting_sources.map((s) => s.name),
    ['The Economic Times']
  );
  assert.equal(out[1].headline, unrelated.headline);
  assert.deepEqual(out[1].supporting_sources, []);
});

test('cards are renumbered 01..N after a merge (no unexplained gap)', () => {
  const merged = renumber(dedupeStories([sebiPrimary, sebiSecond, unrelated]));
  assert.deepEqual(
    merged.map((b) => b.rank),
    [1, 2]
  );
});

test('the same URL is the same story regardless of wording', () => {
  const a = { ...sebiPrimary, slug: '' };
  const b = { ...sebiSecond, source_url: sebiPrimary.source_url, slug: '', headline: 'Totally different words' };
  assert.equal(dedupeStories([a, b]).length, 1);
});

test('unrelated stories are not merged just because they share a category', () => {
  const a = { ...sebiPrimary, slug: 'SEBI • SEBI' };
  const b = { ...unrelated, slug: 'SEBI • SEBI', headline: 'Sensex ends higher as IT stocks rally' };
  assert.equal(dedupeStories([a, b]).length, 2, 'low headline overlap must survive');
});

test('an outlet credited under two spellings is counted once', () => {
  assert.equal(sourceKey('The Economic Times'), sourceKey('Economic Times'));
  assert.notEqual(sourceKey('The Economic Times'), sourceKey('Business Standard'));
  const sources = usedSources({
    developments: [
      { source_name: 'The Economic Times', supporting_sources: [{ name: 'Economic Times' }] },
    ],
    snapshots: [],
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].name, 'The Economic Times');
});

// ------------------------------------------------------------ watch sections

test('no two stock rows repeat the same reason', () => {
  const rows = stocksToWatch(fixture.events, {
    type: 'premarket',
    now: fixture.now,
    holidays: HOLIDAYS,
    cap: 7,
  });
  assert.ok(rows.length > 1, 'fixture should produce several watch rows');
  const reasons = rows.map((r) => r.reason);
  assert.equal(new Set(reasons).size, reasons.length, `duplicate reasons: ${reasons.join(' | ')}`);
  const symbols = rows.flatMap((r) => r.symbols);
  assert.equal(new Set(symbols).size, symbols.length, 'a symbol must appear on only one row');
  for (const r of rows) assert.ok(r.symbols.length >= 1, 'grouped row carries no symbol');
});

// ------------------------------------------------------------------- windows

test('pre-market windows skip the weekend AND the Gandhi Jayanti holiday', () => {
  // Monday 05 Oct 2026, 08:30 IST → previous session is Thursday 01 Oct,
  // because Friday 02 Oct is a market holiday.
  const w = sessionWindow({ type: 'premarket', now: new Date('2026-10-05T03:00:00Z'), holidays: HOLIDAYS });
  assert.equal(w.sessionDate, '2026-10-01');
  assert.equal(w.type, 'premarket');
  assert.ok(w.overnightStart > w.sessionStart, 'overnight window starts at the previous close');
  assert.equal(w.label, 'YESTERDAY’S SESSION');

  // …and without the holiday it would (wrongly) resolve to Friday.
  const noHoliday = sessionWindow({ type: 'premarket', now: new Date('2026-10-05T03:00:00Z') });
  assert.equal(noHoliday.sessionDate, '2026-10-02');
});

test('events classify into the three report windows, not by raw freshness', () => {
  const w = sessionWindow({ type: 'premarket', now: new Date('2026-10-05T03:00:00Z'), holidays: HOLIDAYS });
  const at = (iso) => ({ published_at: iso, detected_at: iso, first_seen_at: iso });

  assert.equal(classifyEvent(at('2026-10-01T12:00:00Z'), w), 'overnight');
  assert.equal(classifyEvent(at('2026-10-01T06:00:00Z'), w), 'session');
  assert.equal(classifyEvent(at('2026-09-30T12:00:00Z'), w), 'earlier');
  assert.equal(classifyEvent({ ...at('2026-10-01T12:00:00Z'), detection_status: 'UPDATED' }, w), 'updated');

  const c = sessionWindow({ type: 'closing', now: new Date('2026-10-05T10:15:00Z'), holidays: HOLIDAYS });
  assert.equal(classifyEvent(at('2026-10-05T08:00:00Z'), c), 'closing_session');
  assert.equal(classifyEvent(at('2026-10-02T12:00:00Z'), c), 'overnight');
  assert.equal(classifyEvent(at('2026-09-30T12:00:00Z'), c), 'earlier');
});

test('every classified bucket has an editorial label and an emoji', () => {
  for (const [key, tag] of Object.entries(EVENT_TAGS)) {
    assert.ok(tag.label && tag.label.length > 2, `${key} has no label`);
    assert.ok(tag.emoji, `${key} has no emoji`);
  }
});

// -------------------------------------------------------------------- quotas

test('every window a pre-market report names is actually represented', () => {
  const { items } = selectStories(fixture.events, {
    type: 'premarket',
    now: fixture.now,
    holidays: HOLIDAYS,
    cap: 6,
  });
  const count = (b) => items.filter((i) => i.bucket === b).length;
  assert.ok(count('overnight') >= 1, 'a pre-market report must carry overnight stories');
  assert.ok(count('session') >= 1, 'a pre-market report must carry the previous session');
  assert.ok(items.length <= 6, 'cap is a hard ceiling on story count');
});

test('bucket quotas are applied before any rank-order backfill', () => {
  // cap === sum(quotas) means there is nothing left to backfill, so the counts
  // are exactly what the quota asked for. This is the mechanism that guarantees
  // a window is never crowded out by a burst of stories from another window.
  const { items } = selectStories(fixture.events, {
    type: 'premarket',
    now: fixture.now,
    holidays: HOLIDAYS,
    cap: 5,
    quotas: { overnight: 3, session: 2 },
  });
  const count = (b) => items.filter((i) => i.bucket === b).length;
  assert.equal(items.length, 5);
  assert.equal(count('overnight'), 3, 'overnight quota not honoured');
  assert.equal(count('session'), 2, 'session quota not honoured');
});

test('backfill fills unused slots but never exceeds the cap', () => {
  const base = { type: 'premarket', now: fixture.now, holidays: HOLIDAYS, cap: 4 };

  // The quota comes back empty (no UPDATED stories in the fixture) — backfill
  // must still fill the cap rather than publishing a half-empty report.
  const empty = selectStories(fixture.events, { ...base, quotas: { updated: 1 } });
  assert.equal(empty.items.length, 4, 'backfill must fill the cap when the quota is empty');

  // A quota that IS satisfiable is honoured first, and backfill tops it up to
  // the cap — never beyond it.
  const filled = selectStories(fixture.events, { ...base, quotas: { overnight: 3 } });
  assert.equal(filled.items.length, 4, 'cap is a hard ceiling');
  assert.ok(
    filled.items.filter((i) => i.bucket === 'overnight').length >= 3,
    'quota must be satisfied before any backfill'
  );
});

test('selection never shortens a story — it drops one instead', () => {
  const base = { type: 'premarket', now: fixture.now, holidays: HOLIDAYS };
  const cap3 = selectStories(fixture.events, { ...base, cap: 3 });
  const cap6 = selectStories(fixture.events, { ...base, cap: 6 });
  assert.ok(cap3.items.length <= 3);
  assert.ok(cap6.items.length > cap3.items.length, 'raising the cap must add stories, not stretch them');
  for (const it of cap6.items) assert.equal(typeof it.event.ai_summary, 'string');
});

// ---------------------------------------------------------------------- view

test('NEW AGE ALGOS VIEW uses the selected event\'s own takeaway', () => {
  const { items } = selectStories(fixture.events, {
    type: 'premarket',
    now: fixture.now,
    holidays: HOLIDAYS,
    cap: 3,
  });
  const preferred = items.map((i) => i.event);
  const view = viewText(fixture.events, preferred);
  assert.ok(view, 'fixture carries a trader_takeaway, so the view must not be empty');
  const withTakeaway = preferred.find((e) => e?.ai_verdict?.trader_takeaway);
  assert.equal(view, withTakeaway.ai_verdict.trader_takeaway);
});

test('a quiet overnight still yields a filled briefing (never an empty page)', () => {
  const quiet = quietOvernightSample();
  const brief = briefFor('premarket', quiet);
  assert.ok(brief.view, 'the quiet edge case must still carry a view');
  assert.ok(brief.developments.length > 0, 'previous-session stories still fill the report');
  assert.ok(brief.keep_an_eye.length > 0, 'the look-ahead agenda must be filled from measured data');
  assert.ok(brief.global?.length, 'global cues are measured data and always present');
  assert.ok(brief.stocks_to_watch.length > 0 || brief.sectors_to_watch.length > 0, 'watch sections must not vanish');
  assert.ok(brief.catalysts.length > 0, 'today\'s catalysts must be derived, not left blank');
  // The window must still be named, never the generic "no developments" notice.
  assert.equal(brief.windows.label, 'YESTERDAY’S SESSION');
});

// --------------------------------------------------------------------- alert

test('alert canvas is fitted to content, not pinned to a fixed square', () => {
  const source = fixture.events.find((e) => e.importance_level === 'HIGH') ?? fixture.events[0];
  const brief = buildAlertBriefing({
    event: source,
    verdict: source.ai_verdict ?? {},
    now: fixture.now,
    sample: true,
  });

  // Measuring pass: min-height lets the poster grow to its natural size.
  const probe = renderAlertHtml(brief, { width: 1080, height: 760, scale: 2, exact: false });
  assert.ok(probe.includes('width:540px;min-height:380px'), 'probe must be min-height, not fixed');

  // Final pass: pinned to the measured height so there is no empty band.
  const final = renderAlertHtml(brief, { width: 1080, height: 920, scale: 2 });
  assert.ok(final.includes('width:540px;height:460px'), 'final render must be pinned to the fitted height');
  assert.ok(final.includes('BREAKING MARKET ALERT'));
  assert.ok(!final.includes('…'), 'alert contains an ellipsis');
});

// --------------------------------------------------------------- plan sanity

test('buildPagePlan yields fragments the packer can measure', () => {
  const brief = briefFor('premarket');
  const plan = buildPagePlan(brief, { type: 'premarket', now: fixture.now });
  assert.ok(plan.sections.length > 0, 'plan must contain sections');
  for (const s of plan.sections) {
    assert.ok(s.key, 'every fragment needs a key so it can be measured');
    assert.ok(typeof s.html === 'string' && s.html.length > 0, `fragment ${s.key} has no HTML`);
  }
  const keys = plan.sections.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, `duplicate fragment keys: ${keys.join(', ')}`);
  assert.equal(EVENT_TAGS.overnight.emoji, '🌙');
});
