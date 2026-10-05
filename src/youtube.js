/**
 * YouTube upload — free Data API v3.
 *
 * Quota math: a videos.insert costs 1600 units of the FREE 10,000/day budget
 * → six uploads per day, we need two. thumbnails.set costs 50.
 *
 * Auth (one-time, local): scripts/youtube-auth.mjs runs the OAuth installed-
 * app flow against Google's loopback redirect and stores the refresh token in
 * `.secrets/` (gitignored). Every upload exchanges it for a short-lived
 * access token — no API keys, no paid tiers, nothing third-party.
 *
 * Duplicate protection: `state/youtube-uploads.json` maps a stable content key
 * (`event:<event_id>` / `recap:<YYYY-MM-DD>`) to the published video, so a
 * re-render, a retry, or a backfill never posts the same short twice.
 * Sample/demo shorts are NEVER uploaded (§27 — labelled test data stays local).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GOOGLE = 'https://www.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const MAX_TITLE = 100; // hard YouTube limit

export const defaultSecretsDir = () => process.env.SECRETS_DIR || path.join(os.homedir(), '.secrets');
export const defaultRegistryFile = (stateDir) => path.join(stateDir, 'youtube-uploads.json');

// ------------------------------------------------------------------ auth

/** Read a Google OAuth client from the Console-downloaded JSON (any shape). */
function readClientJson(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const src = raw.installed ?? raw.web ?? raw;
    if (src.client_id && src.client_secret) {
      return { clientId: src.client_id, clientSecret: src.client_secret };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Resolve credentials from (in order): env vars → .secrets/youtube-auth.json
 * (written by youtube-auth.mjs) → .secrets/youtube-client.json (Console
 * download, client half only — still needs a refresh token).
 * @returns {{clientId, clientSecret, refreshToken}|null}
 */
export function loadCredentials({ secretsDir = defaultSecretsDir(), env = process.env } = {}) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(secretsDir, 'youtube-auth.json'), 'utf8'));
  } catch {
    /* no auth yet */
  }
  const client = readClientJson(path.join(secretsDir, 'youtube-client.json'));
  const clientId = env.YOUTUBE_CLIENT_ID || saved?.clientId || client?.clientId || null;
  const clientSecret = env.YOUTUBE_CLIENT_SECRET || saved?.clientSecret || client?.clientSecret || null;
  const refreshToken = env.YOUTUBE_REFRESH_TOKEN || saved?.refreshToken || null;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/** Exchange the refresh token for a short-lived access token. */
export async function refreshAccessToken(
  { clientId, clientSecret, refreshToken },
  { fetchImpl = fetch, timeoutMs = 20_000 } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.error === 'invalid_grant' ? ' (refresh token revoked or expired — re-run scripts/youtube-auth.mjs)' : '';
      throw new Error(`token refresh failed: ${data.error_description || data.error || res.status}${reason}`);
    }
    return data.access_token;
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- upload

/** YouTube titles hard-fail above 100 chars — clip on a word boundary. */
export function safeTitle(title) {
  const t = String(title ?? '').trim();
  if (t.length <= MAX_TITLE) return t;
  const cut = t.slice(0, MAX_TITLE - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 60))}…`;
}

/** snippet + status payload for videos.insert. */
export function uploadMeta({ title, description = '', hashtags = [], privacy = 'public' } = {}) {
  const tagSet = [
    'shorts',
    'indian stock market',
    'stock market',
    'nifty 50',
    'nifty',
    'new age algos',
    ...(hashtags ?? []).map((h) => String(h).replace(/^#+/, '')),
  ].filter(Boolean);
  // YouTube rejects tag lists over 500 chars total.
  const tags = [];
  let tagChars = 0;
  for (const t of tagSet) {
    if (tagChars + t.length + 1 > 480) break;
    if (tags.includes(t)) continue;
    tags.push(t);
    tagChars += t.length + 1;
  }
  return {
    snippet: {
      title: safeTitle(title),
      description: String(description ?? '').slice(0, 4800),
      tags,
      categoryId: '25', // News & Politics
    },
    status: {
      privacyStatus: ['public', 'unlisted', 'private'].includes(privacy) ? privacy : 'public',
      selfDeclaredMadeForKids: false,
    },
  };
}

/**
 * multipart/related body (NOT form-data — Google's upload endpoint requires
 * multipart/related with a JSON part followed by the media part).
 */
export function buildMultipart({ metadata, video, boundary = '----------nnaUploadBoundary' } = {}) {
  const json = Buffer.from(JSON.stringify(metadata), 'utf8');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    'utf8'
  );
  const mid = Buffer.from(
    `\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, json, mid, Buffer.from(video), tail]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

