/**
 * Instagram Reels publisher — official Instagram Graph API (free).
 *
 * Why the official API (vs instagrapi-style scrapers): Meta's Content
 * Publishing API is free, stable, and does not risk a shadow-ban of the
 * channel account. Quota is 100 API-published posts / rolling 24 h — the
 * schedule needs two (story + recap), so headroom is ~50x.
 *
 * Endpoints (graph.facebook.com):
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

const GRAPH = 'https://graph.facebook.com/v26.0';
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
export const CAPTION_MAX = 2_200; // Instagram hard limit

export const defaultIgSecretsDir = () => process.env.SECRETS_DIR || path.join(os.homedir(), '.secrets');

/**
 * {accessToken, userId}: env first (CI secrets), then the local
 * ~/.secrets/instagram-auth.json written by scripts/instagram-auth.mjs —
 * the same env-then-file pattern as YouTube's loadCredentials().
 */
export function loadIgCredentials({ env = process.env, secretsDir = defaultIgSecretsDir() } = {}) {
  const fromEnv = {
    accessToken: String(env.IG_ACCESS_TOKEN ?? '').trim(),
    userId: String(env.IG_USER_ID ?? '').trim(),
  };
  if (fromEnv.accessToken && fromEnv.userId) return fromEnv;
  try {
    const file = JSON.parse(fs.readFileSync(path.join(secretsDir, 'instagram-auth.json'), 'utf8'));
    const accessToken = String(file?.accessToken ?? '').trim();
    const userId = String(file?.userId ?? '').trim();
    if (accessToken && userId) return { accessToken, userId };
  } catch {
    /* no local auth file yet — treated as unconfigured */
  }
  return null;
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

  const creds = loadIgCredentials({ env, secretsDir });
  if (!creds) {
    return {
      status: 'no-auth',
      message: 'Instagram not configured — set IG_ACCESS_TOKEN + IG_USER_ID secrets (one-time Meta token exchange)',
    };
  }

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
    return { status: 'published', permalink, message: `reel published (via ${hosted.host})` };
  } catch (err) {
    return { status: 'error', message: String(err?.message ?? err) };
  }
}
