/**
 * Set a GitHub Actions repository secret (value taken from argv, never printed).
 * Uses the stored git credential — no token appears on stdout.
 *
 *   node scripts/gh-set-secret.mjs TELEGRAM_CHAT_ID -1003067155583
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const OWNER = 'sachin5678';
const REPO = 'new-age-algos-market-intelligence';

const [, , name, value] = process.argv;
if (!name || value === undefined) {
  console.error('usage: node scripts/gh-set-secret.mjs <NAME> <VALUE>');
  process.exit(2);
}

// libsodium lives in a temp dir so package.json is untouched.
const sodiumPath = pathToFileURL(
  path.join(os.tmpdir(), 'ghsodium', 'node_modules', 'libsodium-wrappers', 'dist', 'modules-esm', 'libsodium-wrappers.mjs')
).href;
const sodium = (await import(sodiumPath)).default;
await sodium.ready;

// Stored git credential (never echoed).
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

const pkRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets/public-key`, { headers: H });
const pkBody = await pkRes.json();
if (pkRes.status !== 200) {
  console.error('public-key fetch failed:', pkRes.status, pkBody?.message);
  process.exit(1);
}

const publicKey = sodium.from_base64(pkBody.key, sodium.base64_variants.ORIGINAL);
const encrypted = sodium.crypto_box_seal(sodium.from_string(value), publicKey);

const put = await fetch(
  `https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets/${encodeURIComponent(name)}`,
  {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({
      encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
      key_id: pkBody.key_id,
    }),
  }
);
console.log(`PUT ${name}: HTTP ${put.status} ${put.status === 204 ? 'OK (updated)' : JSON.stringify(await put.json())}`);
