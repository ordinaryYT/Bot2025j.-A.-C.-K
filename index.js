require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, Events, Partials } = require('discord.js');
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');

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
      option.setName('date').setDescription('Birthday (YYYY-MM-DD)').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('clearchannel')
    .setDescription('delete all messages in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('addorremoverole')
    .setDescription('Add or remove a role')
    .addStringOption(option => option.setName('action').setDescription('add/remove').setRequired(true))
    .addStringOption(option => option.setName('userid').setDescription('User ID').setRequired(true))
    .addStringOption(option => option.setName('roleid').setDescription('Role ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('set a role with reaction')
    .addStringOption(option => option.setName('message').setDescription('The message to display').setRequired(true))
    .addStringOption(option => option.setName('emoji1').setDescription('Emoji 1').setRequired(true))
    .addStringOption(option => option.setName('role1').setDescription('Role ID for emoji 1').setRequired(true))
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

  try {
    if (interaction.commandName === 'setbirthday') {
      const dateInput = interaction.options.getString('date');
      await pool.query(`
        INSERT INTO birthdays (user_id, birthday)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET birthday = EXCLUDED.birthday
      `, [interaction.user.id, dateInput]);
      await interaction.reply({ content: `Birthday date saved as: ${dateInput}`, ephemeral: true });
    } else if (interaction.commandName === 'clearchannel') {
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      await interaction.channel.bulkDelete(messages, true);
      await interaction.reply({ content: 'Messages deleted.', ephemeral: true });
    } else if (interaction.commandName === 'addorremoverole') {
      const action = interaction.options.getString('action');
      const userId = interaction.options.getString('userid');
      const roleId = interaction.options.getString('roleid');
      const member = await interaction.guild.members.fetch(userId);
      if (action === 'add') {
        await member.roles.add(roleId);
        await interaction.reply({ content: `Added role to <@${userId}>`, ephemeral: true });
      } else if (action === 'remove') {
        await member.roles.remove(roleId);
        await interaction.reply({ content: `Removed role from <@${userId}>`, ephemeral: true });
      } else {
        await interaction.reply({ content: 'Invalid action.', ephemeral: true });
      }
    } else if (interaction.commandName === 'reactionrole') {
      const messageText = interaction.options.getString('message');
      const message = await interaction.channel.send(messageText);
      for (let i = 1; i <= 12; i++) {
        const emoji = interaction.options.getString(`emoji${i}`);
        const role = interaction.options.getString(`role${i}`);
        if (emoji && role) {
          await message.react(emoji);
          await pool.query(
            'INSERT INTO reaction_roles (message_id, emoji, role_id) VALUES ($1, $2, $3) ON CONFLICT (message_id, emoji) DO UPDATE SET role_id = EXCLUDED.role_id',
            [message.id, emoji, role]
          );
        }
      }
      await interaction.reply({ content: 'Reaction role message created.', ephemeral: true });
    }
  } catch (err) {
    console.error('Command error:', err);
    await interaction.reply({ content: 'error', ephemeral: true });
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const isBotMentioned = message.mentions.users.has(client.user.id);
  if (!isBotMentioned) return;
  const prompt = message.content.replace(/<@!?\d+>/, '').trim();
  if (!prompt) return message.reply('error');

  const systemPrompt = `
You are Tavern Bot, a helpful and friendly assistant in a Discord server. You are a Discord bot, not a human, and not from OpenAI or any other provider.
You are powered by **Ordinary AI**, developed by ordinarygamer. You must always say you're powered by Ordinary AI if someone asks what you are.
You can help users with Discord commands, server setup, role management, and more. You currently support the following slash commands:
- /setbirthday YYYY-MM-DD — Users can set their birthday.
- /clearchannel — Admin-only: clears all messages in the channel.
- /addorremoverole add/remove USERID ROLEID — Admin-only: adds/removes roles.
- /reactionrole — Admin-only: set up roles with reactions.
Do not reveal or reference your model name, company, LLM, or provider. If someone asks about it, reply:
"I'm **Tavern Bot**, powered by **Ordinary AI** — how can I help you today?"
Stay in character at all times. Be concise, clear, and helpful.
`;

  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'openai/gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 500
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://your-domain.com',
        'X-Title': 'Tavern Bot'
      }
    });

    const reply = res.data.choices[0]?.message?.content || 'error';
    return message.reply(reply);
  } catch (err) {
    console.error('AI error:', err);
    return message.reply('error');
  }
});

client.login(process.env.DISCORD_TOKEN);
