/**
 * Get the test bot into the "New Age Algos Test" CHANNEL.
 *
 * Telegram will not add a bot to a broadcast channel directly
 * (channels.inviteToChannel -> USER_BOT). But a channel can have JOIN
 * REQUESTS enabled: the bot then asks to join through the channel's invite
 * link, and the owner approves the request.
 */
import { TelegramClient, Api } from 'telegram';
import { StoreSession } from 'telegram/sessions/index.js';
import os from 'node:os';
import path from 'node:path';

process.chdir(os.homedir());
const CHAT = '-1004497477393';
const TEST_TOKEN = process.argv[2];

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
const chat = await client.getEntity(CHAT);

// 1. Enable join requests on the channel.
try {
  await client.invoke(new Api.channels.ToggleJoinRequest({ channel: chatPeer, enabled: true }));
  console.log('join requests: enabled');
} catch (e) {
  console.log('toggleJoinRequest failed:', e.message);
}
await sleep(1500);

// 2. Export the channel's invite link.
const invite = await client.invoke(
  new Api.messages.ExportChatInvite({ peer: chatPeer, legacy_revoke_permanent: false })
);
const link = invite.link;
console.log('invite link:', link);

// 3. The test bot asks to join through that link.
const join = await fetch(`https://api.telegram.org/bot${TEST_TOKEN}/joinChat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ invite_link: link }),
});
const joinJson = await join.json();
console.log('joinChat:', join.status, JSON.stringify(joinJson).slice(0, 220));
await sleep(2000);

// 4. Approve the pending request (the bot's request, if any).
try {
  const full = (await client.invoke(new Api.channels.GetFullChannel({ channel: chatPeer }))).fullChat;
  console.log('requests_pending:', full.requests_pending ?? 0, '| recent_requesters:', full.recent_requesters ?? []);
  for (const uid of full.recent_requesters ?? []) {
    await client.invoke(
      new Api.messages.HideChatJoinRequest({ peer: chatPeer, user_id: uid, approved: true })
    );
    console.log('approved join request for', uid.toString());
  }
} catch (e) {
  console.log('approve failed:', e.message);
}
await sleep(2500);

// 5. Membership check.
const res = await client.invoke(
  new Api.channels.GetParticipants({
    channel: chatPeer,
    filter: new Api.ChannelParticipantsAdmins(),
    offset: 0,
    limit: 100,
  })
);
console.log('admins now:', (res.users ?? []).map((u) => u.username).join(', '));

await client.disconnect();
