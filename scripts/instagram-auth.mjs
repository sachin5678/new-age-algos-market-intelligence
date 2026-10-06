#!/usr/bin/env node
/**
 * One-time Instagram token setup — Instagram API with Instagram Login
 * (official, free, NO Facebook Page exists anywhere in this flow).
 *
 *   node scripts/instagram-auth.mjs <IG_TOKEN> [--app-secret <secret>]
 *
 * <IG_TOKEN> is a graph.instagram.com user token (short- or long-lived),
 * e.g. generated in the Graph API Explorer with permissions
 * instagram_business_basic + instagram_business_content_publish.
 *
 * Steps:
 *   1. validate the token against GET graph.instagram.com/<ver>/me — a
 *      graph.facebook.com / Page token fails here with a clear message
 *   2. try refresh (grant_type=ig_refresh_token): works when the token is
 *      already the 60-day variant and restarts its 60-day clock → done
 *   3. otherwise exchange it (grant_type=ig_exchange_token + app secret):
 *      short-lived → 60-day token
 *   4. if neither works, exit 1 — never save a token we cannot keep alive
 *   5. write ~/.secrets/instagram-auth.json {accessToken, userId, username,
 *      createdAt} (gitignored) and print the three repo secrets:
 *      IG_ACCESS_TOKEN, IG_USER_ID, IG_TOKEN_CREATED
 *
 * App secret: --app-secret flag, META_APP_SECRET env, or
 * ~/.secrets/meta-app.json {"appSecret": "..."} (app Settings → Basic).
 *
 * Longevity: the pipeline auto-refreshes the token once it is ≥45 days old
 * (src/instagram.js ensureFreshToken) — this script only bootstraps day 0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GRAPH = 'https://graph.instagram.com/v26.0';

function parseArgs(argv) {
  const out = { positionals: [], appSecret: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app-secret') {
      out.appSecret = argv[i + 1];
      i += 1;
    } else if (!argv[i].startsWith('--')) {
      out.positionals.push(argv[i]);
    }
  }
  return out;
}

async function getJson(url, what) {
  const res = await fetch(url);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok || body?.error) {
    const err = new Error(`${what} failed (${res.status}): ${body?.error?.message ?? text.slice(0, 300)}`);
    err.meta = body?.error;
    throw err;
  }
  return body;
}

const mask = (t) => `${String(t).slice(0, 10)}…(${String(t).length} chars)`;

const { positionals, appSecret: appSecretArg } = parseArgs(process.argv.slice(2));
const secretsDir = process.env.SECRETS_DIR || path.join(os.homedir(), '.secrets');
const token = positionals[0];

const metaFile = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(secretsDir, 'meta-app.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const appSecret = appSecretArg || process.env.META_APP_SECRET || metaFile.appSecret;

if (!token) {
  console.error('Usage: node scripts/instagram-auth.mjs <IG_TOKEN> [--app-secret <secret>]');
  console.error('  IG_TOKEN  graph.instagram.com user token (Graph API Explorer:');
  console.error('            permissions instagram_business_basic + instagram_business_content_publish)');
  console.error('  --app-secret  needed only to convert a SHORT-lived token (app Settings → Basic)');
  process.exit(1);
}

try {
  // 1. validate — this is also the guard that rejects graph.facebook.com tokens
  const me = await getJson(`${GRAPH}/me?fields=id,username&access_token=${encodeURIComponent(token)}`, 'token validation');
  console.log(`✓ token valid for @${me.username} (${me.id})`);

  // 2. refresh first: works on the 60-day variant and restarts the clock
  let finalToken = null;
  let strategy = null;
  try {
    const refreshed = await getJson(
      `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
      'refresh (60-day restart)'
    );
    finalToken = refreshed.access_token;
    strategy = 'refresh';
    console.log(`✓ refreshed → new 60-day token ${mask(finalToken)}`);
  } catch (err) {
    console.log(`· refresh not applicable (${err.message.split('(')[1]?.split(')')[0] ?? 'error'}) — trying exchange`);
  }

  // 3. exchange: short-lived → 60-day (needs the app secret)
  if (!finalToken) {
    if (!appSecret) {
      throw new Error(
        'token could not be refreshed and no app secret was provided — if this token is SHORT-lived ' +
          '(1 h), re-run with --app-secret <App Secret from app Settings → Basic> to convert it to the 60-day variant'
      );
    }
    const exchanged = await getJson(
      `${GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(appSecret)}` +
        `&access_token=${encodeURIComponent(token)}`,
      'exchange (short → 60-day)'
    );
    finalToken = exchanged.access_token;
    strategy = 'exchange';
    console.log(`✓ exchanged → 60-day token ${mask(finalToken)}`);
  }

  // 4. persist (gitignored)
  const createdAt = new Date().toISOString();
  fs.mkdirSync(secretsDir, { recursive: true });
  const authFile = path.join(secretsDir, 'instagram-auth.json');
  fs.writeFileSync(
    authFile,
    `${JSON.stringify(
      { accessToken: finalToken, userId: me.id, username: me.username, createdAt, strategy, savedAt: createdAt },
      null,
      2
    )}\n`
  );
  console.log(`✓ auth saved → ${authFile} (createdAt ${createdAt.slice(0, 10)})`);
  console.log('');
  console.log('Next: add repo secrets (GitHub → Settings → Secrets and variables → Actions):');
  console.log(`  IG_ACCESS_TOKEN   = ${mask(finalToken)}`);
  console.log(`  IG_USER_ID        = ${me.id}`);
  console.log(`  IG_TOKEN_CREATED  = ${createdAt.slice(0, 10)}`);
  console.log('');
  console.log('The pipeline auto-refreshes this token from day 45 onwards — no manual renewal.');
} catch (err) {
  console.error(`INSTAGRAM AUTH FAILED: ${err.message}`);
  process.exit(1);
}
