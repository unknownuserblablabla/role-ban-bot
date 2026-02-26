// bot.js
'use strict';

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const fs = require('fs/promises');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// --- CONFIG ---
const TARGET_GUILD_ID = "1456307355959689373";
const TARGET_ROLE_ID = "1475987720248627260";
const MOD_LOG_CHANNEL_ID = "1456307741990850723";

const DEBUG = true;
const DM_MESSAGE = "You got banned for being under 16, which is not allowed!";
const BAN_REASON = "Banned for being under 16 years old";

const BAN_RECORD_FILE = path.resolve(__dirname, 'banned_ids.json');
const BAN_RECORD_TEMP = BAN_RECORD_FILE + '.tmp';

const BAN_OFFSET_FILE = path.resolve(__dirname, 'ban_offset.json');
const BAN_OFFSET_TEMP = BAN_OFFSET_FILE + '.tmp';
// ------------------

const previouslyBanned = new Set();
let banOffset = 0; // integer adjustment added by admin commands

function logDebug(...args) {
  if (!DEBUG) return;
  console.log(new Date().toISOString(), ...args);
}

// ---------- Persistence ----------
async function loadBanRecord() {
  try {
    const raw = await fs.readFile(BAN_RECORD_FILE, 'utf8').catch(() => null);
    if (!raw) {
      logDebug('[INFO] No existing ban record file; starting fresh.');
      return;
    }
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      arr.forEach(id => previouslyBanned.add(String(id)));
      logDebug('[INFO] Loaded ban record:', previouslyBanned.size, 'entries');
    } else {
      logDebug('[WARN] Ban record file malformed; ignoring.');
    }
  } catch (err) {
    logDebug('[WARN] Failed to load ban record file:', err?.message ?? err);
  }
}

async function saveBanRecord() {
  try {
    const arr = Array.from(previouslyBanned);
    await fs.writeFile(BAN_RECORD_TEMP, JSON.stringify(arr, null, 2), 'utf8');
    await fs.rename(BAN_RECORD_TEMP, BAN_RECORD_FILE);
    logDebug('[INFO] Saved ban record:', arr.length, 'entries');
  } catch (err) {
    logDebug('[ERROR] Failed to save ban record:', err?.message ?? err);
  }
}

async function loadBanOffset() {
  try {
    const raw = await fs.readFile(BAN_OFFSET_FILE, 'utf8').catch(() => null);
    if (!raw) {
      logDebug('[INFO] No ban offset file; using 0.');
      banOffset = 0;
      return;
    }
    const data = JSON.parse(raw);
    if (typeof data === 'number') {
      banOffset = Math.trunc(data);
    } else if (data && typeof data.offset === 'number') {
      banOffset = Math.trunc(data.offset);
    } else {
      logDebug('[WARN] Ban offset file malformed; resetting to 0.');
      banOffset = 0;
    }
    logDebug('[INFO] Loaded ban offset:', banOffset);
  } catch (err) {
    logDebug('[WARN] Failed to load ban offset file:', err?.message ?? err);
    banOffset = 0;
  }
}

async function saveBanOffset() {
  try {
    // Save as a simple number for backward-compat/clarity
    await fs.writeFile(BAN_OFFSET_TEMP, JSON.stringify(banOffset, null, 2), 'utf8');
    await fs.rename(BAN_OFFSET_TEMP, BAN_OFFSET_FILE);
    logDebug('[INFO] Saved ban offset:', banOffset);
  } catch (err) {
    logDebug('[ERROR] Failed to save ban offset:', err?.message ?? err);
  }
}
// ---------- end persistence ----------

function isPreviouslyBanned(userId) {
  return previouslyBanned.has(String(userId));
}

async function markAsBanned(userId) {
  previouslyBanned.add(String(userId));
  await saveBanRecord();
  await updatePresence().catch(() => {});
}

async function unmarkAsBanned(userId) {
  previouslyBanned.delete(String(userId));
  await saveBanRecord();
  await updatePresence().catch(() => {});
}

function effectiveBanCount() {
  // number displayed: recorded bans + offset (offset can be negative)
  const raw = previouslyBanned.size + (Number.isInteger(banOffset) ? banOffset : 0);
  return raw < 0 ? 0 : raw;
}

async function updatePresence() {
  try {
    const count = effectiveBanCount();
    const statusText = `Banned (${count}) Minors`;
    if (!client.user) return;
    await client.user.setPresence({
      activities: [{ name: statusText }],
      status: 'online'
    });
    logDebug('[INFO] Updated presence to:', statusText);
  } catch (err) {
    logDebug('[WARN] Failed to update presence:', err?.message ?? err);
  }
}

