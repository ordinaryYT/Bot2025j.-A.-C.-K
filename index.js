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
      DROP TABLE IF EXISTS reaction_roles;
      
      CREATE TABLE IF NOT EXISTS birthdays (
        user_id TEXT PRIMARY KEY,
        birthday DATE NOT NULL
      );
      
      CREATE TABLE reaction_roles (
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
    .addStringOption(option => option.setName('message').setDescription('The message to display').setRequired(true))
    .addStringOption(option => option.setName('emoji1').setDescription('Emoji 1').setRequired(true))
    .addStringOption(option => option.setName('role1').setDescription('Role ID for emoji 1').setRequired(true))
    .addStringOption(option => option.setName('emoji2').setDescription('Emoji 2').setRequired(false))
    .addStringOption(option => option.setName('role2').setDescription('Role ID for emoji 2').setRequired(false))
    .addStringOption(option => option.setName('emoji3').setDescription('Emoji 3').setRequired(false))
    .addStringOption(option => option.setName('role3').setDescription('Role ID for emoji 3').setRequired(false))
    .addStringOption(option => option.setName('emoji4').setDescription('Emoji 4').setRequired(false))
    .addStringOption(option => option.setName('role4').setDescription('Role ID for emoji 4').setRequired(false))
    .addStringOption(option => option.setName('emoji5').setDescription('Emoji 5').setRequired(false))
    .addStringOption(option => option.setName('role5').setDescription('Role ID for emoji 5').setRequired(false))
    .addStringOption(option => option.setName('emoji6').setDescription('Emoji 6').setRequired(false))
    .addStringOption(option => option.setName('role6').setDescription('Role ID for emoji 6').setRequired(false))
    .addStringOption(option => option.setName('emoji7').setDescription('Emoji 7').setRequired(false))
    .addStringOption(option => option.setName('role7').setDescription('Role ID for emoji 7').setRequired(false))
    .addStringOption(option => option.setName('emoji8').setDescription('Emoji 8').setRequired(false))
    .addStringOption(option => option.setName('role8').setDescription('Role ID for emoji 8').setRequired(false))
    .addStringOption(option => option.setName('emoji9').setDescription('Emoji 9').setRequired(false))
    .addStringOption(option => option.setName('role9').setDescription('Role ID for emoji 9').setRequired(false))
    .addStringOption(option => option.setName('emoji10').setDescription('Emoji 10').setRequired(false))
    .addStringOption(option => option.setName('role10').setDescription('Role ID for emoji 10').setRequired(false))
    .addStringOption(option => option.setName('emoji11').setDescription('Emoji 11').setRequired(false))
    .addStringOption(option => option.setName('role11').setDescription('Role ID for emoji 11').setRequired(false))
    .addStringOption(option => option.setName('emoji12').setDescription('Emoji 12').setRequired(false))
    .addStringOption(option => option.setName('role12').setDescription('Role ID for emoji 12').setRequired(false))
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

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setbirthday') {
    const dateInput = interaction.options.getString('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', flags: 64 });
    }

    try {
      await pool.query(`
        INSERT INTO birthdays (user_id, birthday)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET birthday = EXCLUDED.birthday
      `, [interaction.user.id, dateInput]);
      await interaction.reply({ content: `Birthday date saved as: ${dateInput}`, flags: 64 });
    } catch {
      await interaction.reply({ content: 'Error saving birthday.', flags: 64 });
    }
  }

  if (interaction.commandName === 'clearchannel') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'You don’t have permission.', flags: 64 });
    }

    try {
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      await interaction.channel.bulkDelete(messages, true);
      await interaction.reply({ content: 'Messages deleted.', flags: 64 });
    } catch {
      await interaction.reply({ content: 'Error clearing messages.', flags: 64 });
    }
  }

  if (interaction.commandName === 'addorremoverole') {
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
        await interaction.reply({ content: 'Invalid action.', flags: 64 });
      }
    } catch {
      await interaction.reply({ content: 'Error modifying role.', flags: 64 });
    }
  }

  if (interaction.commandName === 'reactionrole') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'You don’t have permission.', flags: 64 });
    }
//test
    try {
      const messageText = interaction.options.getString('message');
      const message = await interaction.channel.send(messageText);

      for (let i = 1; i <= 12; i++) {
        const emoji = interaction.options.getString(`emoji${i}`);
        const role = interaction.options.getString(`role${i}`);

        if (emoji && role) {
          await message.react(emoji);
          await pool.query(`
            INSERT INTO reaction_roles (message_id, emoji, role_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (message_id, emoji) DO UPDATE SET role_id = EXCLUDED.role_id
          `, [message.id, emoji, role]);
        }
      }

      await interaction.reply({ content: 'Reaction role message created.', flags: 64 });
    } catch (error) {
      console.error('Error setting up reaction roles:', error);
      await interaction.reply({ content: 'Error setting up reaction roles.', flags: 64 });
    }
  }
});

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
    }
  } catch (error) {
    console.error('Error assigning role:', error);
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
    }
  } catch (error) {
    console.error('Error removing role:', error);
  }
});

client.on(Events.GuildMemberAdd, async member => {
  const channel = await client.channels.fetch(process.env.WELCOME_CHANNEL_ID);
  if (channel && channel.isTextBased()) {
    channel.send(`Welcome to the server, <@${member.id}>!`);
  }
});

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
