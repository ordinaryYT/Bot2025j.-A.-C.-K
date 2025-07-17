import { Client, GatewayIntentBits, Partials, Routes, REST, EmbedBuilder } from 'discord.js';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  BIRTHDAY_ROLE_ID,
  BIRTHDAY_CHANNEL_ID,
  DATABASE_URL
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

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const pgClient = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await pgClient.connect();

// Create tables if not exist
await pgClient.query(`
  CREATE TABLE IF NOT EXISTS birthdays (
    user_id VARCHAR PRIMARY KEY,
    birthday DATE NOT NULL
  );
`);

await pgClient.query(`
  CREATE TABLE IF NOT EXISTS reactroles (
    message_id VARCHAR PRIMARY KEY,
    emoji VARCHAR NOT NULL,
    role_id VARCHAR NOT NULL
  );
`);

async function registerCommands() {
  const commands = [
    {
      name: 'setbirthday',
      description: 'Set a user\'s birthday',
      options: [
        {
          name: 'user',
          type: 6, // USER
          description: 'User to set birthday for',
          required: true,
        },
        {
          name: 'date',
          type: 3, // STRING
          description: 'Birthday in YYYY-MM-DD format',
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
          type: 6, // USER
          description: 'Only delete messages from this user',
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
          type: 3, // STRING
          description: 'Emoji for reaction',
          required: true,
        },
        {
          name: 'roleid',
          type: 3, // STRING
          description: 'Role ID to give',
          required: true,
        },
        {
          name: 'text',
          type: 3, // STRING
          description: 'Optional message text',
          required: false,
        },
        {
          name: 'channelid',
          type: 7, // CHANNEL
          description: 'Channel to send embed to',
          required: true,
        },
      ],
    },
  ];

  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('Commands registered');
  } catch (error) {
    console.error(error);
  }
}

registerCommands();

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Birthday checker every hour
  setInterval(checkBirthdays, 60 * 60 * 1000);
  checkBirthdays();
});

async function checkBirthdays() {
  try {
    const today = new Date();
    const month = String(today.getUTCMonth() + 1).padStart(2, '0');
    const day = String(today.getUTCDate()).padStart(2, '0');

    const res = await pgClient.query(
      `SELECT user_id FROM birthdays WHERE to_char(birthday, 'MM-DD') = $1`,
      [`${month}-${day}`]
    );

    if (res.rows.length === 0) return;

    const channel = await client.channels.fetch(BIRTHDAY_CHANNEL_ID);
    if (!channel) return;

    for (const row of res.rows) {
      const member = await channel.guild.members.fetch(row.user_id).catch(() => null);
      if (!member) continue;
      channel.send(`Happy birthday ${member}!`);
    }
  } catch {
    // Silent fail
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const member = interaction.member;
  const hasRole = member.roles.cache.has(BIRTHDAY_ROLE_ID);

  if (interaction.commandName === 'setbirthday') {
    if (!hasRole) return interaction.reply({ content: 'error', ephemeral: true });

    const user = interaction.options.getUser('user');
    const dateStr = interaction.options.getString('date');

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return interaction.reply({ content: 'error', ephemeral: true });
    }

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return interaction.reply({ content: 'error', ephemeral: true });
    }

    try {
      await pgClient.query(
        `INSERT INTO birthdays (user_id, birthday) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET birthday = EXCLUDED.birthday`,
        [user.id, dateStr]
      );
      await interaction.reply({ content: `Birthday set for ${user.tag} as ${dateStr}`, ephemeral: true });
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  }

  else if (interaction.commandName === 'clearmessages') {
    if (!hasRole) return interaction.reply({ content: 'error', ephemeral: true });

    const user = interaction.options.getUser('user');
    const channel = interaction.channel;

    try {
      if (user) {
        // Delete messages only from user
        let fetched;
        do {
          fetched = await channel.messages.fetch({ limit: 100 });
          const userMessages = fetched.filter(m => m.author.id === user.id);
          if (userMessages.size === 0) break;
          await channel.bulkDelete(userMessages, true);
        } while (fetched.size >= 2);
      } else {
        // Delete ALL messages in channel
        let fetched;
        do {
          fetched = await channel.messages.fetch({ limit: 100 });
          if (fetched.size === 0) break;
          await channel.bulkDelete(fetched, true);
        } while (fetched.size >= 2);
      }
      await interaction.reply({ content: 'Messages deleted', ephemeral: true });
    } catch {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  }

  else if (interaction.commandName === 'createreactrole') {
    if (!hasRole) return interaction.reply({ content: 'error', ephemeral: true });

    const emoji = interaction.options.getString('emoji');
    const roleId = interaction.options.getString('roleid');
    const text = interaction.options.getString('text') || 'React to get the role!';
    const channel = interaction.options.getChannel('channelid');

    if (!channel.isTextBased()) return interaction.reply({ content: 'error', ephemeral: true });

    try {
      const embed = new EmbedBuilder()
        .setTitle('Reaction Role')
        .setDescription(text)
        .setColor('Blue');

      const msg = await channel.send({ embeds: [embed] });
      await msg.react(emoji);

      await pgClient.query(
        `INSERT INTO reactroles (message_id, emoji, role_id) VALUES ($1, $2, $3)
         ON CONFLICT (message_id) DO UPDATE SET emoji = EXCLUDED.emoji, role_id = EXCLUDED.role_id`,
        [msg.id, emoji, roleId]
      );

      await interaction.reply({ content: 'Reaction role message created.', ephemeral: true });
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
    const res = await pgClient.query(
      `SELECT role_id FROM reactroles WHERE message_id = $1 AND emoji = $2`,
      [message.id, emoji.identifier]
    );
    if (res.rows.length === 0) return;

    const roleId = res.rows[0].role_id;
    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    await member.roles.add(roleId).catch(() => {});
  } catch {
    // Silent fail
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
    const res = await pgClient.query(
      `SELECT role_id FROM reactroles WHERE message_id = $1 AND emoji = $2`,
      [message.id, emoji.identifier]
    );
    if (res.rows.length === 0) return;

    const roleId = res.rows[0].role_id;
    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    await member.roles.remove(roleId).catch(() => {});
  } catch {
    // Silent fail
  }
});

client.login(DISCORD_TOKEN);
