import { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, ChannelType } from 'discord.js';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';
dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

const BIRTHDAY_ROLE = 'BirthdayRoleID'; // Replace with your birthday role ID
const BIRTHDAY_CHANNEL = 'BirthdayChannelID'; // Replace with your birthday message channel ID
const PORT = process.env.PORT || 3000;

let db;

async function initDB() {
  db = await open({
    filename: './birthdaybot.db',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS birthdays (
      userId TEXT PRIMARY KEY,
      date TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS reactroles (
      messageId TEXT PRIMARY KEY,
      roleId TEXT,
      emoji TEXT
    );
  `);
}

// Register slash commands
import { SlashCommandBuilder } from '@discordjs/builders';

const commands = [
  new SlashCommandBuilder()
    .setName('setbirthday')
    .setDescription('Set a user\'s birthday')
    .addStringOption(option =>
      option.setName('date')
        .setDescription('Birthday in YYYY-MM-DD format')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('clearmessages')
    .setDescription('Delete messages in this channel')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Number of messages to delete')
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName('all')
        .setDescription('Delete all messages in channel')
        .setRequired(false))
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Delete messages from this user only')
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('createreactrole')
    .setDescription('Create a reaction role message')
    .addStringOption(opt =>
      opt.setName('emoji')
        .setDescription('Emoji for reaction')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('roleid')
        .setDescription('Role ID to give')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('text')
        .setDescription('Optional embed text')
        .setRequired(false))
    .addChannelOption(opt =>
      opt.setName('channelid')
        .setDescription('Channel to send embed to')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands.');
    // Change guild ID to your server ID for testing, or register globally
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
}

// Helper: check if member has birthday role
function hasBirthdayRole(member) {
  return member.roles.cache.has(BIRTHDAY_ROLE);
}

// Listen for reaction role add/remove events
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    const reactRole = await db.get('SELECT roleId FROM reactroles WHERE messageId = ?', reaction.message.id);
    if (!reactRole) return;
    if (reaction.emoji.name === reactRole.emoji || reaction.emoji.id === reactRole.emoji) {
      const guild = reaction.message.guild;
      if (!guild) return;
      const member = await guild.members.fetch(user.id);
      if (member) await member.roles.add(reactRole.roleId).catch(() => {});
    }
  } catch { }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    const reactRole = await db.get('SELECT roleId FROM reactroles WHERE messageId = ?', reaction.message.id);
    if (!reactRole) return;
    if (reaction.emoji.name === reactRole.emoji || reaction.emoji.id === reactRole.emoji) {
      const guild = reaction.message.guild;
      if (!guild) return;
      const member = await guild.members.fetch(user.id);
      if (member) await member.roles.remove(reactRole.roleId).catch(() => {});
    }
  } catch { }
});

// Birthday check every day at midnight UTC
import cron from 'node-cron';
cron.schedule('0 0 * * *', async () => {
  const today = new Date().toISOString().slice(5, 10); // MM-DD
  const rows = await db.all('SELECT userId FROM birthdays WHERE substr(date, 6, 5) = ?', today);
  const channel = await client.channels.fetch(BIRTHDAY_CHANNEL).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  for (const row of rows) {
    channel.send(`Happy birthday <@${row.userId}>!`).catch(() => {});
  }
});

// Command handling
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, member, guild } = interaction;

  if (!member || !guild) {
    await interaction.reply({ content: 'error', ephemeral: true });
    return;
  }

  // Only allow birthday role to run commands
  if (!hasBirthdayRole(member)) {
    await interaction.reply({ content: 'error', ephemeral: true });
    return;
  }

  if (commandName === 'setbirthday') {
    const date = interaction.options.getString('date');
    // Basic validation for YYYY-MM-DD format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      await interaction.reply({ content: 'error', ephemeral: true });
      return;
    }
    try {
      await db.run('INSERT OR REPLACE INTO birthdays (userId, date) VALUES (?, ?)', interaction.user.id, date);
      await interaction.reply('Birthday set successfully!');
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  } else if (commandName === 'clearmessages') {
    const amount = interaction.options.getInteger('amount');
    const all = interaction.options.getBoolean('all');
    const user = interaction.options.getUser('user');

    try {
      let fetchedMessages;
      if (all) {
        // Delete all messages in channel with no confirmation
        let lastId;
        do {
          fetchedMessages = await interaction.channel.messages.fetch({ limit: 100, before: lastId });
          if (user) {
            const filtered = fetchedMessages.filter(m => m.author.id === user.id);
            await interaction.channel.bulkDelete(filtered, true);
          } else {
            await interaction.channel.bulkDelete(fetchedMessages, true);
          }
          lastId = fetchedMessages.size ? fetchedMessages.last().id : null;
        } while (fetchedMessages.size === 100);
      } else if (amount) {
        if (user) {
          fetchedMessages = await interaction.channel.messages.fetch({ limit: amount + 10 });
          const filtered = fetchedMessages.filter(m => m.author.id === user.id).first(amount);
          await interaction.channel.bulkDelete(filtered, true);
        } else {
          await interaction.channel.bulkDelete(amount, true);
        }
      } else {
        await interaction.reply({ content: 'error', ephemeral: true });
        return;
      }
      await interaction.reply({ content: 'Messages deleted!', ephemeral: true });
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  } else if (commandName === 'createreactrole') {
    const emoji = interaction.options.getString('emoji');
    const roleId = interaction.options.getString('roleid');
    const text = interaction.options.getString('text');
    const channel = interaction.options.getChannel('channelid');

    if (!channel.isTextBased()) {
      await interaction.reply({ content: 'error', ephemeral: true });
      return;
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle('React to get a role')
        .setDescription(text || `React with ${emoji} to get the role.`)
        .setColor('#00AAFF');

      const msg = await channel.send({ embeds: [embed] });
      await msg.react(emoji);

      await db.run('INSERT OR REPLACE INTO reactroles (messageId, roleId, emoji) VALUES (?, ?, ?)', msg.id, roleId, emoji);

      await interaction.reply({ content: 'Reaction role message created!', ephemeral: true });
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  }
});

// Catch client errors to prevent crashes
client.on('error', () => { /* silently ignore errors */ });
client.on('warn', () => { /* ignore warnings */ });

(async () => {
  await initDB();
  await registerCommands();
  client.login(process.env.BOT_TOKEN);
})();

// For Render or similar platforms keep alive
import http from 'http';
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT);

console.log(`Bot is running on port ${PORT}`);
