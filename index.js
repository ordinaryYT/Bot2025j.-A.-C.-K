// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  // Create tables if not exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS birthdays (
      user_id TEXT PRIMARY KEY,
      birthday DATE NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reaction_roles (
      message_id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      emoji TEXT NOT NULL
    );
  `);
})();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName('setbirthday')
    .setDescription('Set a user\'s birthday')
    .addStringOption(option =>
      option.setName('date').setDescription('Your birthday (YYYY-MM-DD)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('clearmessages')
    .setDescription('Delete messages in this channel')
    .addIntegerOption(option =>
      option.setName('amount').setDescription('Number of messages to delete').setRequired(false))
    .addBooleanOption(option =>
      option.setName('all').setDescription('Delete all messages in the channel').setRequired(false))
    .addUserOption(option =>
      option.setName('user').setDescription('Only delete messages from this user').setRequired(false)),

  new SlashCommandBuilder()
    .setName('createreactrole')
    .setDescription('Create a reaction role message')
    .addStringOption(opt =>
      opt.setName('emoji').setDescription('Emoji for reaction').setRequired(true))
    .addStringOption(opt =>
      opt.setName('roleid').setDescription('Role ID to give').setRequired(true))
    .addStringOption(opt =>
      opt.setName('text').setDescription('Optional message text').setRequired(false))
    .addStringOption(opt =>
      opt.setName('channelid').setDescription('Channel ID to send embed to').setRequired(true))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
})();

const reactionRoles = new Map();

async function loadReactionRoles() {
  try {
    const res = await pool.query('SELECT message_id, role_id, emoji FROM reaction_roles');
    for (const row of res.rows) {
      reactionRoles.set(row.message_id, { roleId: row.role_id, emoji: row.emoji });
    }
    console.log(`Loaded ${reactionRoles.size} reaction role mappings from DB.`);
  } catch (err) {
    console.error('Failed to load reaction roles:', err);
  }
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadReactionRoles();

  checkBirthdays();
  const now = new Date();
  const millisUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => {
    checkBirthdays();
    setInterval(checkBirthdays, 86400000);
  }, millisUntilMidnight);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // Check if user has birthday role
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const hasRole = member.roles.cache.has(process.env.BIRTHDAY_ROLE_ID);
  if (!hasRole) return interaction.reply({ content: 'error', ephemeral: true });

  if (interaction.commandName === 'setbirthday') {
    const dateInput = interaction.options.getString('date');
    if (!/\d{4}-\d{2}-\d{2}/.test(dateInput)) {
      return interaction.reply({ content: 'error', ephemeral: true });
    }
    try {
      await pool.query(
        `INSERT INTO birthdays (user_id, birthday)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET birthday = EXCLUDED.birthday`,
        [interaction.user.id, dateInput]
      );
      return interaction.reply({ content: 'Birthday saved.' });
    } catch {
      return interaction.reply({ content: 'error', ephemeral: true });
    }
  }

  if (interaction.commandName === 'clearmessages') {
    const amount = interaction.options.getInteger('amount');
    const deleteAll = interaction.options.getBoolean('all');
    const targetUser = interaction.options.getUser('user');
    const channel = interaction.channel;

    if (!channel.isTextBased()) return interaction.reply({ content: 'error', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    try {
      let deleted = 0;
      let remaining = deleteAll ? Infinity : (amount || 100);
      let lastId = null;

      while (remaining > 0) {
        const options = { limit: Math.min(remaining, 100) };
        if (lastId) options.before = lastId;
        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;

        const filtered = messages.filter(msg => !targetUser || msg.author.id === targetUser.id);

        if (filtered.size === 0) break;

        for (const msg of filtered.values()) {
          if (remaining <= 0) break;
          try {
            await msg.delete();
            deleted++;
            remaining--;
            lastId = msg.id;
            // Discord rate limit safety delay:
            await new Promise(r => setTimeout(r, 1100));
          } catch {}
        }

        if (filtered.size < messages.size) {
          // Some messages filtered out; continue fetching older messages
          lastId = messages.last().id;
        }
      }

      await interaction.editReply({ content: `Deleted ${deleted} messages.` });
    } catch {
      await interaction.editReply({ content: 'error' });
    }
  }

  if (interaction.commandName === 'createreactrole') {
    const emoji = interaction.options.getString('emoji');
    const roleId = interaction.options.getString('roleid');
    const text = interaction.options.getString('text') || 'React to get the role!';
    const channelId = interaction.options.getString('channelid');

    const targetChannel = await client.channels.fetch(channelId).catch(() => null);
    if (!targetChannel || !targetChannel.isTextBased()) {
      return interaction.reply({ content: 'error', ephemeral: true });
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle('Reaction Role')
        .setDescription(text)
        .setColor('#00AAFF');

      const msg = await targetChannel.send({ embeds: [embed] });
      await msg.react(emoji);

      // Save to DB
      await pool.query(
        `INSERT INTO reaction_roles (message_id, role_id, emoji) VALUES ($1, $2, $3)
         ON CONFLICT (message_id) DO UPDATE SET role_id = EXCLUDED.role_id, emoji = EXCLUDED.emoji`,
        [msg.id, roleId, emoji]
      );

      reactionRoles.set(msg.id, { roleId, emoji });

      return interaction.reply({ content: 'Reaction role message created.', ephemeral: true });
    } catch {
      return interaction.reply({ content: 'error', ephemeral: true });
    }
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }
  const roleData = reactionRoles.get(reaction.message.id);
  if (!roleData) return;

  // Check emoji by name or identifier (for custom emojis)
  if (reaction.emoji.name !== roleData.emoji && reaction.emoji.identifier !== roleData.emoji) return;

  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  try {
    await member.roles.add(roleData.roleId);
  } catch {}
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }
  const roleData = reactionRoles.get(reaction.message.id);
  if (!roleData) return;

  if (reaction.emoji.name !== roleData.emoji && reaction.emoji.identifier !== roleData.emoji) return;

  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  try {
    await member.roles.remove(roleData.roleId);
  } catch {}
});

const checkBirthdays = async () => {
  const today = new Date().toISOString().slice(5, 10); // MM-DD
  try {
    const res = await pool.query(`
      SELECT user_id FROM birthdays
      WHERE TO_CHAR(birthday, 'MM-DD') = $1
    `, [today]);
    if (res.rows.length === 0) return;
    const channel = await client.channels.fetch(process.env.BIRTHDAY_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;
    for (const row of res.rows) {
      await channel.send(`Happy birthday <@${row.user_id}>!`);
    }
  } catch (err) {
    console.error('Birthday check error:', err);
  }
};

client.login(process.env.DISCORD_TOKEN);
