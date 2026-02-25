const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

const TARGET_GUILD_ID = "1456307355959689373";
const TARGET_ROLE_ID = "1475987720248627260";


client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (newMember.guild.id !== TARGET_GUILD_ID) return;

    const roleWasAdded =
        !oldMember.roles.cache.has(TARGET_ROLE_ID) &&
        newMember.roles.cache.has(TARGET_ROLE_ID);

    if (roleWasAdded) {
        try {
            await newMember.ban({ reason: "Received restricted role" });
            console.log(`Banned ${newMember.user.tag}`);
        } catch (err) {
            console.error(err);
        }
    }
});

client.login(process.env.TOKEN);