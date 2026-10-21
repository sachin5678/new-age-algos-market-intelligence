/**
 * Channel admin rights for the two bots in the "New Age Algos Test" channel.
 *
 * The GramJS class takes CAMEL CASE flags (postMessages, inviteUsers,
 * addAdmins) — passing the schema's snake_case silently means "no rights",
 * which DEMOTES the bot. Hence this file: the rights are spelled out once,
 * correctly, and used for both bots.
 */
import { TelegramClient, Api } from 'telegram';
import { StoreSession } from 'telegram/sessions/index.js';
import { utils } from 'telegram';
import os from 'node:os';
import path from 'node:path';

process.chdir(os.homedir());
const CHAT = '-1004497477393';
const PROD_BOT = 'daily_quote_quantx_bot';
const TEST_BOT = 'newagealgos_test_bot';

/** Post only — enough for the daily wrap. */
const POST_ONLY = {
  changeInfo: false,
  postMessages: true,
  editMessages: false,
  deleteMessages: false,
  banUsers: false,
  inviteUsers: false,
  pinMessages: false,
  addAdmins: false,
  anonymous: false,
  manageCall: false,
  other: false,
  manageTopics: false,
  postStories: false,
  editStories: false,
  deleteStories: false,
};

/** Post + invite + promote — the rights the production bot needs to hand the
 *  test bot an invite link and promote it. */
const PROD_RIGHTS = { ...POST_ONLY, inviteUsers: true, addAdmins: true };

const client = new TelegramClient(
  new StoreSession(path.join('.mcp-telegram', 'sessions', '1718604740')),
  Number(process.env.TELEGRAM_API_ID ?? '20412495'),
  process.env.TELEGRAM_API_HASH ?? 'b8843afdbd2790efd99744c20e8f4f77',
  { connectionRetries: 3 }
);
await client.connect();
if (!(await client.isUserAuthorized())) throw new Error('not authorized');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chanPeer = await client.getInputEntity(CHAT);

async function setAdmin(username, rights) {
  const userPeer = await client.getInputEntity(username);
  const req = new Api.channels.EditAdmin({
    channel: chanPeer,
    userId: userPeer,
    adminRights: new Api.ChatAdminRights(rights),
    rank: '',
  });
  req.resolve = async (client, u) => {
    req.channel = u.getInputChannel(chanPeer);
    req.userId = u.getInputUser(userPeer);
  };
  try {
    const res = await client.invoke(req);
    console.log(`${username}: updates=${(res.updates ?? []).length}`);
  } catch (e) {
    console.log(`${username}: failed — ${e.message}`);
  }
  await sleep(2500);
}

console.log('--- restore the production bot (post + invite + promote) ---');
await setAdmin(PROD_BOT, PROD_RIGHTS);

console.log('--- add the test bot (post only) ---');
await setAdmin(TEST_BOT, POST_ONLY);

const res = await client.invoke(
  new Api.channels.GetParticipants({
    channel: chanPeer,
    filter: new Api.ChannelParticipantsAdmins(),
    offset: 0,
    limit: 100,
  })
);
console.log('admins now:');
for (const u of res.users ?? []) {
  const r = u.adminRights;
  console.log(
    `  ${u.username} post:${r?.postMessages} invite:${r?.inviteUsers} addAdmins:${r?.addAdmins}`
  );
}

await client.disconnect();
