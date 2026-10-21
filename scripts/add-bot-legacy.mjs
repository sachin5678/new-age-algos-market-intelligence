/**
 * Add the test bot to a group via the legacy messages.addChatUser
 * (channels.inviteToChannel refuses bots: USER_BOT), then promote it.
 */
import { TelegramClient, Api } from 'telegram';
import { StoreSession } from 'telegram/sessions/index.js';
import os from 'node:os';
import path from 'node:path';

process.chdir(os.homedir());
const CHAT = process.argv[2] ?? '-1004497477393';
const BOT = process.argv[3] ?? 'newagealgos_test_bot';

const client = new TelegramClient(
  new StoreSession(path.join('.mcp-telegram', 'sessions', '1718604740')),
  Number(process.env.TELEGRAM_API_ID ?? '20412495'),
  process.env.TELEGRAM_API_HASH ?? 'b8843afdbd2790efd99744c20e8f4f77',
  { connectionRetries: 3 }
);
await client.connect();
if (!(await client.isUserAuthorized())) throw new Error('not authorized');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chatPeer = await client.getInputEntity(CHAT);
const botPeer = await client.getInputEntity(BOT);
const chat = await client.getEntity(CHAT);
const bot = await client.getEntity(BOT);
console.log('channel:', chat.title ?? chat.id, '| bot:', bot.username);

try {
  const r = await client.invoke(
    new Api.messages.AddChatUser({ chat_id: chatPeer.channel_id ?? chat.id, user_id: botPeer, fwd_limit: 0 })
  );
  console.log('addChatUser ok');
  await sleep(3000);
} catch (e) {
  console.log('addChatUser failed:', e.message);
}

try {
  await client.invoke(
    new Api.channels.EditAdmin({
      channel: chatPeer,
      user: botPeer,
      admin_rights: new Api.ChatAdminRights({
        post_messages: true,
        edit_messages: false,
        delete_messages: false,
        ban_users: false,
        invite_users: false,
        restrict_members: false,
        promote_members: false,
        change_info: false,
        pin_messages: false,
        manage_video_chats: false,
        anonymous: false,
      }),
      rank: '',
    })
  );
  console.log('promoted');
} catch (e) {
  console.log('promote failed:', e.message);
}

const full = (await client.invoke(new Api.channels.GetFullChannel({ channel: chatPeer }))).fullChat;
const m = full.users?.find((u) => u.id?.toString() === bot.id?.toString());
console.log('member:', Boolean(m), '| admin:', m?.adminRights ? 'yes' : 'no');

await client.disconnect();
