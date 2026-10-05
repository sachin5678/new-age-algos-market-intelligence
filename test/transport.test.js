import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotApiTransport, createTransport } from '../src/telegram/transport.js';

/** Capturing fetch stub: replays queued responses and records requests. */
function stub(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body } = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { calls, fetchImpl };
}

const HTML = '🌅 <b>NEW AGE ALGOS</b>\n<i>04 Oct 2026</i>';

test('createTransport maps every supported mode', () => {
  assert.equal(createTransport({ mode: 'dry-run' }).name, 'dry-run');
  assert.equal(createTransport({ mode: 'json' }).name, 'json-emit');
  assert.equal(createTransport({ mode: 'bot', options: { botToken: 't', chatId: '1' } }).name, 'bot-api');
  assert.equal(
    createTransport({ mode: 'gramjs', options: { chatId: '1', apiId: '1', apiHash: 'h' } }).name,
    'gramjs'
  );
  assert.throws(() => createTransport({ mode: 'nope' }), /Unknown transport/);
});

test('BotApiTransport posts Telegram HTML to the Bot API and returns the message id', async () => {
  const { calls, fetchImpl } = stub([{ body: { ok: true, result: { message_id: 42 } } }]);
  const t = new BotApiTransport({
    botToken: 'SECRET_TOKEN',
    chatId: -1004497477393,
    logger: null,
    fetchImpl,
  });

  const res = await t.send(HTML, { mode: 'premarket', category: 'BRIEFING', event_id: 'run_1' });

  assert.deepEqual(res, { message_id: 42 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botSECRET_TOKEN\/sendMessage$/);

  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.parse_mode, 'HTML', 'rich text requires HTML parse mode');
  assert.equal(sent.chat_id, '-1004497477393');
  assert.equal(sent.text, HTML, 'formatting must reach Telegram untouched');
  assert.equal(sent.disable_web_page_preview, true);
  // The token must never appear in the body, only in the URL path.
  assert.ok(!calls[0].init.body.includes('SECRET_TOKEN'));
});

test('BotApiTransport fails fast when token or chat id is missing', async () => {
  const noToken = new BotApiTransport({ botToken: null, chatId: '1', fetchImpl: async () => {} });
  await assert.rejects(() => noToken.send('x'), /TELEGRAM_BOT_TOKEN not configured/);

  const noChat = new BotApiTransport({ botToken: 't', chatId: null, fetchImpl: async () => {} });
  await assert.rejects(() => noChat.send('x'), /TELEGRAM_CHAT_ID not configured/);
});

test('BotApiTransport surfaces the Telegram API error description', async () => {
  const { calls, fetchImpl } = stub([
    { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } },
  ]);
  const t = new BotApiTransport({ botToken: 't', chatId: '1', fetchImpl, logger: null });
  await assert.rejects(() => t.send('x'), /chat not found/);
  assert.equal(calls.length, 1, 'a 4xx is a configuration error — must not be retried');
});

test('BotApiTransport retries transient failures with backoff', async () => {
  const { calls, fetchImpl } = stub([
    { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } },
    { body: { ok: true, result: { message_id: 7 } } },
  ]);
  const t = new BotApiTransport({ botToken: 't', chatId: '1', fetchImpl, logger: null });
  const res = await t.send('hello');
  assert.equal(res.message_id, 7);
  assert.equal(calls.length, 2, 'first attempt must be retried');
});

test('sendPhoto uploads a web FormData with a real file part', async () => {
  // Regression: the body used to be a `form-data` (stream) object, which Node's
  // fetch cannot serialise — Telegram answered "there is no photo in the request".
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const tmp = path.join(os.tmpdir(), `photo-${process.pid}.png`);
  fs.writeFileSync(tmp, png);

  try {
    const { calls, fetchImpl } = stub([{ body: { ok: true, result: { message_id: 9 } } }]);
    const t = new BotApiTransport({ botToken: 't', chatId: '-1003067155583', fetchImpl, logger: null });

    const res = await t.sendPhoto(tmp, 'Pre-session summary • 05 October 2026 • 08:30 IST');
    assert.deepEqual(res, { message_id: 9 });
    assert.match(calls[0].url, /\/sendPhoto$/);

    const body = calls[0].init.body;
    assert.ok(body instanceof FormData, `expected web FormData, got ${Object.prototype.toString.call(body)}`);

    const photo = body.get('photo');
    assert.ok(photo instanceof File, 'photo part must be a File so fetch can set a boundary');
    assert.equal(photo.size, png.length, 'the bytes must actually travel with the request');
    assert.equal(photo.type, 'image/png');
    assert.equal(photo.name, path.basename(tmp));
    assert.equal(body.get('chat_id'), '-1003067155583');
    assert.equal(body.get('caption'), 'Pre-session summary • 05 October 2026 • 08:30 IST');
    assert.equal(body.get('parse_mode'), 'HTML');
    // The token must stay in the URL, never in the body.
    assert.ok(!String(calls[0].init.body).includes('SECRET'));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('sendPhoto refuses an empty or missing attachment before hitting the network', async () => {
  const missing = new BotApiTransport({
    botToken: 't',
    chatId: '1',
    fetchImpl: async () => {
      throw new Error('network must not be reached');
    },
    logger: null,
  });
  await assert.rejects(
    () => missing.sendPhoto(path.join(os.tmpdir(), `nope-${process.pid}.png`)),
    /attachment missing or empty/
  );

  const empty = path.join(os.tmpdir(), `empty-${process.pid}.png`);
  fs.writeFileSync(empty, '');
  try {
    await assert.rejects(() => missing.sendPhoto(empty), /attachment missing or empty/);
  } finally {
    fs.unlinkSync(empty);
  }
});
