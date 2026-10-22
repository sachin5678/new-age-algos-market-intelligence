/**
 * Read-only check of the test artefacts left over from the bot setup:
 *  - the extra supergroup created while debugging (and who owns it)
 *  - the old test photo in the test channel
 *
 *   node scripts/check-test-artifacts.mjs
 */
import { TelegramClient, Api } from 'telegram';
import { StoreSession } from 'telegram/sessions/index.js';
import os from 'node:os';
import path from 'node:path';

process.chdir(os.homedir());
const LEFTOVER_GROUP = '-1004294480127';
const TEST_CHANNEL = '-1004497477393';

const client = new TelegramClient(
  new StoreSession(path.join('.mcp-telegram', 'sessions', '1718604740')),
  Number(process.env.TELEGRAM_API_ID ?? '20412495'),
  process.env.TELEGRAM_API_HASH ?? 'b8843afdbd2790efd99744c20e8f4f77',
  { connectionRetries: 3 }
);
await client.connect();
if (!(await client.isUserAuthorized())) throw new Error('not authorized');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const me = await client.getInputEntity('me');
const meUser = await client.invoke(new Api.users.GetUsers({ id: [me] }));
console.log('session user:', meUser.users?.[0]?.firstName, meUser.users?.[0]?.username);

try {
  const peer = await client.getInputEntity(LEFTOVER_GROUP);
  const full = await client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
  console.log('leftover group:', full.full_chat?.title, '| participants:', full.full_chat?.participants_count);
  const admins = await client.invoke(
    new Api.channels.GetParticipants({
      channel: peer,
      filter: new Api.ChannelParticipantsAdmins(),
      offset: 0,
      limit: 100,
    })
  );
  for (const u of admins.users ?? []) {
    console.log('  admin:', u.username ?? u.firstName, 'creator:', !!u.adminRights?.is_creator);
  }
} catch (e) {
  console.log('leftover group: not reachable —', e.message);
}

try {
  const peer = await client.getInputEntity(TEST_CHANNEL);
  const msgs = await client.invoke(
    new Api.messages.GetHistory({ peer, offsetId: 54, limit: 6, hash: 0 })
  );
  for (const m of msgs.messages ?? []) {
    const hasPhoto = !!m.photo;
    console.log(
      `  msg ${m.id} photo:${hasPhoto} text:${JSON.stringify(String(m.message ?? '').slice(0, 70))}`
    );
  }
} catch (e) {
  console.log('test channel history: failed —', e.message);
}

await sleep(500);
await client.disconnect();