// ---------- Startup ----------
client.once('ready', async () => {
  logDebug(`Logged in as ${client.user.tag}`);

  await loadBanRecord();
  await loadBanOffset();

  // attempt to seed ban-record from current guild bans if possible
  try {
    const guild = await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);
    if (guild) {
      logDebug('[INFO] Fetching current guild bans to seed ban-record...');
      try {
        const bans = await guild.bans.fetch();
        bans.forEach(b => {
          previouslyBanned.add(b.user.id);
        });
        await saveBanRecord();
        logDebug('[INFO] Seeded ban-record from guild bans:', previouslyBanned.size, 'entries');
      } catch (err) {
        logDebug('[WARN] Could not fetch guild bans to seed ban record:', err?.message ?? err);
      }
    } else {
      logDebug('[WARN] Target guild not found at startup (skipping ban seeding).');
    }
  } catch (err) {
    logDebug('[WARN] Error while seeding ban-record:', err?.message ?? err);
  }

  await updatePresence();
});

// ---------- Moderation logging ----------
async function maybeLogToModChannel(guild, user, message, error = null) {
  if (!MOD_LOG_CHANNEL_ID) return;
  try {
    const channel = await guild.channels.fetch(MOD_LOG_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      logDebug('[WARN] mod log channel not found or not text-based:', MOD_LOG_CHANNEL_ID);
      return;
    }

    const lines = [
      `**Moderation action**`,
      `User: ${user.tag} (${user.id})`,
      `Guild: ${guild.name} (${guild.id})`,
      `Note: ${message}`
    ];
    if (error) {
      lines.push(`Error: ${error?.code ?? 'N/A'} — ${String(error?.message ?? error)}`);
    }

    await channel.send(lines.join('\n'));
    logDebug('[INFO] Sent mod-log message');
  } catch (chErr) {
    logDebug('[WARN] Failed to send message to mod-log channel:', chErr);
  }
}

