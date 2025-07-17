import { Client, GatewayIntentBits } from 'discord.js';
import RenderSQL from 'rendersql';
import dotenv from 'dotenv';

dotenv.config();

const TOKEN = process.env.TOKEN;
const BIRTHDAY_ROLE_ID = process.env.BIRTHDAY_ROLE_ID;

const db = new RenderSQL(process.env.RENDER_SQL_DB_URL);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

async function setBirthday(userId, birthday) {
  await db.set(`birthday_${userId}`, birthday);
}

async function getBirthday(userId) {
  return await db.get(`birthday_${userId}`);
}

async function registerCommands() {
  const commands = [
    {
      name: 'setbirthday',
      description: 'Set your birthday (YYYY-MM-DD)',
      options: [
        {
          name: 'date',
          type: 3, // STRING
          description: 'Your birthday in YYYY-MM-DD',
          required: true,
        },
      ],
    },
    {
      name: 'clearmessages',
      description: 'Delete messages in this channel',
      options: [
        {
          name: 'count',
          type: 4, // INTEGER
          description: 'Number of messages to delete',
          required: true,
        },
        {
          name: 'user',
          type: 6, // USER
          description: 'Only delete messages from this user',
          required: false,
        },
      ],
    },
  ];

  await client.application.commands.set(commands);
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (!interaction.member.roles.cache.has(BIRTHDAY_ROLE_ID)) {
      await interaction.reply({ content: 'error', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'setbirthday') {
      const dateStr = interaction.options.getString('date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        await interaction.reply({ content: 'error', ephemeral: true });
        return;
      }

      await setBirthday(interaction.user.id, dateStr);
      await interaction.reply({ content: `Birthday set to ${dateStr}`, ephemeral: true });
    } else if (interaction.commandName === 'clearmessages') {
      const count = interaction.options.getInteger('count');
      const user = interaction.options.getUser('user');

      if (count <= 0) {
        await interaction.reply({ content: 'error', ephemeral: true });
        return;
      }

      const fetched = await interaction.channel.messages.fetch({ limit: count });
      const messagesToDelete = user
        ? fetched.filter(msg => msg.author.id === user.id)
        : fetched;

      // Bulk delete in chunks of 100
      const batches = [];
      for (let i = 0; i < messagesToDelete.size; i += 100) {
        batches.push(messagesToDelete.slice(i, i + 100));
      }

      for (const batch of batches) {
        await interaction.channel.bulkDelete(batch, true).catch(() => {});
      }

      await interaction.reply({ content: `Deleted ${messagesToDelete.size} messages.`, ephemeral: true });
    }
  } catch {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'error', ephemeral: true });
    }
  }
});

registerCommands();

client.login(TOKEN);
