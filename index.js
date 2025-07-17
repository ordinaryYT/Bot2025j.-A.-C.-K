import { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField, ChannelType } from 'discord.js';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const db = new Database('./birthdaybot.db');

// Create tables if they don't exist
db.prepare(`
  CREATE TABLE IF NOT EXISTS birthdays (
    userId TEXT PRIMARY KEY,
    date TEXT
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS reactroles (
    messageId TEXT PRIMARY KEY,
    roleId TEXT,
    emoji TEXT
  )
`).run();

const BIRTHDAY_ROLE_ID = process.env.BIRTHDAY_ROLE_ID;
const BIRTHDAY_CHANNEL_ID = process.env.BIRTHDAY_CHANNEL_ID;

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Slash command setup on ready (guild commands)
client.on('ready', async () => {
  const guilds = client.guilds.cache.map(g => g.id);

  for (const guildId of guilds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    await guild.commands.set([
      {
        name: 'setbirthday',
        description: 'Set a user\'s birthday (YYYY-MM-DD)',
        options: [
          {
            name: 'user',
            type: 6, // USER
            description: 'User to set birthday for',
            required: true
          },
          {
            name: 'date',
            type: 3, // STRING
            description: 'Birthday date in YYYY-MM-DD',
            required: true
          }
        ]
      },
      {
        name: 'clearmessages',
        description: 'Delete messages in this channel',
        options: [
          {
            name: 'amount',
            type: 4, // INTEGER
            description: 'Number of messages to delete',
            required: true
          },
          {
            name: 'user',
            type: 6, // USER
            description: 'Only delete messages from this user',
            required: false
          }
        ]
      },
      {
        name: 'createreactrole',
        description: 'Create a reaction role message',
        options: [
          {
            name: 'emoji',
            type: 3, // STRING
            description: 'Emoji for reaction',
            required: true
          },
          {
            name: 'roleid',
            type: 3, // STRING
            description: 'Role ID to give',
            required: true
          },
          {
            name: 'text',
            type: 3, // STRING
            description: 'Optional message text',
            required: false
          },
          {
            name: 'channelid',
            type: 7, // CHANN
