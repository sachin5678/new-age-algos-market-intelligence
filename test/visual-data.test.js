import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  marketPulse,
  moversFromSnapshots,
  sectorPerformance,
} from '../src/visual/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Snapshot exactly as GlobalMarketCollector emits it. */
const snap = (name, value, pct_change, source = 'yfinance-native') => ({
  kind: 'snapshot',
  name,
  value,
  change: +(value * (pct_change / 100)).toFixed(2),
  pct_change,
  asof: '2026-10-05T13:30:00+05:30',
  source,
  extras: {},
});

// ---------------------------------------------------------------- market pulse

test('marketPulse resolves the three Indian indices the briefing prints', () => {
  const snaps = [
    snap('NIFTY 50', 22543.8, 0.54),
    snap('BANK NIFTY', 54812.9, 0.67),
    snap('SENSEX', 72072.14, 0.23),
    snap('Gift Nifty', 257.51, 0.39),
  ];
  const pulse = marketPulse(snaps);

  assert.equal(pulse.nifty.name, 'NIFTY 50');
  assert.equal(pulse.nifty.value, 22543.8);
  assert.equal(pulse.nifty.pct_change, 0.54);

  assert.equal(pulse.banknifty.name, 'BANK NIFTY');
  assert.equal(pulse.banknifty.value, 54812.9);

  assert.equal(pulse.sensex.name, 'SENSEX');
  assert.equal(pulse.sensex.value, 72072.14);
});

test('marketPulse returns nulls when the collector yields nothing (renders N/A, never a made-up number)', () => {
  const pulse = marketPulse([]);
  assert.equal(pulse.nifty, null);
  assert.equal(pulse.banknifty, null);
  assert.equal(pulse.sensex, null);
});

test('Gift Nifty alone does not satisfy the NIFTY 50 row', () => {
  // Regression guard: only "Gift Nifty" was sourced before, and its name
  // fails the /^nifty(\s*50)?$/ pattern, so the index row stayed empty.
  const pulse = marketPulse([snap('Gift Nifty', 257.51, 0.39)]);
  assert.equal(pulse.nifty, null, 'Gift Nifty is an ETF, not the NIFTY 50 index');
});

// ---------------------------------------------------------------------- movers

test('moversFromSnapshots keeps indices out of the top gainers/losers list', () => {
  const snaps = [
    snap('NIFTY 50', 22543.8, 0.54),
    snap('BANK NIFTY', 54812.9, 0.67), // excluded: the old regex missed it
    snap('SENSEX', 72072.14, 0.23),
    snap('RELIANCE', 2980.4, 1.85),
    snap('TCS', 3410.2, -1.12),
    snap('INFY', 1512.6, 2.4),
  ];
  const { gainers, losers } = moversFromSnapshots(snaps);

  assert.deepEqual(
    gainers.map((g) => g.name),
    ['INFY', 'RELIANCE']
  );
  assert.deepEqual(
    losers.map((l) => l.name),
    ['TCS']
  );
  for (const row of [...gainers, ...losers]) {
    assert.doesNotMatch(row.name, /nifty|sensex/i, 'index rows must not appear as stock movers');
  }
});

// ------------------------------------------------------------ sector ranking

test('sectorPerformance ranks real sectors but drops NIFTY 50 and BANK NIFTY', () => {
  const snaps = [
    snap('NIFTY 50', 22543.8, 0.54),
    snap('BANK NIFTY', 54812.9, 0.67),
    snap('NIFTY AUTO', 26110.4, 2.11),
    snap('NIFTY IT', 41230.9, -1.24),
    snap('NIFTY PHARMA', 19840.2, 0.88),
  ];
  const rows = sectorPerformance(snaps);

  assert.deepEqual(
    rows.map((r) => r.name),
    ['AUTO', 'PHARMA', 'IT']
  );
  assert.equal(rows[0].pct_change, 2.11);
});

// -------------------------------------------------- the yfinance symbol source

test('the embedded yfinance map still requests every index the pulse needs', () => {
  // The NSE HTTP API is unreachable from CI (404), so these symbols are the
  // only reason the index rows are populated. If one disappears the briefing
  // silently regresses to N/A, which is exactly how this shipped broken once.
  const src = readFileSync(path.join(ROOT, 'src', 'providers', 'nseCollector.js'), 'utf8');
  const map = src.match(/symbols = \{[\s\S]*?\n\}/);
  assert.ok(map, 'expected an embedded symbols map');
  for (const sym of ['^NSEI', '^NSEBANK', '^BSESN']) {
    assert.ok(map[0].includes(sym), `symbols map must request ${sym}`);
  }
});
