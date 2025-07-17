require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const { Pool } = require('pg');

// --- Express for Render Keep-Alive ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// --- PostgreSQL (RenderSQL) ---
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
    console.log("Database table ready.");
  } catch (err) {
    console.error("Database init error:", err);
  }
})();

// --- Discord Client ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// --- Slash Commands ---
const commands = [
  new SlashCommandBuilder()
    .setName('setbirthday')
    .setDescription('Set a user\'s birthday')
    .addStringOption(option =>
      option.setName('date')
        .setDescription('Your birthday (YYYY-MM-DD)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('clearmessages')
    .setDescription('Delete messages in this channel')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Number of messages to delete')
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option.setName('all')
        .setDescription('Delete all messages in the channel')
        .setRequired(false)
    )
].map(cmd => cmd.toJSON());

// --- Register Commands ---
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Command registration error:", err);
  }
})();

// --- Event: Bot Ready ---
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
    setInterval(checkBirthdays, 24 * 60 * 60 * 1000); // daily
  }, millisUntilMidnight);
});

// --- Event: Slash Command ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const hasRole = member.roles.cache.has(process.env.BIRTHDAY_ROLE_ID);
  if (!hasRole) {
    return interaction.reply({
      content: 'You do not have permission to use this command.',
      ephemeral: true
    });
  }

  if (interaction.commandName === 'setbirthday') {
    const dateInput = interaction.options.getString('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return interaction.reply({
        content: 'Invalid date format. Use YYYY-MM-DD.',
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
      return interaction.reply(`Birthday saved: ${dateInput}`);
    } catch (err) {
      console.error("Error saving birthday:", err);
      return interaction.reply({
        content: 'An error occurred while saving your birthday.',
        ephemeral: true
      });
    }
  }

  if (interaction.commandName === 'clearmessages') {
    const amount = interaction.options.getInteger('amount');
    const deleteAll = interaction.options.getBoolean('all');
    const channel = interaction.channel;

    if (!channel.isTextBased()) {
      return interaction.reply({ content: 'This command only works in text channels.', ephemeral: true });
    }

    if (deleteAll) {
      await interaction.reply({ content: 'Deleting all messages in this channel...', ephemeral: true });

      try {
        let deletedCount = 0;
        let fetched;

        do {
          fetched = await channel.messages.fetch({ limit: 100 });
          const deletable = fetched.filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
          if (deletable.size > 0) {
            await channel.bulkDelete(deletable, true);
            deletedCount += deletable.size;
          } else {
            break;
          }
        } while (fetched.size > 1);

        await interaction.followUp({ content: `Deleted ~${deletedCount} messages (limited to 14-day history).`, ephemeral: true });
      } catch (err) {
        console.error('Bulk delete all error:', err);
        await interaction.followUp({ content: 'Error occurred while deleting messages.', ephemeral: true });
      }

    } else if (amount && amount > 0) {
      await interaction.reply({ content: `Deleting ${amount} messages...`, ephemeral: true });

      try {
        let remaining = amount;
        let deletedTotal = 0;

        while (remaining > 0) {
          const fetchAmount = remaining > 100 ? 100 : remaining;
          const messages = await channel.messages.fetch({ limit: fetchAmount });
          const deletable = messages.filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
          if (deletable.size === 0) break;

          await channel.bulkDelete(deletable, true);
          deletedTotal += deletable.size;
          remaining -= deletable.size;

          if (deletable.size < fetchAmount) break;
        }

        await interaction.followUp({ content: `Deleted ${deletedTotal} messages.`, ephemeral: true });
      } catch (err) {
        console.error('Bulk delete error:', err);
        await interaction.followUp({ content: 'Failed to delete messages.', ephemeral: true });
      }
    } else {
      return interaction.reply({
        content: 'You must specify an `amount` or set `all: true`.',
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
      console.error('Birthday channel not found or not text-based.');
      return;
    }

    for (const row of res.rows) {
      const mention = `<@${row.user_id}>`;
      await channel.send(`Happy birthday ${mention}!`);
    }
  } catch (err) {
    console.error('Error checking birthdays:', err);
  }
};

// --- Login Bot ---
client.login(process.env.DISCORD_TOKEN);
