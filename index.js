import { Client, GatewayIntentBits, Partials, REST, Routes, EmbedBuilder } from 'discord.js';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  BIRTHDAY_ROLE_ID,
  BIRTHDAY_CHANNEL_ID,
  DATABASE_URL,
} = process.env;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS birthdays (
      user_id VARCHAR PRIMARY KEY,
      birthday DATE NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reactroles (
      message_id VARCHAR PRIMARY KEY,
      role_id VARCHAR NOT NULL,
      emoji VARCHAR NOT NULL
    );
  `);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await setupDatabase();

  // Register slash commands
  const commands = [
    {
      name: 'setbirthday',
      description: 'Set a user\'s birthday',
      options: [
        {
          name: 'user',
          description: 'User to set birthday for',
          type: 6, // USER
          required: true,
        },
        {
          name: 'date',
          description: 'Birthday in YYYY-MM-DD format',
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: 'clearmessages',
      description: 'Delete messages in this channel',
      options: [
        {
          name: 'user',
          description: 'Only delete messages from this user',
          type: 6, // USER
          required: false,
        },
      ],
    },
    {
      name: 'createreactrole',
      description: 'Create a reaction role message',
      options: [
        {
          name: 'emoji',
          description: 'Emoji for reaction',
          type: 3, // STRING
          required: true,
        },
        {
          name: 'roleid',
          description: 'Role ID to give',
          type: 3, // STRING
          required: true,
        },
        {
          name: 'channelid',
          description: 'Channel to send embed to',
          type: 7, // CHANNEL
          required: true,
        },
        {
          name: 'text',
          description: 'Optional message text',
          type: 3, // STRING
          required: false,
        },
      ],
    },
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  if (!interaction.member.roles.cache.has(BIRTHDAY_ROLE_ID)) {
    await interaction.reply({ content: 'error', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'setbirthday') {
    const user = interaction.options.getUser('user');
    const dateStr = interaction.options.getString('date');

    // Validate date format YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      await interaction.reply({ content: 'error', ephemeral: true });
      return;
    }

    const birthday = new Date(dateStr);
    if (isNaN(birthday.getTime())) {
      await interaction.reply({ content: 'error', ephemeral: true });
      return;
    }

    try {
      await pool.query(
        `INSERT INTO birthdays (user_id, birthday) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET birthday = EXCLUDED.birthday`,
        [user.id, dateStr]
      );
      await interaction.reply(`Birthday for ${user.tag} set to ${dateStr}`);
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  }

  else if (interaction.commandName === 'clearmessages') {
    const targetUser = interaction.options.getUser('user');
    const channel = interaction.channel;

    try {
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: 'error', ephemeral: true });
        return;
      }

      let deletedCount = 0;

      if (targetUser) {
        // Delete messages only from the target user
        const fetched = await channel.messages.fetch({ limit: 100 });
        const messagesToDelete = fetched.filter(msg => msg.author.id === targetUser.id);
        await channel.bulkDelete(messagesToDelete, true);
        deletedCount = messagesToDelete.size;
      } else {
        // Delete ALL messages in channel (Discord limits to last 100)
        const fetched = await channel.messages.fetch({ limit: 100 });
        await channel.bulkDelete(fetched, true);
        deletedCount = fetched.size;
      }

      await interaction.reply(`Deleted ${deletedCount} messages.`);
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  }

  else if (interaction.commandName === 'createreactrole') {
    const emoji = interaction.options.getString('emoji');
    const roleId = interaction.options.getString('roleid');
    const channel = interaction.options.getChannel('channelid');
    const text = interaction.options.getString('text') || 'React to get the role!';

    if (!channel || !channel.isTextBased()) {
      await interaction.reply({ content: 'error', ephemeral: true });
      return;
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle('Reaction Role')
        .setDescription(text)
        .setColor(0x00AE86);

      const message = await channel.send({ embeds: [embed] });
      await message.react(emoji);

      await pool.query(
        `INSERT INTO reactroles (message_id, role_id, emoji) VALUES ($1, $2, $3)`,
        [message.id, roleId, emoji]
      );

      await interaction.reply({ content: `Reaction role message created in ${channel}`, ephemeral: true });
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
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

  const { message, emoji } = reaction;
  try {
    const res = await pool.query(
      `SELECT role_id FROM reactroles WHERE message_id = $1 AND emoji = $2`,
      [message.id, emoji.identifier]
    );

    if (res.rowCount === 0) return;

    const roleId = res.rows[0].role_id;
    const guildMember = await message.guild.members.fetch(user.id);
    await guildMember.roles.add(roleId);
  } catch {
    // silently fail
  }
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

  const { message, emoji } = reaction;
  try {
    const res = await pool.query(
      `SELECT role_id FROM reactroles WHERE message_id = $1 AND emoji = $2`,
      [message.id, emoji.identifier]
    );

    if (res.rowCount === 0) return;

    const roleId = res.rows[0].role_id;
    const guildMember = await message.guild.members.fetch(user.id);
    await guildMember.roles.remove(roleId);
  } catch {
    // silently fail
  }
});

// Birthday check every day at 00:00 UTC
import cron from 'node-cron';

cron.schedule('0 0 * * *', async () => {
  try {
    const today = new Date().toISOString().slice(5, 10); // MM-DD
    const res = await pool.query(`SELECT user_id FROM birthdays WHERE TO_CHAR(birthday, 'MM-DD') = $1`, [today]);
    if (res.rowCount === 0) return;

    const channel = await client.channels.fetch(BIRTHDAY_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    for (const row of res.rows) {
      const user = await client.users.fetch(row.user_id);
      if (user) {
        channel.send(`Happy birthday ${user}! 🎉`);
      }
    }
  } catch {
    // ignore errors
  }
});

client.login(DISCORD_TOKEN);
