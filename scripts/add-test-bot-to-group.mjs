/**
 * Add the test bot to the test group and give it the right to post.
 *
 *   node scripts/add-test-bot-to-group.mjs <chat_id> <bot_username> <bot_token>
 *
 * Two ways in:
 *   - MTProto messages.addChatUser (the legacy add-member call)
 *   - Bot API joinChat with an invite link exported by the user session
 */
import { TelegramClient, Api } from 'telegram';
import { StoreSession } from 'telegram/sessions/index.js';
import os from 'node:os';
import path from 'node:path';

process.chdir(os.homedir());
const CHAT = process.argv[2] ?? '-1004497477393';
const BOT = process.argv[3] ?? 'newagealgos_test_bot';
const TOKEN = process.argv[4];

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
console.log('channel:', chat.title ?? chat.id, '| bot:', bot.username, bot.id.toString());

const isMember = async () => {
  const res = await client.invoke(
    new Api.channels.GetParticipants({
      channel: chatPeer,
      filter: new Api.ChannelParticipantsBots(),
      offset: 0,
      limit: 100,
    })
  );
  return (res.users ?? []).some((u) => u.id?.toString() === bot.id.toString());
};

console.log('member before:', await isMember());

if (!(await isMember())) {
  // 1) legacy add-member call (works for basic groups / some supergroups)
  try {
    await client.invoke(
      new Api.messages.AddChatUser({ chat_id: chat.id, user_id: botPeer, fwd_limit: 0 })
    );
    console.log('messages.addChatUser ok');
    await sleep(3000);
  } catch (e) {
    console.log('messages.addChatUser failed:', e.message);
  }

  // 2) Bot API joinChat through an exported invite link
  if (!(await isMember()) && TOKEN) {
    const invite = await client.invoke(
      new Api.messages.ExportChatInvite({ peer: chatPeer, legacy_revoke_permanent: false })
    );
    console.log('invite link:', invite.link);
    for (const link of [invite.link, invite.link.replace('t.me/+', 't.me/joinchat/')]) {
      const join = await fetch(`https://api.telegram.org/bot${TOKEN}/joinChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invite_link: link }),
      });
      const j = await join.json();
      console.log('joinChat', link, '->', join.status, JSON.stringify(j).slice(0, 160));
      if (j.ok) break;
      await sleep(1500);
    }
    await sleep(3000);
  }
}

console.log('member after:', await isMember());

// Promote: the bot needs the right to post messages.
try {
  await client.invoke(
    new Api.channels.EditAdmin({
      channel: chatPeer,
      user_id: botPeer,
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
  console.log('promoted with post_messages');
} catch (e) {
  console.log('promote failed:', e.message);
}

await client.disconnect();
