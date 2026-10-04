/** Trigger a workflow_dispatch run and stream its status; prints log excerpt. */
import { execFileSync } from 'node:child_process';

const OWNER = 'sachin5678';
const REPO = 'new-age-algos-market-intelligence';

const out = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  windowsHide: true,
  timeout: 20000,
});
const kv = {};
for (const line of out.split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
}
const auth = `Basic ${Buffer.from(`${kv.username}:${kv.password}`).toString('base64')}`;
const H = {
  authorization: auth,
  accept: 'application/vnd.github+json',
  'user-agent': 'new-age-algos-setup',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
};

const wf = process.argv[2] ?? 'market-intelligence.yml';
const jobType = process.argv[3] ?? 'health-check';

// Dispatch
const d = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${wf}/dispatches`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ ref: 'main', inputs: { job_type: jobType, dry_run: false, no_ai: false } }),
});
console.log('dispatch:', d.status, d.status === 204 ? 'accepted' : JSON.stringify(await d.json()));
if (d.status !== 204) process.exit(1);

// Wait for the run to appear
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let run = null;
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  const r = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${wf}/runs?per_page=3`,
    { headers: H }
  );
  const b = await r.json();
  run = (b.workflow_runs ?? []).find((x) => x.event === 'workflow_dispatch' && x.status !== 'completed');
  if (run) break;
}
if (!run) {
  console.log('no pending run found');
  process.exit(1);
}
console.log('run:', run.id, run.html_url);

// Poll to completion
let final = null;
for (let i = 0; i < 60; i++) {
  await sleep(5000);
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${run.id}`, { headers: H });
  const b = await r.json();
  process.stdout.write(`  ${b.status}/${b.conclusion ?? '-'}\n`);
  if (b.status === 'completed') {
    final = b;
    break;
  }
}
console.log('conclusion:', final?.conclusion);

// Job logs
const j = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${run.id}/jobs`, { headers: H });
const jb = await j.json();
for (const job of jb.jobs ?? []) {
  console.log(`job ${job.name}: ${job.status}/${job.conclusion}`);
  for (const st of job.steps ?? []) console.log(`   step ${st.number} ${st.name}: ${st.conclusion}`);
}
console.log('LOGURL', `https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${run.id}/logs`);
