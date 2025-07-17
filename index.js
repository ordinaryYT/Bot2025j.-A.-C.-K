// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS birthdays (
      user_id TEXT PRIMARY KEY,
      birthday DATE NOT NULL
    );
  `);
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

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
      option.setName('user').setDescription('Only delete messages from this user').setRequired(false))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
})();

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
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
      return interaction.reply({ content: `Birthday saved.` });
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

    await interaction.reply({ content: 'Type "confirm" to start deletion.', ephemeral: true });

    const filter = m => m.author.id === interaction.user.id && m.content.toLowerCase() === 'confirm';
    const collected = await channel.awaitMessages({ filter, max: 1, time: 15000, errors: ['time'] }).catch(() => null);
    if (!collected || collected.size === 0) return interaction.followUp({ content: 'error', ephemeral: true });

    try {
      let deleted = 0;
      let remaining = amount || Infinity;
      let fetched;

      do {
        fetched = await channel.messages.fetch({ limit: 100 });
        const messages = Array.from(fetched.values())
          .filter(msg => !targetUser || msg.author.id === targetUser.id);

        for (const msg of messages) {
          if (remaining <= 0) break;
          try {
            await msg.delete();
            deleted++;
            remaining--;
            await new Promise(r => setTimeout(r, 1100));
          } catch {}
        }
      } while (fetched.size > 0 && remaining > 0);

      await interaction.followUp({ content: `Deleted ${deleted} messages.`, ephemeral: true });
    } catch {
      await interaction.followUp({ content: 'error', ephemeral: true });
    }
  }
});

const checkBirthdays = async () => {
  const today = new Date().toISOString().slice(5, 10);
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
