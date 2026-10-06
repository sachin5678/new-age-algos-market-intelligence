/**
 * Instagram Reels publisher — official Instagram Graph API (free).
 *
 * Why the official API (vs instagrapi-style scrapers): Meta's Content
 * Publishing API is free, stable, and does not risk a shadow-ban of the
 * channel account. Quota is 100 API-published posts / rolling 24 h — the
 * schedule needs two (story + recap), so headroom is ~50x.
 *
 * Endpoints (graph.instagram.com — Instagram API with Instagram Login,
 * so NO Facebook Page exists anywhere in this integration):
 *   POST /<ig-user>/media                          create a REELS container
 *   GET  /<container>?fields=status_code           wait for FINISHED
 *   POST /<ig-user>/media_publish                  publish the container
 *   GET  /<media>?fields=permalink                 grab the share URL
 *
 * Two quirks worth knowing:
 *   1. Meta fetches the video itself from a PUBLIC url — our MP4s are
 *      local, so we push them to a free temp host first (tmpfiles.org,
 *      then uguu.se, then catbox.moe as last resort). The host TTL only
 *      has to outlive the container fetch, which happens seconds after
 *      container creation.
 *   2. Credentials arrive via env (IG_ACCESS_TOKEN + IG_USER_ID) from
 *      GitHub secrets — the same one-time token exchange pattern as
 *      YouTube (scripts/instagram-auth.mjs).
 *
 * Dedup reuses state/youtube-uploads.json with an `insta:` key prefix so
 * the workflow's cache path list — and therefore its cache version —
 * never changes: adding a brand-new state file would cold-start the cache
 * chain and risk re-uploading old videos.
 *
 * Never throws for expected conditions: returns {status, …} like
 * uploadShort() does in src/youtube.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUploaded, loadRegistry, saveRegistry, uploadKeyFor } from './youtube.js';

const GRAPH = 'https://graph.instagram.com/v26.0';
const REFRESH_AFTER_MS = 45 * 24 * 60 * 60 * 1000; // refresh at day 45 of the 60-day token life
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
export const CAPTION_MAX = 2_200; // Instagram hard limit

export const defaultIgSecretsDir = () => process.env.SECRETS_DIR || path.join(os.homedir(), '.secrets');

/**
 * Credentials for the Instagram Login API (no Page involved anywhere).
 * Candidates — newest `createdAt` wins, so a token refreshed on an earlier
 * run (registry `igAuth`, rides the existing workflow cache) always beats
 * the original env secret:
 *   1. registry.igAuth — written by ensureFreshToken() after a refresh
 *   2. env             — IG_ACCESS_TOKEN / IG_USER_ID / IG_TOKEN_CREATED
 *   3. local auth file — ~/.secrets/instagram-auth.json (auth script)
 */
export function loadIgCredentials({ env = process.env, secretsDir = defaultIgSecretsDir(), registryFile } = {}) {
  const candidates = [];
  const push = (src, accessToken, userId, createdAt) => {
    const tok = String(accessToken ?? '').trim();
    const uid = String(userId ?? '').trim();
    if (!tok || !uid) return;
    const t = Date.parse(createdAt ?? '');
    candidates.push({
      accessToken: tok,
      userId: uid,
      createdAt: createdAt ?? null,
      src,
      t: Number.isFinite(t) ? t : 0,
    });
  };
  if (registryFile) {
    const ig = loadRegistry(registryFile).igAuth;
    push('registry', ig?.accessToken, ig?.userId, ig?.createdAt);
  }
  push('env', env.IG_ACCESS_TOKEN, env.IG_USER_ID, env.IG_TOKEN_CREATED);
  try {
    const file = JSON.parse(fs.readFileSync(path.join(secretsDir, 'instagram-auth.json'), 'utf8'));
    push('file', file?.accessToken, file?.userId, file?.createdAt);
  } catch {
    /* no local auth file yet — treated as unconfigured */
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.t - a.t); // unknown createdAt (t = 0) sorts last
  return candidates[0];
}

/** Dedup key: same event/date as YouTube, prefixed so both registries coexist. */
export function igKeyFor(summary) {
  const base = uploadKeyFor(summary ?? {});
  return base ? `insta:${base}` : null;
}

/** Caption = title + hashtags (deduped) clipped on a word boundary to 2200. */
export function buildCaption({ title = '', hashtags = [] } = {}) {
  let caption = String(title).trim();
  for (const raw of hashtags ?? []) {
    const tag = String(raw).startsWith('#') ? String(raw) : `#${String(raw).replace(/^#/, '')}`;
    if (!tag || caption.toLowerCase().includes(tag.toLowerCase())) continue;
    caption = `${caption} ${tag}`;
  }
  if (caption.length <= CAPTION_MAX) return caption;
  const cut = caption.slice(0, CAPTION_MAX);
  const sp = cut.lastIndexOf(' ');
  return (sp > 200 ? cut.slice(0, sp) : cut).trimEnd();
}

