/**
 * Read the stored git credential for github.com (never prints the token),
 * then query the GitHub REST API for repo secrets/variables *names* only.
 */
import { execFileSync } from 'node:child_process';

const OWNER = 'sachin5678';
const REPO = 'new-age-algos-market-intelligence';

function gitCredential() {
  const input = 'protocol=https\nhost=github.com\n\n';
  const out = execFileSync('git', ['credential', 'fill'], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  const kv = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}

const cred = gitCredential();
const user = cred.username ?? 'x-access-token';
const pass = cred.password;
if (!pass) {
  console.log('NO_CREDENTIAL');
  process.exit(0);
}
console.log(`credential: username=${user} password=<${pass.length} chars, hidden>`);

const base = 'https://api.github.com';
const hdrs = {
  authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'new-age-algos-setup',
  'x-github-api-version': '2022-11-28',
};

async function api(path, opts = {}) {
  const res = await fetch(`${base}${path}`, { ...opts, headers: { ...hdrs, ...(opts.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const repo = await api(`/repos/${OWNER}/${REPO}`);
console.log('repo access:', repo.status, repo.body?.full_name ?? repo.body?.message);

if (repo.status === 200) {
  const secrets = await api(`/repos/${OWNER}/${REPO}/actions/secrets`);
  console.log('secrets:', secrets.status, JSON.stringify((secrets.body?.secrets ?? []).map((s) => s.name)));

  const vars = await api(`/repos/${OWNER}/${REPO}/actions/variables`);
  console.log('variables:', vars.status, JSON.stringify((vars.body?.variables ?? []).map((v) => v.name)));

  const pk = await api(`/repos/${OWNER}/${REPO}/actions/secrets/public-key`);
  console.log('public-key:', pk.status, pk.body?.key_id ? `key_id=${pk.body.key_id}` : JSON.stringify(pk.body?.message));
}
