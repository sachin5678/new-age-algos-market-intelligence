#!/usr/bin/env node
/**
 * One-time YouTube OAuth consent (free, local, ~2 minutes).
 *
 *   1. Create the OAuth client once in Google Cloud (steps printed below),
 *   2. save the Console JSON as .secrets/youtube-client.json (or set
 *      YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET),
 *   3. run:  node scripts/youtube-auth.mjs
 *   4. approve in the browser — the refresh token is stored in
 *      .secrets/youtube-auth.json (gitignored) and every future upload uses it.
 *
 * Google's loopback redirect lets a Desktop-app client receive the code on
 * http://localhost:<ephemeral-port> — no server, no callback URL registration.
 * If the browser cannot open, paste the redirect URL back into this terminal.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const secretsDir = process.env.SECRETS_DIR || path.join(os.homedir(), '.secrets');

const CLIENT_STEPS = `
Google Cloud setup (one-time, free — ~3 minutes):

  1. Open  https://console.cloud.google.com/  and create (or pick) a project
  2. APIs & Services → Library → search "YouTube Data API v3" → Enable
  3. APIs & Services → OAuth consent screen:
       User type: External  →  Create
       App name: New Age Algos   (any name)
       User support email / developer email: your Gmail
       Scopes: add  .../auth/youtube.upload
       Test users: add YOUR Gmail address
       ⚠️  Then click PUBLISH APP  (keeps the refresh token valid forever —
           in "Testing" mode Google expires it after 7 days)
  4. APIs & Services → Credentials → Create Credentials → OAuth client ID
       Application type: Desktop app  →  Create  →  Download JSON
  5. Save the downloaded file as:  ${path.join(secretsDir, 'youtube-client.json')}

  (Alternatively export YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET.)
`;

function readClientPair() {
  if (process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) {
    return {
      clientId: process.env.YOUTUBE_CLIENT_ID,
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(secretsDir, 'youtube-client.json'), 'utf8'));
    const src = raw.installed ?? raw.web ?? raw;
    if (src.client_id && src.client_secret) {
      return { clientId: src.client_id, clientSecret: src.client_secret };
    }
  } catch {
    /* not found */
  }
  return null;
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    throw new Error(
      `code exchange failed: ${data.error_description || data.error || res.status}` +
        (data.error === 'redirect_uri_mismatch'
          ? ' — make sure the OAuth client is type "Desktop app"'
          : '')
    );
  }
  return data;
}

async function verifyRefreshToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`token verification failed: ${data.error_description || data.error || res.status}`);
  }
  return true;
}

function openBrowser(url) {
  // Start-Process takes the URL as a literal argument (no cmd.exe &-splitting).
  return import('node:child_process')
    .then(({ spawn }) =>
      spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], {
        stdio: 'ignore',
        detached: true,
      }).unref()
    )
    .catch(() => null);
}

async function main() {
  const client = readClientPair();
  if (!client) {
    console.log(CLIENT_STEPS);
    console.log('Client id/secret not found yet. Re-run this script after step 5.\n');
    return 1;
  }

  // --- loopback server (ephemeral port; Desktop apps may use any localhost port)
  let resolveCode;
  const codePromise = new Promise((resolve) => {
    resolveCode = resolve;
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<h3 style="font-family:sans-serif">New Age Algos → YouTube</h3>' +
        '<p style="font-family:sans-serif">' +
        (code ? 'Authorised ✅ You can close this tab and return to the terminal.' : `Problem: ${err ?? 'no code'}`) +
        '</p>'
    );
    if (code || err) resolveCode({ code, err });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;

  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPE,
    }).toString();

  console.log('\nAuthorising YouTube uploads (one-time)...\n');
  console.log(`  ${authUrl}\n`);
  await openBrowser(authUrl);

  // Browser callback OR paste-the-redirect-URL fallback (whichever comes first).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pastePromise = new Promise((resolve) => {
    rl.question('If the browser did not open: approve there, then paste the full redirect URL here and press Enter\n> ', (line) => {
      const text = String(line).trim();
      if (!text) return resolve({});
      try {
        const u = new URL(text);
        resolve({ code: u.searchParams.get('code'), err: u.searchParams.get('error') });
      } catch {
        resolve({ code: text.replace(/^.*code=/, '').split('&')[0] });
      }
    });
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ err: 'timeout (5 min)' }), 5 * 60_000));

  const result = await Promise.race([codePromise, pastePromise, timeout]);
  rl.close();
  server.close();

  if (result.err || !result.code) {
    console.error(`\n✗ No authorisation code (${result.err ?? 'nothing received'}). Run the script again.`);
    return 1;
  }

  const tokens = await exchangeCode({ ...client, code: result.code, redirectUri });
  await verifyRefreshToken({ ...client, refreshToken: tokens.refresh_token });

  fs.mkdirSync(secretsDir, { recursive: true });
  const authFile = path.join(secretsDir, 'youtube-auth.json');
  fs.writeFileSync(
    authFile,
    JSON.stringify(
      {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: tokens.refresh_token,
        scope: SCOPE,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`\n✓ YouTube uploads authorised — token saved to ${authFile}`);
  console.log('  Next: node scripts/make-short.mjs --upload-all   (publish any pending shorts)');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  });