/**
 * Push the MP4 to a free temp host so Meta can fetch it.
 * Primary: tmpfiles.org (60 min TTL) — fallback: 0x0.st (age-based TTL).
 * @returns {Promise<{url: string, host: string}>}
 */
export async function hostVideo(bytes, filename, fetchImpl = fetch) {
  const attempts = [
    {
      name: 'tmpfiles.org', // 60 min TTL — ideal: only has to outlive Meta's fetch
      async run() {
        const form = new FormData();
        form.append('file', new Blob([bytes]), filename);
        const res = await fetchImpl('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = JSON.parse(await res.text());
        const page = json?.data?.url;
        if (!page) throw new Error(`unexpected response: ${JSON.stringify(json).slice(0, 160)}`);
        // page link → direct download link
        return page.replace('://tmpfiles.org/', '://tmpfiles.org/dl/');
      },
    },
    {
      name: 'uguu.se', // 24 h TTL
      async run() {
        const form = new FormData();
        form.append('files[]', new Blob([bytes]), filename);
        const res = await fetchImpl('https://uguu.se/upload.php', { method: 'POST', body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = JSON.parse(await res.text());
        const url = json?.files?.[0]?.url;
        if (!url) throw new Error(`unexpected response: ${JSON.stringify(json).slice(0, 160)}`);
        return url;
      },
    },
    {
      name: 'catbox.moe', // permanent last resort (0x0.st is currently disabling uploads)
      async run() {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', new Blob([bytes]), filename);
        const res = await fetchImpl('https://catbox.moe/user/api.php', { method: 'POST', body: form });
        const text = (await res.text()).trim();
        if (!res.ok || !/^https?:\/\/\S+$/.test(text)) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
        return text;
      },
    },
  ];

  const failures = [];
  for (const a of attempts) {
    try {
      const url = await a.run();
      return { url, host: a.name };
    } catch (err) {
      failures.push(`${a.name}: ${err.message}`);
    }
  }
  throw new Error(`no temp host accepted the video — ${failures.join('; ')}`);
}

async function graphJson(res, what) {
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || body?.error) {
    const msg = body?.error?.message ?? text.slice(0, 300) ?? `${res.status} ${res.statusText}`;
    throw new Error(`${what} failed (${res.status}): ${msg}`);
  }
  return body;
}

/** Refresh the 60-day token → a new 60-day token (throws on failure). */
export async function refreshToken({ accessToken, fetchImpl = fetch }) {
  const res = await fetchImpl(
    `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(accessToken)}`
  );
  const json = await graphJson(res, 'token refresh');
  if (!json?.access_token) throw new Error('token refresh: no access_token returned');
  return { accessToken: json.access_token, expiresIn: json.expires_in };
}

/**
 * 60-day token lifecycle: once the active token is ≥45 days old, refresh it
 * and persist the new one to (a) the registry's `igAuth` field — same
 * youtube-uploads.json file the workflow cache already saves, so the cache
 * version never changes — and (b) the local auth file for local runs.
 * Never throws: a failed refresh keeps the current token (valid until day 60
 * and refreshable again on the next run).
 */
export async function ensureFreshToken({ creds, registryFile, secretsDir, fetchImpl = fetch }) {
  const age = Date.now() - Date.parse(creds.createdAt ?? '');
  if (!Number.isFinite(age) || age < REFRESH_AFTER_MS) {
    return { creds, refreshed: false, warning: null };
  }
  try {
    const { accessToken } = await refreshToken({ accessToken: creds.accessToken, fetchImpl });
    const createdAt = new Date().toISOString();
    const next = { ...creds, accessToken, createdAt, src: 'registry' };
    try {
      const registry = loadRegistry(registryFile);
      registry.igAuth = { accessToken, userId: creds.userId, createdAt };
      saveRegistry(registryFile, registry);
    } catch (e) {
      console.error(`instagram: could not park the refreshed token in the registry: ${e.message}`);
    }
    try {
      let file = {};
      try {
        file = JSON.parse(fs.readFileSync(path.join(secretsDir, 'instagram-auth.json'), 'utf8'));
      } catch {
        /* new file */
      }
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.writeFileSync(
        path.join(secretsDir, 'instagram-auth.json'),
        `${JSON.stringify({ ...file, accessToken, userId: creds.userId, createdAt }, null, 2)}\n`
      );
    } catch {
      /* local persist is best-effort too */
    }
    return { creds: next, refreshed: true, warning: null };
  } catch (err) {
    return { creds, refreshed: false, warning: String(err?.message ?? err) };
  }
}

/** POST /<ig-user>/media — returns the container id. */
export async function createReelContainer({ creds, caption, videoUrl, fetchImpl = fetch }) {
  const res = await fetchImpl(`${GRAPH}/${creds.userId}/media`, {
    method: 'POST',
    body: new URLSearchParams({
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: 'true',
      access_token: creds.accessToken,
    }),
  });
  const json = await graphJson(res, 'create reel container');
  if (!json?.id) throw new Error('create reel container: no container id returned');
  return json.id;
}

/** Poll the container until Meta finishes transcoding (or fail loudly). */
export async function waitForContainer({ containerId, creds, fetchImpl = fetch, timeoutMs = POLL_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetchImpl(
      `${GRAPH}/${containerId}?fields=status_code,error_message&access_token=${encodeURIComponent(creds.accessToken)}`
    );
    const json = await graphJson(res, 'container status');
    if (json.status_code === 'FINISHED') return true;
    if (json.status_code === 'ERROR') throw new Error(`container processing failed: ${json.error_message ?? 'unknown error'}`);
    if (Date.now() >= deadline) throw new Error(`container still ${json.status_code ?? 'pending'} after ${Math.round(timeoutMs / 1000)}s — giving up`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/** POST /media_publish — returns the published media id. */
export async function publishContainer({ containerId, creds, fetchImpl = fetch }) {
  const res = await fetchImpl(`${GRAPH}/${creds.userId}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: containerId, access_token: creds.accessToken }),
  });
  const json = await graphJson(res, 'publish reel');
  if (!json?.id) throw new Error('publish reel: no media id returned');
  return json.id;
}

export async function getPermalink({ mediaId, creds, fetchImpl = fetch }) {
  const res = await fetchImpl(
    `${GRAPH}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(creds.accessToken)}`
  );
  const json = await graphJson(res, 'permalink');
  return json.permalink ?? null;
}

function markPosted(registryFile, key, info) {
  const registry = loadRegistry(registryFile);
  registry.videos[key] = info;
  saveRegistry(registryFile, registry);
}

/**
 * Publish one finished short as an Instagram Reel.
 *
 * @returns {Promise<{status: 'sample'|'no-auth'|'already'|'published'|'error',
 *                    permalink?, message?}>} never throws for expected conditions
 */
export async function publishReel({
  summary,
  registryFile,
  fetchImpl = fetch,
  env = process.env,
  secretsDir = defaultIgSecretsDir(),
  hostVideoImpl,
} = {}) {
  const key = igKeyFor(summary);
  if (summary?.sample || summary?.eventId === 'evt_demo_short') {
    return { status: 'sample', message: 'sample/demo short — never published' };
  }
  if (!key) return { status: 'error', message: 'no instagram key (unknown content)' };
  if (isUploaded(registryFile, key)) {
    const prev = loadRegistry(registryFile).videos[key];
    return { status: 'already', permalink: prev.permalink, message: 'already published to Instagram' };
  }

  const base = loadIgCredentials({ env, secretsDir, registryFile });
  if (!base) {
    return {
      status: 'no-auth',
      message:
        'Instagram not configured — set IG_ACCESS_TOKEN / IG_USER_ID / IG_TOKEN_CREATED secrets ' +
        '(one-time: node scripts/instagram-auth.mjs <token>)',
    };
  }
  // 60-day token lifecycle: auto-refresh from day 45 (see ensureFreshToken).
  const fresh = await ensureFreshToken({ creds: base, registryFile, secretsDir, fetchImpl });
  const creds = fresh.creds;
  const refreshNote = fresh.warning ? ` (${fresh.warning})` : '';

  try {
    if (!summary.video || !fs.existsSync(summary.video)) {
      return { status: 'error', message: `video missing: ${summary.video ?? '(none)'}` };
    }
    const bytes = fs.readFileSync(summary.video);
    const caption = buildCaption(summary);
    const hosted = await (hostVideoImpl ?? hostVideo)(bytes, path.basename(summary.video), fetchImpl);
    const containerId = await createReelContainer({ creds, caption, videoUrl: hosted.url, fetchImpl });
    await waitForContainer({ containerId, creds, fetchImpl });
    const mediaId = await publishContainer({ containerId, creds, fetchImpl });
    const permalink = await getPermalink({ mediaId, creds, fetchImpl });
    markPosted(registryFile, key, {
      id: mediaId,
      permalink,
      title: summary.title,
      host: hosted.host,
      publishedAt: new Date().toISOString(),
    });
    return { status: 'published', permalink, message: `reel published (via ${hosted.host})${refreshNote}` };
  } catch (err) {
    return { status: 'error', message: `${String(err?.message ?? err)}${refreshNote}` };
  }
}
