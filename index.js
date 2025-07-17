require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, Events, Partials } = require('discord.js');
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
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS birthdays (
        user_id TEXT PRIMARY KEY,
        birthday DATE NOT NULL
      );
    `);
    console.log("Database initialized.");
  } catch (err) {
    console.error("Error initializing database:", err);
  }
})();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const commands = [
  new SlashCommandBuilder()
    .setName('setbirthday')
    .setDescription('Set your birthday')
    .addStringOption(option =>
      option.setName('date')
        .setDescription('Birthday (YYYY-MM-DD)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('clearchannel')
    .setDescription('Clear messages in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('modifyrole')
    .setDescription('Add or remove a role')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('add/remove')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('userid')
        .setDescription('users id')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('roleid')
        .setDescription('Role ID')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

// --- Slash Command Handler ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setbirthday') {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const requiredRoleId = process.env.BIRTHDAY_ROLE_ID;

    if (!member.roles.cache.has(requiredRoleId)) {
      return interaction.reply({ content: 'error', ephemeral: true });
    }

    const dateInput = interaction.options.getString('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return interaction.reply({ content: 'error', ephemeral: true });
    }

    try {
      await pool.query(
        `INSERT INTO birthdays (user_id, birthday)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET birthday = EXCLUDED.birthday`,
        [interaction.user.id, dateInput]
      );
      await interaction.reply(`Birthday saved: ${dateInput}`);
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  }

  if (interaction.commandName === 'clearchannel') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'error', ephemeral: true });
    }

    try {
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      await interaction.channel.bulkDelete(messages, true);
      await interaction.reply({ content: 'Messages deleted.', ephemeral: true });
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  }

  if (interaction.commandName === 'modifyrole') {
    const action = interaction.options.getString('action');
    const userId = interaction.options.getString('userid');
    const roleId = interaction.options.getString('roleid');

    try {
      const member = await interaction.guild.members.fetch(userId);
      if (action === 'add') {
        await member.roles.add(roleId);
        await interaction.reply(`Added role to <@${userId}>`);
      } else if (action === 'remove') {
        await member.roles.remove(roleId);
        await interaction.reply(`Removed role from <@${userId}>`);
      } else {
        await interaction.reply({ content: 'error', ephemeral: true });
      }
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  }
});

// --- Birthday Check ---
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
      const mention = `<@${row.user_id}>`;
      channel.send(`Happy birthday ${mention}! `);
    }
  } catch {
    console.error('error');
  }
};

// --- Reaction Roles ---
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (reaction.partial) await reaction.fetch();
  const roleMap = {
    '✅': 'ROLE_ID_1',
    '❌': 'ROLE_ID_2'
  };
  const roleId = roleMap[reaction.emoji.name];
  if (!roleId) return;

  const member = await reaction.message.guild.members.fetch(user.id);
  member.roles.add(roleId).catch(() => {});
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (reaction.partial) await reaction.fetch();
  const roleMap = {
    '✅': 'ROLE_ID_1',
    '❌': 'ROLE_ID_2'
  };
  const roleId = roleMap[reaction.emoji.name];
  if (!roleId) return;

  const member = await reaction.message.guild.members.fetch(user.id);
  member.roles.remove(roleId).catch(() => {});
});

// --- Welcome Message ---
client.on(Events.GuildMemberAdd, async member => {
  const channel = await client.channels.fetch(process.env.WELCOME_CHANNEL_ID);
  if (channel && channel.isTextBased()) {
    channel.send(`Welcome to the server, <@${member.id}>! 🎉`);
  }
});

// --- Bot Ready ---
client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  checkBirthdays();

  const now = new Date();
  const millisUntilMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  ).getTime() - now.getTime();

  setTimeout(() => {
    checkBirthdays();
    setInterval(checkBirthdays, 24 * 60 * 60 * 1000);
  }, millisUntilMidnight);
});

client.login(process.env.DISCORD_TOKEN);
