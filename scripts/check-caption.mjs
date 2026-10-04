import { loadConfig } from '../src/config.js';
import { buildVisualBriefing, buildAlertBriefing } from '../src/visual/data.js';
import { VisualDeliver } from '../src/visual/deliver.js';
import { sampleData } from './sample-visual-data.mjs';

const cfg = loadConfig();
const sample = sampleData();
const now = new Date();
const v = new VisualDeliver({ transport: null, env: {} });

for (const type of ['premarket', 'closing']) {
  const brief = buildVisualBriefing({
    type,
    snapshots: sample.snapshots,
    events: sample.events,
    now,
    holidays: cfg.holidays,
    marketHours: cfg.settings.marketHours,
    sample: false,
  });
  const cap = v.buildCaption(brief, type);
  console.log(`${type.padEnd(9)} | ${cap}`);
  console.log(`          len=${cap.length} multiline=${/\n/.test(cap)}`);
}

const alert = buildAlertBriefing({
  event: {
    event_id: 'x',
    headline: 'RBI hikes repo rate 25bps',
    category: 'RATES',
    impact: 'high',
    status_label: 'REPORTED',
    published_at: now.toISOString(),
  },
  verdict: null,
  now,
  sample: false,
});
const acap = v.buildAlertCaption(alert);
console.log(`alert    | ${acap}`);
console.log(`          len=${acap.length} multiline=${/\n/.test(acap)}`);