async function googleError(res, what) {
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 300);
  try {
    const data = JSON.parse(text);
    message = data?.error?.message ?? message;
    const reason = data?.error?.errors?.[0]?.reason;
    if (reason) message = `${message} [${reason}]`;
    if (data?.error === 'invalid_grant') message = 'refresh token revoked — re-run scripts/youtube-auth.mjs';
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      message = 'daily YouTube quota used (1600 units/upload — max 6 uploads/day on the free tier)';
    }
  } catch {
    /* keep raw text */
  }
  throw new Error(`${what} failed (HTTP ${res.status}): ${message}`);
}

/** videos.insert (multipart). @returns {{videoId, url, title}} */
export async function uploadVideo({
  accessToken,
  meta,
  video,
  fetchImpl = fetch,
  notifySubscribers = true,
} = {}) {
  const { body, contentType } = buildMultipart({ metadata: meta, video });
  const url = `${GOOGLE}/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status&notifySubscribers=${notifySubscribers ? 'true' : 'false'}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType,
    },
    body,
  });
  if (!res.ok) await googleError(res, 'video upload');
  const data = await res.json();
  const videoId = data?.id;
  if (!videoId) throw new Error('video upload returned no id');
  return { videoId, url: `https://youtu.be/${videoId}`, title: data?.snippet?.title ?? meta.snippet.title };
}

