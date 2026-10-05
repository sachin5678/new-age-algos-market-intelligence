import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AUTH_SCOPE,
  buildMultipart,
  defaultRegistryFile,
  isUploaded,
  loadCredentials,
  loadRegistry,
  refreshAccessToken,
  safeTitle,
  saveRegistry,
  setThumbnail,
  uploadAllUnsent,
  uploadKeyFor,
  uploadMeta,
  uploadShort,
  uploadVideo,
} from '../src/youtube.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nna-yt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Route mock: first route whose `match` appears in the URL answers. */
const router = (routes) => async (url, opts) => {
  const hit = routes.find((r) => String(url).includes(r.match));
  if (!hit) return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
  return hit.res(opts, String(url));
};

const authFile = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'youtube-auth.json'),
    JSON.stringify({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rtok', scope: AUTH_SCOPE })
  );
};

const writeRun = (root, name, meta) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'short.mp4'), Buffer.from('mp4bytes'));
  if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
};

// ------------------------------------------------------------------ titles/meta

test('safeTitle keeps YouTube happy: ≤100 chars, word-clipped with ellipsis', () => {
  const short = 'Nifty oversold ahead of RBI policy #Shorts';
  assert.equal(safeTitle(short), short);
  const long = `${'Movers '.repeat(30)} #Shorts`;
  assert.ok(long.length > 100);
  const out = safeTitle(long);
  assert.ok(out.length <= 100, `got ${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.equal(/\s{2}/.test(out), false);
});

test('uploadMeta: deduped tags without #, valid privacy, news category', () => {
  const meta = uploadMeta({
    title: 'Market Recap #Shorts',
    description: 'levels via Yahoo Finance',
    hashtags: ['#nifty', '#stockmarket', '#nifty'], // dup on purpose
    privacy: 'nonsense',
  });
  assert.equal(meta.snippet.title, 'Market Recap #Shorts');
  assert.ok(meta.snippet.tags.includes('nifty'));
  assert.equal(meta.snippet.tags.some((t) => t.startsWith('#')), false);
  assert.equal(new Set(meta.snippet.tags).size, meta.snippet.tags.length);
  assert.equal(meta.status.privacyStatus, 'public');
  assert.equal(meta.status.selfDeclaredMadeForKids, false);
  assert.equal(meta.snippet.categoryId, '25');
  const priv = uploadMeta({ title: 'x', privacy: 'unlisted' });
  assert.equal(priv.status.privacyStatus, 'unlisted');
});

// ------------------------------------------------------------------ multipart

test('buildMultipart: multipart/related with JSON part before the video bytes', () => {
  const { body, contentType } = buildMultipart({
    metadata: { snippet: { title: 'Hello' } },
    video: Buffer.from('VIDEODATA'),
    boundary: 'BND',
  });
  assert.match(contentType, /^multipart\/related; boundary=BND$/);
  const text = body.toString('latin1');
  assert.ok(text.startsWith('--BND\r\n'));
  assert.ok(text.endsWith('--BND--\r\n'));
  const jsonIdx = text.indexOf('{"snippet"');
  const videoIdx = text.indexOf('VIDEODATA');
  assert.ok(jsonIdx > 0 && videoIdx > jsonIdx, 'JSON part must precede video part');
  assert.match(text, /Content-Type: application\/json; charset=UTF-8/);
  assert.match(text, /Content-Type: video\/mp4/);
  assert.equal(Buffer.isBuffer(body), true);
});

// ------------------------------------------------------------------ auth

test('refreshAccessToken posts form-encoded refresh grant and returns token', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ access_token: 'AT-1', expires_in: 3599 }) };
  };
  const token = await refreshAccessToken(
    { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rtok' },
    { fetchImpl }
  );
  assert.equal(token, 'AT-1');
  assert.match(seen.url, /oauth2\.googleapis\.com\/token/);
  assert.match(seen.opts.headers['Content-Type'], /x-www-form-urlencoded/);
  const params = new URLSearchParams(seen.opts.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'rtok');
});

test('refreshAccessToken surfaces invalid_grant with a re-auth hint', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant' }),
  });
  await assert.rejects(
    refreshAccessToken({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' }, { fetchImpl }),
    /re-run scripts\/youtube-auth\.mjs/
  );
});

test('loadCredentials: auth file wins, missing → null, env overrides', (t) => {
  const dir = tmp(t);
  assert.equal(loadCredentials({ secretsDir: dir, env: {} }), null);
  authFile(dir);
  const creds = loadCredentials({ secretsDir: dir, env: {} });
  assert.equal(creds.clientId, 'cid');
  assert.equal(creds.refreshToken, 'rtok');
  const viaEnv = loadCredentials({
    secretsDir: dir,
    env: { YOUTUBE_CLIENT_ID: 'E', YOUTUBE_CLIENT_SECRET: 'ES', YOUTUBE_REFRESH_TOKEN: 'ER' },
  });
  assert.equal(viaEnv.clientId, 'E');
  assert.equal(viaEnv.refreshToken, 'ER');
});

// ------------------------------------------------------------------ registry

test('registry roundtrip, dedup key and corruption tolerance', (t) => {
  const dir = tmp(t);
  const file = defaultRegistryFile(dir);
  assert.deepEqual(loadRegistry(file), { videos: {} }); // missing file
  saveRegistry(file, { videos: {} });
  assert.equal(isUploaded(file, 'event:evt_1'), false);
  saveRegistry(file, { videos: { 'event:evt_1': { videoId: 'v1', url: 'https://youtu.be/v1' } } });
  assert.equal(isUploaded(file, 'event:evt_1'), true);
  assert.equal(isUploaded(file, 'event:evt_2'), false);
  assert.equal(isUploaded(file, null), false);
  fs.writeFileSync(file, '{corrupt json');
  assert.deepEqual(loadRegistry(file), { videos: {} });

  assert.equal(uploadKeyFor({ uploadKey: 'explicit' }), 'explicit');
  assert.equal(uploadKeyFor({ eventId: 'evt_9' }), 'event:evt_9');
  assert.equal(uploadKeyFor({ type: 'recap', runId: 'run-2026-10-05T16-51-19' }), 'recap:2026-10-05');
  assert.equal(uploadKeyFor({ type: 'recap', runId: 'weird' }), null);
  assert.equal(uploadKeyFor({}), null);
});

// ------------------------------------------------------------------ uploadVideo

test('uploadVideo: multipart POST with bearer, parses video id, errors explain', async () => {
  let seen = null;
  const okFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ id: 'VID123', snippet: { title: 'T' } }) };
  };
  const meta = uploadMeta({ title: 'T', description: 'D' });
  const out = await uploadVideo({ accessToken: 'AT', meta, video: Buffer.from('v'), fetchImpl: okFetch });
  assert.equal(out.videoId, 'VID123');
  assert.equal(out.url, 'https://youtu.be/VID123');
  assert.match(seen.url, /upload\/youtube\/v3\/videos\?uploadType=multipart&part=snippet,status/);
  assert.match(seen.url, /notifySubscribers=true/);
  assert.equal(seen.opts.headers.Authorization, 'Bearer AT');
  assert.match(seen.opts.headers['Content-Type'], /^multipart\/related; boundary=/);

  const errFetch = async () => ({
    ok: false,
    status: 403,
    text: async () =>
      JSON.stringify({ error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }),
    json: async () => ({}),
  });
  await assert.rejects(
    uploadVideo({ accessToken: 'AT', meta, video: Buffer.from('v'), fetchImpl: errFetch }),
    /quota/i
  );
});

test('setThumbnail posts raw png; failure throws (callers soft-fail)', async () => {
  let seen = null;
  const okFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({}) };
  };
  await setThumbnail({ accessToken: 'AT', videoId: 'V1', png: Buffer.from([1, 2, 3]), fetchImpl: okFetch });
  assert.match(seen.url, /thumbnails\?videoId=V1&uploadType=media$/);
  assert.equal(seen.opts.headers['Content-Type'], 'image/png');
  const bad = async () => ({ ok: false, status: 400, text: async () => 'nope', json: async () => ({}) });
  await assert.rejects(setThumbnail({ accessToken: 'AT', videoId: 'V1', png: Buffer.from('x'), fetchImpl: bad }));
});

// ------------------------------------------------------------------ uploadShort

const summaryFor = (dir, { sample = false, eventId = 'evt_a' } = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'short.mp4');
  fs.writeFileSync(video, Buffer.from('mp4'));
  const png = path.join(dir, 'scene-00-hook.png');
  fs.writeFileSync(png, Buffer.from([137, 80, 78, 71]));
  return {
    video,
    title: 'Nifty oversold ahead of RBI policy #Shorts',
    description: 'desc',
    hashtags: ['#nifty'],
    eventId,
    sample,
    uploadKey: eventId ? `event:${eventId}` : 'recap:2026-10-05',
    scenes: [{ kind: 'hook', png }],
  };
};

const successRoutes = [
  { match: 'oauth2.googleapis.com/token', res: async () => ({ ok: true, json: async () => ({ access_token: 'AT' }) }) },
  { match: 'videos?uploadType=multipart', res: async () => ({ ok: true, json: async () => ({ id: 'V9', snippet: { title: 'ok' } }) }) },
  { match: 'thumbnails?', res: async () => ({ ok: true, json: async () => ({}) }) },
];

test('uploadShort: sample shorts never touch the network', async (t) => {
  const dir = tmp(t);
  const registryFile = path.join(dir, 'reg.json');
  let called = 0;
  const res = await uploadShort({
    summary: summaryFor(dir, { sample: true }),
    registryFile,
    secretsDir: dir,
    fetchImpl: async () => {
      called += 1;
      throw new Error('must not be called');
    },
  });
  assert.equal(res.status, 'sample');
  assert.equal(called, 0);
  assert.equal(fs.existsSync(registryFile), false, 'nothing recorded for samples');
});

test('uploadShort: no credentials → no-auth (no network)', async (t) => {
  const dir = tmp(t);
  const res = await uploadShort({
    summary: summaryFor(path.join(dir, 'run')),
    registryFile: path.join(dir, 'reg.json'),
    secretsDir: path.join(dir, 'empty-secrets'), // no auth file
    fetchImpl: async () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(res.status, 'no-auth');
  assert.match(res.message, /youtube-auth\.mjs/);
});

test('uploadShort: happy path uploads, sets thumb, marks registry; second call dedups', async (t) => {
  const dir = tmp(t);
  const runDir = path.join(dir, 'run-x');
  fs.mkdirSync(runDir);
  authFile(path.join(dir, 'secrets'));
  const registryFile = path.join(dir, 'reg.json');
  const summary = summaryFor(runDir);

  let videoBody = null;
  const routes = [
    successRoutes[0],
    {
      match: 'videos?uploadType=multipart',
      res: async (opts) => {
        videoBody = opts.body.toString('latin1');
        return { ok: true, json: async () => ({ id: 'V9', snippet: { title: summary.title } }) };
      },
    },
    successRoutes[2],
  ];
  const res = await uploadShort({ summary, registryFile, secretsDir: path.join(dir, 'secrets'), fetchImpl: router(routes) });
  assert.equal(res.status, 'uploaded');
  assert.equal(res.videoId, 'V9');
  assert.equal(res.url, 'https://youtu.be/V9');
  assert.equal(res.thumb, 'ok');
  assert.match(videoBody, /Nifty oversold ahead of RBI policy/, 'title must travel inside the multipart body');
  assert.equal(isUploaded(registryFile, 'event:evt_a'), true);

  const again = await uploadShort({
    summary,
    registryFile,
    secretsDir: path.join(dir, 'secrets'),
    fetchImpl: async () => {
      throw new Error('dedup must short-circuit before any network call');
    },
  });
  assert.equal(again.status, 'already');
  assert.equal(again.url, 'https://youtu.be/V9');
});

test('uploadShort: upload error → error status, registry stays clean; thumb failure still publishes', async (t) => {
  const dir = tmp(t);
  authFile(path.join(dir, 'secrets'));
  const registryFile = path.join(dir, 'reg.json');

  // 1. upload fails
  const runErr = path.join(dir, 'run-err');
  fs.mkdirSync(runErr);
  const failRoutes = [
    successRoutes[0],
    {
      match: 'videos?uploadType=multipart',
      res: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'bad token' } }),
        json: async () => ({}),
      }),
    },
  ];
  const bad = await uploadShort({
    summary: summaryFor(runErr, { eventId: 'evt_err' }),
    registryFile,
    secretsDir: path.join(dir, 'secrets'),
    fetchImpl: router(failRoutes),
  });
  assert.equal(bad.status, 'error');
  assert.match(bad.message, /bad token/);
  assert.equal(isUploaded(registryFile, 'event:evt_err'), false, 'failed uploads must not be recorded');

  // 2. thumbnail fails but video is live
  const runOk = path.join(dir, 'run-ok');
  fs.mkdirSync(runOk);
  const noThumbRoutes = [
    successRoutes[0],
    successRoutes[1],
    { match: 'thumbnails?', res: async () => ({ ok: false, status: 403, text: async () => 'nope', json: async () => ({}) }) },
  ];
  const ok = await uploadShort({
    summary: summaryFor(runOk, { eventId: 'evt_ok' }),
    registryFile,
    secretsDir: path.join(dir, 'secrets'),
    fetchImpl: router(noThumbRoutes),
  });
  assert.equal(ok.status, 'uploaded');
  assert.match(ok.thumb, /^failed/);
  assert.equal(isUploaded(registryFile, 'event:evt_ok'), true);
});

// ------------------------------------------------------------------ backfill

test('uploadAllUnsent: publishes pending, skips samples/corrupt/already-uploaded', async (t) => {
  const dir = tmp(t);
  authFile(path.join(dir, 'secrets'));
  const registryFile = path.join(dir, 'reg.json');
  const root = path.join(dir, 'shorts');
  fs.mkdirSync(root);

  writeRun(root, 'run-2026-10-04T09-00-00', {
    runId: 'run-2026-10-04T09-00-00',
    eventId: 'evt_fresh',
    title: 'Fresh #Shorts',
    description: 'd',
    hashtags: [],
    scenes: [],
  });
  writeRun(root, 'run-2026-10-04T10-00-00', {
    runId: 'run-2026-10-04T10-00-00',
    eventId: 'evt_demo_short',
    title: 'Demo #Shorts',
    description: 'd',
    hashtags: [],
    scenes: [],
  });
  writeRun(root, 'run-2026-10-04T11-00-00', null); // no meta.json → skipped
  writeRun(root, 'run-2026-10-05T16-51-19', {
    runId: 'run-2026-10-05T16-51-19',
    type: 'recap',
    title: 'Recap #Shorts',
    description: 'd',
    hashtags: [],
    scenes: [],
  });
  saveRegistry(registryFile, { videos: { 'recap:2026-10-05': { videoId: 'old', url: 'https://youtu.be/old' } } });

  const results = await uploadAllUnsent({
    runsRoot: root,
    registryFile,
    secretsDir: path.join(dir, 'secrets'),
    fetchImpl: router(successRoutes),
  });
  assert.equal(results.length, 3); // no-meta run skipped
  const byKey = Object.fromEntries(results.map((r) => [r.key, r.status]));
  assert.equal(byKey['event:evt_fresh'], 'uploaded');
  assert.equal(byKey['event:evt_demo_short'], 'sample');
  assert.equal(byKey['recap:2026-10-05'], 'already');
  assert.equal(isUploaded(registryFile, 'event:evt_fresh'), true);
});
