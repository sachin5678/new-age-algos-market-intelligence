/** Check credential scopes + workflow availability (no token printed). */
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
const H = { authorization: auth, accept: 'application/vnd.github+json', 'user-agent': 'setup', 'x-github-api-version': '2022-11-28' };

const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers: H });
console.log('x-oauth-scopes:', r.headers.get('x-oauth-scopes') ?? '(none)');
console.log('x-ratelimit-remaining:', r.headers.get('x-ratelimit-remaining'));

const w = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows`, { headers: H });
const wb = await r.json().catch(() => null);
const wbody = await w.json().catch(() => null);
console.log('workflows:', w.status, JSON.stringify((wbody?.workflows ?? []).map((x) => `${x.name} (${x.state}) => ${x.path}`)));

const runs = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs?per_page=3`, { headers: H });
const rbody = await runs.json().catch(() => null);
console.log('recent runs:');
for (const run of (rbody?.workflow_runs ?? []).slice(0, 3)) {
  console.log(`  ${run.id} ${run.name} ${run.event} ${run.status}/${run.conclusion ?? '-'} ${run.created_at}`);
}
