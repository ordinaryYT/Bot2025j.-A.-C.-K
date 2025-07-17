require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const { Pool } = require('pg');

// --- Express keep-alive server for Render ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// --- PostgreSQL (RenderSQL) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Render
});

// Create birthdays table if it doesn't exist
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

// --- Discord Bot Client ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Slash Command: /setbirthday ---
const commands = [
  new SlashCommandBuilder()
    .setName('setbirthday')
    .setDescription('Set a user\'s birthday')
    .addStringOption(option =>
      option.setName('date')
        .setDescription('Your birthday (YYYY-MM-DD)')
        .setRequired(true)
    )
].map(cmd => cmd.toJSON());

// Register slash command
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

// --- Slash Command Logic ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setbirthday') {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const requiredRoleId = process.env.BIRTHDAY_ROLE_ID;

    if (!member.roles.cache.has(requiredRoleId)) {
      return interaction.reply({
        content: 'You do not have permission.',
        ephemeral: true
      });
    }

    const dateInput = interaction.options.getString('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return interaction.reply({
        content: 'Invalid date format. Please use YYYY-MM-DD.',
        ephemeral: true
      });
    }

    try {
      await pool.query(
        `INSERT INTO birthdays (user_id, birthday)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET birthday = EXCLUDED.birthday`,
        [interaction.user.id, dateInput]
      );
      await interaction.reply(`Birthday saved: ${dateInput}`);
    } catch (err) {
      console.error("Error saving birthday:", err);
      await interaction.reply({
        content: 'error saving birthday.',
        ephemeral: true
      });
    }
  }
});

// --- Birthday Checker ---
const checkBirthdays = async () => {
  const today = new Date().toISOString().slice(5, 10); // MM-DD

  try {
    const res = await pool.query(`
      SELECT user_id FROM birthdays
      WHERE TO_CHAR(birthday, 'MM-DD') = $1
    `, [today]);

    if (res.rows.length === 0) return;

    const channel = await client.channels.fetch(process.env.BIRTHDAY_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error('Birthday channel not found .');
      return;
    }

    for (const row of res.rows) {
      const mention = `<@${row.user_id}>`;
      channel.send(`Happy birthday ${mention}!`);
    }
  } catch (err) {
    console.error('Error checking birthdays:', err);
  }
};

// --- Schedule Birthday Check ---
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
    checkBirthdays(); // Run first time at midnight
    setInterval(checkBirthdays, 24 * 60 * 60 * 1000); // Every 24 hours
  }, millisUntilMidnight);
});

// --- Start Bot ---
client.login(process.env.DISCORD_TOKEN);
