import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CAPTION_MAX,
  buildCaption,
  hostVideo,
  igKeyFor,
  loadIgCredentials,
  publishReel,
} from '../src/instagram.js';
import { isUploaded, loadRegistry } from '../src/youtube.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nna-ig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Route mock: first route whose `match` appears in the URL answers. */
const router = (routes) => async (url, opts) => {
  const hit = routes.find((r) => String(url).includes(r.match));
  if (!hit) return { ok: false, status: 404, text: async () => 'not found' };
  return hit.res(opts, String(url));
};

const ok = (body) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const summaryFor = (dir, { sample = false, eventId = 'evt_a' } = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'short.mp4');
  fs.writeFileSync(video, Buffer.from('mp4'));
  return {
    video,
    title: 'Vedanta jumps on strong earnings #Shorts',
    hashtags: ['#nifty', '#vedanta'],
    eventId,
    sample,
    uploadKey: eventId ? `event:${eventId}` : 'recap:2026-10-05',
  };
};

const CREDS = { IG_ACCESS_TOKEN: 'tok', IG_USER_ID: '123' };
const noNetwork = async () => {
  throw new Error('must not be called');
};

// ------------------------------------------------------------------ helpers

test('loadIgCredentials: env first, then local auth file, else null', (t) => {
  const dir = tmp(t);
  assert.equal(loadIgCredentials({ env: {}, secretsDir: dir }), null);
  assert.deepEqual(loadIgCredentials({ env: CREDS, secretsDir: dir }), { accessToken: 'tok', userId: '123' });
  fs.writeFileSync(path.join(dir, 'instagram-auth.json'), JSON.stringify({ accessToken: 'filetok', userId: '777' }));
  assert.deepEqual(loadIgCredentials({ env: {}, secretsDir: dir }), { accessToken: 'filetok', userId: '777' });
});

test('igKeyFor prefixes the YouTube key so both registries coexist', () => {
  assert.equal(igKeyFor({ uploadKey: 'event:evt_a' }), 'insta:event:evt_a');
  assert.equal(igKeyFor({ eventId: 'evt_b' }), 'insta:event:evt_b');
  assert.equal(igKeyFor({ type: 'recap', runId: 'run-2026-10-06T09:00:00' }), 'insta:recap:2026-10-06');
  assert.equal(igKeyFor({}), null);
});

test('buildCaption appends missing hashtags and clips on a word boundary', () => {
  const caption = buildCaption({ title: 'Nifty steady', hashtags: ['#nifty', '#sensex'] });
  // bare word in the title doesn't count as the tag — keep #nifty (reach)
  assert.equal(caption, 'Nifty steady #nifty #sensex');
  const dup = buildCaption({ title: 'Bank Nifty holds #sensex', hashtags: ['#sensex'] });
  assert.equal(dup, 'Bank Nifty holds #sensex'); // literal tag present → not repeated

  const long = buildCaption({ title: 'x' });
  assert.ok(long.length <= CAPTION_MAX);
  const word = buildCaption({ title: `${'market '.repeat(600)}` });
  assert.ok(word.length <= CAPTION_MAX);
  assert.equal(/\s{2}$/.test(word), false);
});

// ------------------------------------------------------------------ publishReel

test('publishReel: sample shorts never touch the network or registry', async (t) => {
  const dir = tmp(t);
  const registryFile = path.join(dir, 'reg.json');
  const res = await publishReel({
    summary: summaryFor(dir, { sample: true }),
    registryFile,
    env: CREDS,
    fetchImpl: noNetwork,
  });
  assert.equal(res.status, 'sample');
  assert.equal(fs.existsSync(registryFile), false);
});

test('publishReel: no credentials → no-auth (no network)', async (t) => {
  const dir = tmp(t);
  const res = await publishReel({
    summary: summaryFor(path.join(dir, 'run')),
    registryFile: path.join(dir, 'reg.json'),
    env: {}, // no IG secrets yet
    secretsDir: path.join(dir, 'empty-secrets'), // …and no local auth file
    fetchImpl: noNetwork,
  });
  assert.equal(res.status, 'no-auth');
  assert.match(res.message, /IG_ACCESS_TOKEN/);
});