// ---------- Ban-on-role-add logic ----------
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (!newMember || !newMember.guild) return;
    if (newMember.guild.id !== TARGET_GUILD_ID) return;

    logDebug('[EVENT] guildMemberUpdate', `member=${newMember.user.tag}`, `id=${newMember.id}`);

    let freshOld = oldMember;
    let freshNew = newMember;
    try {
      freshNew = await newMember.guild.members.fetch(newMember.id);
      if (oldMember && oldMember.id) {
        freshOld = oldMember;
      }
    } catch (fetchErr) {
      logDebug('[WARN] failed to fetch fresh member objects:', fetchErr?.code ?? fetchErr);
    }

    const oldRoles = freshOld?.roles?.cache ? Array.from(freshOld.roles.cache.keys()) : [];
    const newRoles = freshNew?.roles?.cache ? Array.from(freshNew.roles.cache.keys()) : [];

    logDebug('[DEBUG] old roles:', oldRoles.join(', ') || 'none');
    logDebug('[DEBUG] new roles:', newRoles.join(', ') || 'none');

    const hadRoleBefore = oldRoles.includes(TARGET_ROLE_ID);
    const hasRoleNow = newRoles.includes(TARGET_ROLE_ID);

    const roleWasAdded = !hadRoleBefore && hasRoleNow;

    logDebug('[DEBUG] roleWasAdded:', roleWasAdded);

    if (!roleWasAdded) {
      return;
    }

    if (isPreviouslyBanned(freshNew.id)) {
      logDebug(`[INFO] Skipping ban for ${freshNew.user.tag} (${freshNew.id}) — user is in ban-record (was banned previously).`);
      await maybeLogToModChannel(freshNew.guild, freshNew.user, 'Skipped ban: user was previously banned (ban-record).');
      return;
    }

    const guild = freshNew.guild;
    const botMember = await guild.members.fetch(client.user.id);
    const botHasBanPerm = botMember.permissions.has(PermissionsBitField.Flags.BanMembers);
    logDebug('[DEBUG] botHasBanPerm:', botHasBanPerm);

    if (!botHasBanPerm) {
      logDebug('[ERROR] Missing BAN_MEMBERS permission. Aborting ban.');
      await maybeLogToModChannel(guild, freshNew.user, 'Attempted to ban but bot lacks BAN_MEMBERS permission.');
      return;
    }

    const botHighest = botMember.roles.highest?.position ?? 0;
    const targetHighest = freshNew.roles.highest?.position ?? 0;
    logDebug('[DEBUG] role positions -> bot:', botHighest, 'target:', targetHighest);

    if (botHighest <= targetHighest) {
      logDebug('[ERROR] Bot role is not higher than target user. Aborting ban.');
      await maybeLogToModChannel(guild, freshNew.user, 'Attempted to ban but bot role is below or equal to the target user\'s highest role.');
      return;
    }

    let dmSucceeded = false;
    let dmError = null;

    try {
      const dmChannel = await freshNew.createDM();
      await dmChannel.send(DM_MESSAGE);
      dmSucceeded = true;
      logDebug(`[INFO] DM sent to ${freshNew.user.tag}`);
      await wait(1000);
    } catch (err) {
      dmError = err;
      logDebug(`[WARN] Could not DM ${freshNew.user.tag}:`, err?.code ?? err?.message ?? err);
    }

    try {
      await freshNew.ban({ reason: BAN_REASON });
      logDebug(`[INFO] Banned ${freshNew.user.tag} (${freshNew.id}) — reason: ${BAN_REASON}`);

      // add to persistent ban record so we don't try to ban them again later
      await markAsBanned(freshNew.id);

      await maybeLogToModChannel(guild, freshNew.user, `Banned user for being under 16. DM sent: ${dmSucceeded}`, dmError);
    } catch (banErr) {
      logDebug(`[ERROR] Failed to ban ${freshNew.user.tag}:`, banErr);
      await maybeLogToModChannel(guild, freshNew.user, `Failed to ban user — see bot logs.`, banErr);
    }

  } catch (err) {
    logDebug('[FATAL] Unexpected error in guildMemberUpdate handler:', err);
  }
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- Admin message commands (simple prefix) ----------
const COMMAND_PREFIX = '!';

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.guild) return;
    if (!msg.content.startsWith(COMMAND_PREFIX)) return;

    const args = msg.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();

    // Only allow commands in TARGET_GUILD_ID (optional). If you want global admin control, remove this check.
    if (msg.guild.id !== TARGET_GUILD_ID) return;

    // Helper: check admin perms
    function isAdmin(member) {
      try {
        return member.permissions.has(PermissionsBitField.Flags.Administrator);
      } catch (e) {
        return false;
      }
    }

    if (command === 'addbans') {
      if (!isAdmin(msg.member)) {
        return msg.reply({ content: 'You must be a server Administrator to use this command.', allowedMentions: { repliedUser: false } });
      }
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n)) {
        return msg.reply({ content: 'Usage: `!addbans <integer>`', allowedMentions: { repliedUser: false } });
      }
      banOffset += Math.trunc(n);
      await saveBanOffset();
      await updatePresence();
      return msg.reply({ content: `Added ${Math.trunc(n)} to ban offset. New offset: ${banOffset}. Displayed count: ${effectiveBanCount()}`, allowedMentions: { repliedUser: false } });
    }

    if (command === 'setbans') {
      if (!isAdmin(msg.member)) {
        return msg.reply({ content: 'You must be a server Administrator to use this command.', allowedMentions: { repliedUser: false } });
      }
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n)) {
        return msg.reply({ content: 'Usage: `!setbans <integer>`', allowedMentions: { repliedUser: false } });
      }
      banOffset = Math.trunc(n);
      await saveBanOffset();
      await updatePresence();
      return msg.reply({ content: `Ban offset set to ${banOffset}. Displayed count: ${effectiveBanCount()}`, allowedMentions: { repliedUser: false } });
    }

    if (command === 'bancount') {
      if (!isAdmin(msg.member)) {
        // allow anyone to check? You asked admin-only for add; I'm returning simple info but gating to admin for privacy.
        return msg.reply({ content: `Displayed ban count: ${effectiveBanCount()}`, allowedMentions: { repliedUser: false } });
      }
      return msg.reply({ content: `Recorded bans: ${previouslyBanned.size}\nOffset: ${banOffset}\nDisplayed: ${effectiveBanCount()}`, allowedMentions: { repliedUser: false } });
    }

    // Optional: allow admin to remove a recorded ban id from record (unmark)
    if (command === 'unmarkban') {
      if (!isAdmin(msg.member)) {
        return msg.reply({ content: 'You must be a server Administrator to use this command.', allowedMentions: { repliedUser: false } });
      }
      const id = args[0];
      if (!id) {
        return msg.reply({ content: 'Usage: `!unmarkban <userId>`', allowedMentions: { repliedUser: false } });
      }
      if (!previouslyBanned.has(String(id))) {
        return msg.reply({ content: 'That ID is not in the ban-record.', allowedMentions: { repliedUser: false } });
      }
      await unmarkAsBanned(id);
      return msg.reply({ content: `Removed ${id} from ban-record. Displayed count: ${effectiveBanCount()}`, allowedMentions: { repliedUser: false } });
    }

  } catch (err) {
    logDebug('[WARN] messageCreate handler error:', err);
  }
});

// ---------- Error handling ----------
client.on('error', err => logDebug('[CLIENT ERROR]', err));
process.on('unhandledRejection', (reason, p) => logDebug('[UNHANDLED REJECTION]', reason, p));
process.on('uncaughtException', err => logDebug('[UNCAUGHT EXCEPTION]', err));

// ---------- Login ----------
if (!process.env.TOKEN) {
  console.error('Missing TOKEN environment variable - set process.env.TOKEN');
  process.exit(1);
}
client.login(process.env.TOKEN);

// Export for potential external usage (keeps compatibility with your original module)
module.exports = {
  isPreviouslyBanned,
  unmarkAsBanned,
  markAsBanned
};