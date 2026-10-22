/**
 * Cleanup of the test artefacts:
 *  - deletes the old test photo (message 52) in the test channel
 *  - tries to delete the leftover supergroup created while debugging
 *
 *   node scripts/cleanup-test-artifacts.mjs
 */
import { TelegramClient, Api } from 'telegram';
import { StoreSession } from 'telegram/sessions/index.js';
import os from 'node:os';
import path from 'node:path';

process.chdir(os.homedir());
const LEFTOVER_GROUP = '-1004294480127';
const TEST_CHANNEL = '-1004497477393';
const OLD_TEST_PHOTO = 52;

const client = new TelegramClient(
  new StoreSession(path.join('.mcp-telegram', 'sessions', '1718604740')),
  Number(process.env.TELEGRAM_API_ID ?? '20412495'),
  process.env.TELEGRAM_API_HASH ?? 'b8843afdbd2790efd99744c20e8f4f77',
  { connectionRetries: 3 }
);
await client.connect();
if (!(await client.isUserAuthorized())) throw new Error('not authorized');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. the old test photo
try {
  const peer = await client.getInputEntity(TEST_CHANNEL);
  const res = await client.invoke(
    new Api.messages.DeleteMessages({ peer, id: [OLD_TEST_PHOTO] })
  );
  console.log('delete message', OLD_TEST_PHOTO, '->', res.updates?.length ?? 0, 'updates');
} catch (e) {
  console.log('delete message', OLD_TEST_PHOTO, 'failed —', e.message);
}
await sleep(2000);

// 2. the leftover supergroup
try {
  const peer = await client.getInputEntity(LEFTOVER_GROUP);
  await client.invoke(new Api.channels.DeleteChannel({ channel: peer }));
  console.log('deleted the leftover group', LEFTOVER_GROUP);
} catch (e) {
  console.log('delete group failed —', e.message);
}

await sleep(500);
await client.disconnect();
