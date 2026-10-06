#!/usr/bin/env node
/**
 * One-time Instagram token exchange (official, free Meta Graph API).
 *
 *   node scripts/instagram-auth.mjs <SHORT_TOKEN> <APP_ID> <APP_SECRET> [--page-id <id>]
 *
 * Steps performed:
 *   1. exchange the Graph-API-Explorer short-lived token for a long-lived
 *      USER token (60 days) via grant_type=fb_exchange_token
 *   2. list the Facebook Pages this user manages and swap for the PAGE token
 *      (a page token minted from a long-lived user token does not expire —
 *      no daily renewal dance for the scheduled uploads)
 *   3. read the page's linked instagram_business_account {id, username}
 *   4. write ~/.secrets/instagram-auth.json (gitignored)
 *
 * APP_ID / APP_SECRET come from the developer app → Settings → Basic (they
 * can also be supplied via META_APP_ID / META_APP_SECRET env or
 * ~/.secrets/meta-app.json {appId, appSecret}).
 *
 * Afterwards: add repo secrets IG_ACCESS_TOKEN + IG_USER_ID (README §
 * "Auto-upload to Instagram Reels").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GRAPH = 'https://graph.facebook.com/v26.0';

function parseArgs(argv) {
  const out = { positionals: [], pageId: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--page-id') {
      out.pageId = argv[i + 1];
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
    throw new Error(`${what} failed (${res.status}): ${body?.error?.message ?? text.slice(0, 300)}`);
  }
  return body;
}

const mask = (t) => `${String(t).slice(0, 12)}…(${String(t).length} chars)`;

const { positionals, pageId } = parseArgs(process.argv.slice(2));
const secretsDir = process.env.SECRETS_DIR || path.join(os.homedir(), '.secrets');

let [shortToken, appId, appSecret] = positionals;
const metaFile = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(secretsDir, 'meta-app.json'), 'utf8'));
  } catch {
    return {};
  }
})();
appId = appId || process.env.META_APP_ID || metaFile.appId;
appSecret = appSecret || process.env.META_APP_SECRET || metaFile.appSecret;

if (!shortToken || !appId || !appSecret) {
  console.error('Usage: node scripts/instagram-auth.mjs <SHORT_TOKEN> <APP_ID> <APP_SECRET> [--page-id <id>]');
  console.error('  SHORT_TOKEN  from Graph API Explorer (developers.facebook.com/tools/explorer)');
  console.error('  APP_ID/SECRET  app Settings → Basic (or META_APP_ID/META_APP_SECRET env,');
  console.error('                 or ~/.secrets/meta-app.json {"appId":"…","appSecret":"…"})');
  process.exit(1);
}

try {
  // 1. short-lived → long-lived user token (60 days)
  const longUser = await getJson(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&fb_exchange_token=${encodeURIComponent(shortToken)}`,
    'token exchange'
  );
  console.log(`✓ long-lived user token: ${mask(longUser.access_token)}`);

  // 2. pages the user manages → page token
  const pages = await getJson(
    `${GRAPH}/me/accounts?fields=id,name,access_token&limit=50&access_token=${encodeURIComponent(longUser.access_token)}`,
    'list pages'
  );
  const candidates = pageId ? pages.data.filter((p) => p.id === pageId) : pages.data;
  if (!candidates.length) {
    throw new Error(
      pageId
        ? `page ${pageId} not found on this user (check --page-id)`
        : 'no Facebook Pages found — create one and link it to the Instagram account first (README step 2)'
    );
  }

  // 3. first page whose instagram_business_account is linked
  let chosen = null;
  for (const page of candidates) {
    const ig = await getJson(
      `${GRAPH}/${page.id}?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(page.access_token)}`,
      `page ${page.name} → instagram link`
    ).catch(() => null);
    if (ig?.instagram_business_account?.id) {
      chosen = { page, ig: ig.instagram_business_account };
      break;
    }
  }
  if (!chosen) {
    throw new Error(
      'no linked Instagram professional account found on your page(s) — link it: ' +
        'IG → Settings → Sharing to other apps → Facebook, or page Settings → Linked accounts → Instagram'
    );
  }

  // 4. persist (gitignored)
  fs.mkdirSync(secretsDir, { recursive: true });
  const authFile = path.join(secretsDir, 'instagram-auth.json');
  const payload = {
    accessToken: chosen.page.access_token, // page token: effectively non-expiring
    userId: chosen.ig.id,
    username: chosen.ig.username,
    pageId: chosen.page.id,
    pageName: chosen.page.name,
    tokenType: 'page',
    exchangedAt: new Date().toISOString(),
  };
  fs.writeFileSync(authFile, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`✓ page: ${chosen.page.name} (${chosen.page.id})`);
  console.log(`✓ instagram: @${chosen.ig.username} (${chosen.ig.id})`);
  console.log(`✓ auth saved → ${authFile}`);
  console.log('');
  console.log('Next: add repo secrets (GitHub → Settings → Secrets and variables → Actions):');
  console.log(`  IG_ACCESS_TOKEN = ${mask(payload.accessToken)}`);
  console.log(`  IG_USER_ID      = ${payload.userId}`);
} catch (err) {
  console.error(`INSTAGRAM AUTH FAILED: ${err.message}`);
  process.exit(1);
}
