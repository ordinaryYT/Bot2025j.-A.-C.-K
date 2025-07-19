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
      
      CREATE TABLE IF NOT EXISTS reaction_roles (
        message_id TEXT,
        emoji TEXT,
        role_id TEXT,
        PRIMARY KEY (message_id, emoji)
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
    .setDescription('delete all messages in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('addorremoverole')
    .setDescription('Add or remove a role')
    .addStringOption(option =>
      option.setName('action').setDescription('add/remove').setRequired(true))
    .addStringOption(option =>
      option.setName('userid').setDescription('User ID').setRequired(true))
    .addStringOption(option =>
      option.setName('roleid').setDescription('Role ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('set a role with reaction')
    .addStringOption(option =>
      option.setName('message').setDescription('The message to display').setRequired(true))
    .addStringOption(option =>
      option.setName('emoji1').setDescription('First emoji').setRequired(true))
    .addStringOption(option =>
      option.setName('role1').setDescription('Role ID for first emoji').setRequired(true))
    .addStringOption(option =>
      option.setName('emoji2').setDescription('Second emoji').setRequired(false))
    .addStringOption(option =>
      option.setName('role2').setDescription('Role ID for second emoji').setRequired(false))
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
    const dateInput = interaction.options.getString('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', ephemeral: true });
    }

    try {
      await pool.query(`
        INSERT INTO birthdays (user_id, birthday)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET birthday = EXCLUDED.birthday
      `, [interaction.user.id, dateInput]);
      await interaction.reply(`Birthday date saved as: ${dateInput}`);
    } catch {
      await interaction.reply({ content: 'Error ', ephemeral: true });
    }
  }

  if (interaction.commandName === 'clearchannel') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'You dont have permission.', ephemeral: true });
    }

    try {
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      await interaction.channel.bulkDelete(messages, true);
      await interaction.reply({ content: 'Messages deleted.', ephemeral: true });
    } catch {
      await interaction.reply({ content: 'Error', ephemeral: true });
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
      await interaction.reply({ content: 'Error', ephemeral: true });
    }
  }

  if (interaction.commandName === 'setupreactions') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'You dont have permission', ephemeral: true });
    }

    try {
      const messageText = interaction.options.getString('message');
      const emoji1 = interaction.options.getString('emoji1');
      const role1 = interaction.options.getString('role1');
      const emoji2 = interaction.options.getString('emoji2');
      const role2 = interaction.options.getString('role2');

      const message = await interaction.channel.send(messageText);
      await message.react(emoji1);
      if (emoji2 && role2) await message.react(emoji2);

      await pool.query(`
        INSERT INTO reaction_roles (message_id, emoji, role_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (message_id, emoji) DO UPDATE SET role_id = EXCLUDED.role_id
      `, [message.id, emoji1, role1]);

      if (emoji2 && role2) {
        await pool.query(`
          INSERT INTO reaction_roles (message_id, emoji, role_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (message_id, emoji) DO UPDATE SET role_id = EXCLUDED.role_id
        `, [message.id, emoji2, role2]);
      }

      await interaction.reply({ content: 'created', ephemeral: true });
    } catch (error) {
      console.error(' error', error);
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
    console.error('Error');
  }
};

// --- Reaction Roles ---
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const emojiKey = reaction.emoji.name;

    const res = await pool.query(
      'SELECT role_id FROM reaction_roles WHERE message_id = $1 AND emoji = $2',
      [reaction.message.id, emojiKey]
    );

    if (res.rows.length > 0) {
      const member = await reaction.message.guild.members.fetch(user.id);
      await member.roles.add(res.rows[0].role_id);
      console.log(`Role added to ${user.tag}`);
    }
  } catch (error) {
    console.error('Error ', error);
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const emojiKey = reaction.emoji.name;

    const res = await pool.query(
      'SELECT role_id FROM reaction_roles WHERE message_id = $1 AND emoji = $2',
      [reaction.message.id, emojiKey]
    );

    if (res.rows.length > 0) {
      const member = await reaction.message.guild.members.fetch(user.id);
      await member.roles.remove(res.rows[0].role_id);
      console.log(`Role removed from ${user.tag}`);
    }
  } catch (error) {
    console.error('Error removing role:', error);
  }
});

// --- Welcome Message ---
client.on(Events.GuildMemberAdd, async member => {
  const channel = await client.channels.fetch(process.env.WELCOME_CHANNEL_ID);
  if (channel && channel.isTextBased()) {
    channel.send(`Welcome to the server, <@${member.id}>! `);
  }
});

// --- Bot Ready ---
client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  checkBirthdays();

  const now = new Date();
  const millisUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  setTimeout(() => {
    checkBirthdays();
    setInterval(checkBirthdays, 24 * 60 * 60 * 1000);
  }, millisUntilMidnight);
});

client.login(process.env.DISCORD_TOKEN);
