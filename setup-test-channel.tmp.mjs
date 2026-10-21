/**
 * Give the test bot its own test channel.
 *
 * Telegram refuses to add a bot to a broadcast channel programmatically
 * (channels.inviteToChannel -> USER_BOT), so the testing bot owns its own
 * channel instead: it creates it, the user account subscribes to it, and the
 * CI posts its test messages there.
 *
 *   node scripts/setup-test-channel.mjs <bot_token>
 */
import { TelegramClient, Api } from 'telegram';
import { StoreSession } from 'telegram/sessions/index.js';
import os from 'node:os';
import path from 'node:path';

const TOKEN = process.argv[2];
if (!TOKEN) throw new Error('bot token required');

const api = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json() };
};

// 1. The bot owns the test channel.
let chatId = null;
const created = await api('createChannel', {
  title: 'New Age Algos Test — Bot',
  description: 'Automated test messages from @newagealgos_test_bot. Nothing here is a production post.',
});
if (created.json.ok) {
  chatId = created.json.result.id;
  console.log('created channel:', chatId, JSON.stringify(created.json.result).slice(0, 120));
} else {
  console.log('createChannel failed:', JSON.stringify(created.json));
}

if (!chatId) {
  // A channel may already exist (the bot owns it) — find it.
  const chats = await api('getChats', {});
  console.log('getChats:', JSON.stringify(chats.json).slice(0, 300));
  process.exit(1);
}

// 2. A public username makes the channel easy to find and to join.
const uname = await api('setChatUsername', { chat_id: chatId, username: 'newagealgos_test_bot' });
console.log('username:', uname.json.ok ? uname.json.result.username : JSON.stringify(uname.json).slice(0, 200));

// 3. The user account subscribes, so the messages are visible to the user.
process.chdir(os.homedir());
const client = new TelegramClient(
  new StoreSession(path.join('.mcp-telegram', 'sessions', '1718604740')),
  Number(process.env.TELEGRAM_API_ID ?? '20412495'),
  process.env.TELEGRAM_API_HASH ?? 'b8843afdbd2790efd99744c20e8f4f77',
  { connectionRetries: 3 }
);
await client.connect();
if (!(await client.isUserAuthorized())) throw new Error('not authorized');

const link = await api('exportChatInviteLink', { chat_id: chatId });
console.log('invite link:', link.json?.result?.invite_link);

if (link.json?.result?.invite_link) {
  try {
    const res = await client.invoke(new Api.messages.ImportChatInvite({ hash: link.json.result.invite_link.split('+').pop() }));
    console.log('user account joined the test channel');
  } catch (e) {
    console.log('join failed:', e.message);
  }
}

// 4. The bot posts a hello so the channel is not empty.
const hello = await api('sendMessage', {
  chat_id: chatId,
  text: '🤖 <b>New Age Algos test bot</b> online.\n\nTest messages for the post-market wrap land here. The production channel is untouched.',
  parse_mode: 'HTML',
});
console.log('hello message:', hello.json.ok ? `message_id ${hello.json.result.message_id}` : JSON.stringify(hello.json));

console.log('\n=== TEST CHAT ID ===');
console.log(String(chatId));
console.log('=== END ===');

await client.disconnect();