test('publishReel: happy path publishes and marks insta: key; second call dedups', async (t) => {
  const dir = tmp(t);
  const runDir = path.join(dir, 'run-x');
  const summary = summaryFor(runDir);
  const registryFile = path.join(dir, 'reg.json');

  const routes = [
    { match: 'media_publish', res: async () => ok({ id: 'M9' }) },
    { match: '123/media', res: async () => ok({ id: 'C1' }) },
    { match: 'status_code', res: async () => ok({ status_code: 'FINISHED' }) },
    { match: 'permalink', res: async () => ok({ permalink: 'https://www.instagram.com/reel/ABC/' }) },
  ];

  const res = await publishReel({
    summary,
    registryFile,
    env: CREDS,
    fetchImpl: router(routes),
    hostVideoImpl: async () => ({ url: 'https://tmpfiles.org/dl/x/short.mp4', host: 'test-host' }),
  });
  assert.equal(res.status, 'published', res.message);
  assert.equal(res.permalink, 'https://www.instagram.com/reel/ABC/');

  const reg = loadRegistry(registryFile);
  assert.ok(reg.videos['insta:event:evt_a'], 'insta key recorded');
  assert.equal(isUploaded(registryFile, 'event:evt_a'), false, 'YouTube key untouched');

  let called = 0;
  const again = await publishReel({
    summary,
    registryFile,
    env: CREDS,
    fetchImpl: async () => {
      called += 1;
      return ok({});
    },
    hostVideoImpl: async () => {
      called += 1;
      return { url: 'x', host: 'y' };
    },
  });
  assert.equal(again.status, 'already');
  assert.equal(again.permalink, 'https://www.instagram.com/reel/ABC/');
  assert.equal(called, 0, 'dedup short-circuits all network');
});

test('publishReel: container ERROR → status error, registry not marked', async (t) => {
  const dir = tmp(t);
  const registryFile = path.join(dir, 'reg.json');
  const routes = [
    { match: '123/media', res: async () => ok({ id: 'C1' }) },
    { match: 'status_code', res: async () => ok({ status_code: 'ERROR', error_message: 'Video download failed' }) },
  ];
  const res = await publishReel({
    summary: summaryFor(path.join(dir, 'run')),
    registryFile,
    env: CREDS,
    fetchImpl: router(routes),
    hostVideoImpl: async () => ({ url: 'https://x/v.mp4', host: 'h' }),
  });
  assert.equal(res.status, 'error');
  assert.match(res.message, /container processing failed: Video download failed/);
  assert.equal(fs.existsSync(registryFile), false, 'nothing recorded on failure');
});

test('publishReel: Meta API failure surfaces as status error (never throws)', async (t) => {
  const dir = tmp(t);
  const routes = [
    {
      match: '123/media',
      res: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Invalid access token' } }) }),
    },
  ];
  const res = await publishReel({
    summary: summaryFor(path.join(dir, 'run')),
    registryFile: path.join(dir, 'reg.json'),
    env: CREDS,
    fetchImpl: router(routes),
    hostVideoImpl: async () => ({ url: 'https://x/v.mp4', host: 'h' }),
  });
  assert.equal(res.status, 'error');
  assert.match(res.message, /Invalid access token/);
});

test('publishReel: missing video file → status error before any network', async (t) => {
  const dir = tmp(t);
  const res = await publishReel({
    summary: { ...summaryFor(path.join(dir, 'run')), video: path.join(dir, 'nope.mp4') },
    registryFile: path.join(dir, 'reg.json'),
    env: CREDS,
    fetchImpl: noNetwork,
    hostVideoImpl: noNetwork,
  });
  assert.equal(res.status, 'error');
  assert.match(res.message, /video missing/);
});

// ------------------------------------------------------------------ hostVideo

test('hostVideo: tmpfiles direct-link conversion', async () => {
  const res = await hostVideo(Buffer.from('x'), 'short.mp4', async (url) => {
    assert.match(String(url), /tmpfiles\.org/);
    return ok({ status: 'success', data: { url: 'https://tmpfiles.org/abcd1234/short.mp4' } });
  });
  assert.equal(res.url, 'https://tmpfiles.org/dl/abcd1234/short.mp4');
  assert.equal(res.host, 'tmpfiles.org');
});

test('hostVideo: falls back to uguu.se, then catbox.moe; errors only when all fail', async () => {
  const res = await hostVideo(Buffer.from('x'), 'short.mp4', async (url) => {
    if (String(url).includes('tmpfiles')) return { ok: false, status: 500, text: async () => 'nope' };
    return ok({ success: true, files: [{ url: 'https://n.uguu.se/ab.mp4' }] });
  });
  assert.equal(res.url, 'https://n.uguu.se/ab.mp4');
  assert.equal(res.host, 'uguu.se');

  const viaCatbox = await hostVideo(Buffer.from('x'), 'short.mp4', async (url) => {
    if (String(url).includes('tmpfiles') || String(url).includes('uguu')) return { ok: false, status: 503, text: async () => 'busy' };
    return { ok: true, status: 200, text: async () => 'https://files.catbox.moe/zz.mp4' };
  });
  assert.equal(viaCatbox.host, 'catbox.moe');
  assert.equal(viaCatbox.url, 'https://files.catbox.moe/zz.mp4');

  await assert.rejects(
    hostVideo(Buffer.from('x'), 'short.mp4', async () => ({ ok: false, status: 500, text: async () => 'down' })),
    /tmpfiles\.org.*uguu\.se.*catbox\.moe/s
  );
});