/** thumbnails.set (raw media). Throws on failure — callers treat as soft. */
export async function setThumbnail({ accessToken, videoId, png, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `${GOOGLE}/upload/youtube/v3/thumbnails?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'image/png',
      },
      body: Buffer.from(png),
    }
  );
  if (!res.ok) await googleError(res, 'thumbnail');
  return true;
}

// ------------------------------------------------------------- registry

export function loadRegistry(registryFile) {
  try {
    const data = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    if (data && typeof data === 'object' && data.videos && typeof data.videos === 'object') {
      return data;
    }
  } catch {
    /* missing/corrupt → start clean */
  }
  return { videos: {} };
}

/** Atomic write (tmp + rename) so a crash can't corrupt the registry. */
export function saveRegistry(registryFile, registry) {
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  const tmp = `${registryFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tmp, registryFile);
}

export const isUploaded = (registryFile, key) => Boolean(key && loadRegistry(registryFile).videos[key]);

/** Stable dedup key for a short summary (old metas lack it — derive). */
export function uploadKeyFor({ uploadKey, eventId, type, runId } = {}) {
  if (uploadKey) return uploadKey;
  if (eventId) return `event:${eventId}`;
  if (type === 'recap') {
    const day = String(runId ?? '').slice(4, 14); // run-2026-10-05T… → 2026-10-05
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return `recap:${day}`;
  }
  return null;
}

function markUploaded(registryFile, key, info) {
  const registry = loadRegistry(registryFile);
  registry.videos[key] = info;
  saveRegistry(registryFile, registry);
}

// ------------------------------------------------------- high-level API

/**
 * Upload one finished short (summary + files on disk).
 *
 * @returns {{status: 'sample'|'no-auth'|'already'|'uploaded'|'error', url?, message?}}
 *          Never throws for expected conditions — the schedule logs and moves on.
 */
export async function uploadShort({
  summary,
  registryFile,
  secretsDir = defaultSecretsDir(),
  privacy = process.env.YOUTUBE_PRIVACY || 'public',
  fetchImpl = fetch,
} = {}) {
  const key = uploadKeyFor(summary);
  if (summary.sample || summary.eventId === 'evt_demo_short') {
    return { status: 'sample', message: 'sample/demo short — never uploaded' };
  }
  if (!key) return { status: 'error', message: 'no upload key (unknown content)' };
  if (isUploaded(registryFile, key)) {
    const prev = loadRegistry(registryFile).videos[key];
    return { status: 'already', url: prev.url, message: 'already uploaded' };
  }

  const creds = loadCredentials({ secretsDir });
  if (!creds) {
    return {
      status: 'no-auth',
      message: 'YouTube not authorised yet — run: node scripts/youtube-auth.mjs (one-time Google consent)',
    };
  }

  const video = fs.readFileSync(summary.video);
  const meta = uploadMeta({
    title: summary.title,
    description: summary.description,
    hashtags: summary.hashtags,
    privacy,
  });

  let token;
  try {
    token = await refreshAccessToken(creds, { fetchImpl });
  } catch (err) {
    return { status: 'error', message: err.message };
  }

  let uploaded;
  try {
    uploaded = await uploadVideo({ accessToken: token, meta, video, fetchImpl });
  } catch (err) {
    return { status: 'error', message: err.message };
  }

  // Thumbnail: hook scene PNG, 2MB hard limit — soft-fail, video is live either way.
  let thumb = 'none';
  try {
    const pngPath = summary.scenes?.find((s) => s.png && fs.existsSync(s.png))?.png;
    if (pngPath && fs.statSync(pngPath).size <= 2 * 1024 * 1024) {
      await setThumbnail({ accessToken: token, videoId: uploaded.videoId, png: fs.readFileSync(pngPath), fetchImpl });
      thumb = 'ok';
    } else if (pngPath) {
      thumb = 'skipped (>2MB)';
    }
  } catch (err) {
    thumb = `failed (${err.message})`;
  }

  const info = {
    videoId: uploaded.videoId,
    url: uploaded.url,
    title: uploaded.title,
    uploadedAt: new Date().toISOString(),
    thumb,
  };
  markUploaded(registryFile, key, info);
  return { status: 'uploaded', ...info };
}

/**
 * Backfill: upload every finished run in artifacts/shorts that the registry
 * has not seen yet (samples excluded). @returns {Array} per-run results.
 */
export async function uploadAllUnsent({
  runsRoot,
  registryFile,
  secretsDir = defaultSecretsDir(),
  privacy = process.env.YOUTUBE_PRIVACY || 'public',
  fetchImpl = fetch,
} = {}) {
  const results = [];
  let runDirs = [];
  try {
    runDirs = fs
      .readdirSync(runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('run-'))
      .map((d) => d.name)
      .sort();
  } catch {
    return results;
  }
  for (const name of runDirs) {
    const dir = path.join(runsRoot, name);
    const metaFile = path.join(dir, 'meta.json');
    let summary = null;
    try {
      summary = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      continue;
    }
    const video = path.join(dir, 'short.mp4');
    if (!fs.existsSync(video)) continue;
    summary.video = video;
    summary.dir = summary.dir ?? dir;
    // Old metas may hold absolute paths from another machine — rebase locally.
    if (Array.isArray(summary.scenes)) {
      for (const s of summary.scenes) {
        if (s.png && !fs.existsSync(s.png)) {
          const local = path.join(dir, path.basename(s.png));
          if (fs.existsSync(local)) s.png = local;
        }
      }
    }
    const key = uploadKeyFor({ ...summary, runId: summary.runId ?? name });
    if (summary.sample !== true && summary.eventId === 'evt_demo_short') summary.sample = true;
    const res = await uploadShort({ summary: { ...summary, uploadKey: key }, registryFile, secretsDir, privacy, fetchImpl });
    results.push({ run: name, key, ...res });
  }
  return results;
}
