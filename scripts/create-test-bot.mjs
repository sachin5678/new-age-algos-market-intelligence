/**
 * Create a Telegram TEST bot through BotFather, using the user session.
 *
 *   node scripts/create-test-bot.mjs
 *
 * Prints the token on stdout. Nothing is written to disk.
 */
import { TelegramClient } from 'telegram';
import { StoreSession } from 'telegram/sessions/index.js';
import os from 'node:os';
import path from 'node:path';

process.chdir(os.homedir());

const NAME = process.argv[2] ?? 'New Age Algos Test';
const USERNAME = process.argv[3] ?? 'newagealgos_test_bot';

const client = new TelegramClient(
  new StoreSession(path.join('.mcp-telegram', 'sessions', '1718604740')),
  Number(process.env.TELEGRAM_API_ID ?? '20412495'),
  process.env.TELEGRAM_API_HASH ?? 'b8843afdbd2790efd99744c20e8f4f77',
  { connectionRetries: 3 }
);
await client.connect();
if (!(await client.isUserAuthorized())) throw new Error('not authorized');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the next message from `peer` that matches `re`, and return its text. */
async function waitFor(peer, re, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await client.getMessages(peer, { limit: 5 });
    for (const m of msgs) {
      if (m.out) continue;
      if (re.test(m.message ?? '')) return m.message ?? '';
    }
    await sleep(1200);
  }
  throw new Error(`timed out waiting for ${re}`);
}

const bf = await client.getEntity('botfather');

await client.sendMessage(bf, { message: '/newbot' });
const namePrompt = await waitFor(bf, /name/i);
console.log('botfather:', namePrompt.trim().split('\n')[0]);

await client.sendMessage(bf, { message: NAME });
const userPrompt = await waitFor(bf, /username/i);
console.log('botfather:', userPrompt.trim().split('\n')[0]);

await client.sendMessage(bf, { message: USERNAME });
const tokenMsg = await waitFor(bf, /\d{6,}:[A-Za-z0-9_-]{30,}/, 60_000);
const token = tokenMsg.match(/\d{6,}:[A-Za-z0-9_-]{30,}/)[0];
console.log('\n=== TOKEN ===');
console.log(token);
console.log('=== END ===');

await client.disconnect();
