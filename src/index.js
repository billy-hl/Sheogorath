'use strict';
require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
const { OpenAI } = require('openai');
const { getVoiceConnection } = require('@discordjs/voice');
const schedule = require('node-schedule');
const { getState, setState } = require('./storage/state');
const { checkKickLive } = require('./services/kick');
const { fetchLatestVideo, checkYouTubeLive } = require('./services/youtube');

const fetch = require('node-fetch');

let greetServer = false; // Flag to track if the live stream has been announced
let lastInteractionTime = Date.now(); // Track the last interaction time

const requiredEnv = [
  'OPENAI_API_KEY',
  'CLIENT_NAME',
  'CLIENT_INSTRUCTIONS',
  'CLIENT_MODEL',
  'CHANNEL_ID',
  'DISCORD_TOKEN',
  'POLLING_RETRIES',
  'POLLING_TIMEOUT',
  'GUILD_ID',
  'DEFAULT_IMAGE_URL',
  'GIPHY_API_KEY',
];

const missingEnv = requiredEnv.filter((envVar) => !process.env[envVar]);

if (missingEnv.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(', ')}`
  );
  process.exit(1);
}



const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.commands = new Map();


// Dynamically load commands from src/commands
const commandFiles = fs.readdirSync('./src/commands').filter((file) => file.endsWith('.js'));
const commandDataArray = [];
for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  if (command && command.data && command.data.name) {
    client.commands.set(command.data.name, command);
    commandDataArray.push(command.data.toJSON ? command.data.toJSON() : command.data);
  }
}


client.once('ready', async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) {
    console.error('Guild not found. Please check GUILD_ID in your environment variables.');
    return;
  }
  try {
    await guild.commands.set(commandDataArray);
    console.log('Commands registered successfully.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }

  // Schedule Kick live check for main channel every 2 minutes
  if (process.env.KICK_CHANNEL_URL && process.env.CHANNEL_ID) {
    schedule.scheduleJob('*/2 * * * *', async () => {
      try {
        const channel = await client.channels.fetch(process.env.CHANNEL_ID);
        if (!channel || !channel.isTextBased()) return;
        const state = getState();
        const prev = !!state.kickLive;
        const info = await checkKickLive(process.env.KICK_CHANNEL_URL);
        if (info.live && !prev) {
          const embed = {
            color: 0x53FC18, // Kick green
            title: '🔴 Live on Kick!',
            description: `**${info.title || 'Untitled Stream'}**`,
            url: info.url,
            fields: [],
            timestamp: new Date().toISOString(),
            footer: { text: 'Kick.com', icon_url: 'https://kick.com/favicon.ico' }
          };

          // Add viewer count if available
          const viewers = info.viewer_count || (info.json?.livestream?.viewer_count ?? null);
          if (viewers !== null) {
            embed.fields.push({
              name: '👥 Viewers',
              value: viewers.toString(),
              inline: true
            });
          }

          // Add category/game if available
          const category = info.json?.livestream?.categories?.[0]?.name || info.json?.recent_categories?.[0]?.name;
          if (category) {
            embed.fields.push({
              name: '🎮 Category',
              value: category,
              inline: true
            });
          }

          // Add stream duration if available
          if (info.json?.livestream?.created_at) {
            const startTime = new Date(info.json.livestream.created_at);
            const duration = Math.floor((Date.now() - startTime.getTime()) / 1000 / 60);
            embed.fields.push({
              name: '⏱️ Duration',
              value: `${duration} minutes`,
              inline: true
            });
          }

          // Set image (thumbnail or banner fallback)
          const imageUrl = info.thumbnail || info.banner || process.env.DEFAULT_IMAGE_URL;
          if (imageUrl) {
            embed.image = { url: imageUrl.replace(/\\\//g, '/') };
          }

          // Create Watch Live button
          const row = {
            type: 1, // ACTION_ROW
            components: [{
              type: 2, // BUTTON
              style: 5, // LINK
              label: '🎬 Watch Live',
              url: info.url
            }]
          };

          await channel.send({ 
            content: '@everyone 🚨 Someone is now live on Kick!',
            embeds: [embed],
            components: [row]
          });
        }
        setState({ kickLive: info.live });
      } catch (e) {
        console.error(`Kick live check failed for main channel:`, e?.message || e);
        // Don't update state on error to avoid false negatives
      }
    });
  }

  // Schedule Kick live check for eokafish every 2 minutes
  const EOKAFISH_KICK_URL = 'https://kick.com/eokafish';
  schedule.scheduleJob('*/2 * * * *', async () => {
    try {
      const channel = await client.channels.fetch(process.env.CHANNEL_ID);
      if (!channel || !channel.isTextBased()) return;
      const state = getState();
      const prev = !!state.eokafishKickLive;
      const info = await checkKickLive(EOKAFISH_KICK_URL);
      if (info.live && !prev) {
        const embed = {
          color: 0x53FC18, // Kick green
          title: '🔴 EokaFish is Live on Kick!',
          description: `**${info.title || 'Untitled Stream'}**`,
          url: info.url,
          fields: [],
          timestamp: new Date().toISOString(),
          footer: { text: 'Kick.com • EokaFish', icon_url: 'https://kick.com/favicon.ico' }
        };

        // Add viewer count
        const viewers = info.viewer_count || (info.json?.livestream?.viewer_count ?? null);
        if (viewers !== null) {
          embed.fields.push({
            name: '👥 Viewers',
            value: viewers.toString(),
            inline: true
          });
        }

        // Add category/game
        const category = info.json?.livestream?.categories?.[0]?.name || info.json?.recent_categories?.[0]?.name;
        if (category) {
          embed.fields.push({
            name: '🎮 Playing',
            value: category,
            inline: true
          });
        }

        // Add tags if available
        const tags = info.json?.livestream?.tags;
        if (tags && tags.length > 0) {
          embed.fields.push({
            name: '🏷️ Tags',
            value: tags.slice(0, 5).join(', '), // Limit to 5 tags
            inline: false
          });
        }

          // Set thumbnail/banner
          const imageUrl = info.json?.livestream?.thumbnail?.url || 
                          info.json?.banner_image?.url || 
                          process.env.DEFAULT_IMAGE_URL;
          if (imageUrl) {
            embed.image = { url: imageUrl.replace(/\\\//g, '/') };
          }        // Create buttons row
        const row = {
          type: 1, // ACTION_ROW
          components: [
            {
              type: 2, // BUTTON
              style: 5, // LINK
              label: '🎬 Watch Live',
              url: info.url,
              emoji: { name: '🔴' }
            }
          ]
        };

        await channel.send({ 
          content: '@everyone 🚨 EokaFish is now live on Kick!',
          embeds: [embed],
          components: [row]
        });
      }
      setState({ eokafishKickLive: info.live });
    } catch (e) {
      console.error('Eokafish Kick live check failed:', e?.message || e);
    }
  });

  // Schedule Kick live check for allisteras every 2 minutes
  if (process.env.ALLISTERAS_KICK_URL && process.env.CHANNEL_ID) {
    schedule.scheduleJob('*/2 * * * *', async () => {
      try {
        const channel = await client.channels.fetch(process.env.CHANNEL_ID);
        if (!channel || !channel.isTextBased()) return;
        const state = getState();
        const prev = !!state.allisterasKickLive;
        const info = await checkKickLive(process.env.ALLISTERAS_KICK_URL);
        if (info.live && !prev) {
          const embed = {
            color: 0x53FC18, // Kick green
            title: '🔴 Allisteras is Live on Kick!',
            description: `**${info.title || 'Untitled Stream'}**`,
            url: info.url,
            fields: [],
            timestamp: new Date().toISOString(),
            footer: { text: 'Kick.com • Allisteras', icon_url: 'https://kick.com/favicon.ico' }
          };

          // Add viewer count
          const viewers = info.viewer_count || (info.json?.livestream?.viewer_count ?? null);
          if (viewers !== null) {
            embed.fields.push({
              name: '👥 Viewers',
              value: viewers.toString(),
              inline: true
            });
          }

          // Add category/game
          const category = info.json?.livestream?.categories?.[0]?.name || info.json?.recent_categories?.[0]?.name;
          if (category) {
            embed.fields.push({
              name: '🎮 Playing',
              value: category,
              inline: true
            });
          }

          // Add tags if available
          const tags = info.json?.livestream?.tags;
          if (tags && tags.length > 0) {
            embed.fields.push({
              name: '🏷️ Tags',
              value: tags.slice(0, 5).join(', '), // Limit to 5 tags
              inline: false
            });
          }

          // Set thumbnail/banner
          const imageUrl = info.json?.livestream?.thumbnail?.url || 
                          info.json?.banner_image?.url || 
                          process.env.DEFAULT_IMAGE_URL;
          if (imageUrl) {
            embed.image = { url: imageUrl.replace(/\\\//g, '/') };
          }

          // Create buttons row
          const row = {
            type: 1, // ACTION_ROW
            components: [
              {
                type: 2, // BUTTON
                style: 5, // LINK
                label: '🎬 Watch Live',
                url: info.url,
                emoji: { name: '🔴' }
              }
            ]
          };

          await channel.send({ 
            content: '@everyone 🚨 Allisteras is now live on Kick!',
            embeds: [embed],
            components: [row]
          });
        }
        setState({ allisterasKickLive: info.live });
      } catch (e) {
        console.error('Allisteras Kick live check failed:', e?.message || e);
      }
    });
  }

  // Schedule YouTube latest video check every 5 minutes, if YT_CHANNEL_URL and CHANNEL_ID are set
  if (process.env.YT_CHANNEL_URL && process.env.CHANNEL_ID) {
    schedule.scheduleJob('*/5 * * * *', async () => {
      try {
        const channel = await client.channels.fetch(process.env.CHANNEL_ID);
        if (!channel || !channel.isTextBased()) return;
        const state = getState();
        const last = state.lastYouTubeVideoId;
        const latest = await fetchLatestVideo(process.env.YT_CHANNEL_URL);
        if (latest && latest.id && latest.id !== last) {
          await channel.send(`@everyone 📺 New YouTube upload: ${latest.title}\n${latest.url}`);
          setState({ lastYouTubeVideoId: latest.id });
        }
      } catch (e) {
        console.error('YouTube latest video check failed:', e?.message || e);
      }
    });
  }

  // Schedule YouTube live check every 2 minutes, if YT_CHANNEL_URL and CHANNEL_ID are set
  if (process.env.YT_CHANNEL_URL && process.env.CHANNEL_ID) {
    schedule.scheduleJob('*/2 * * * *', async () => {
      try {
        const channel = await client.channels.fetch(process.env.CHANNEL_ID);
        if (!channel || !channel.isTextBased()) return;
        const state = getState();
        const prev = !!state.youtubeLive;
        const info = await checkYouTubeLive(process.env.YT_CHANNEL_URL);
        if (info.live && !prev) {
          await channel.send(`@everyone 🔴 Live on YouTube now: ${info.title} — ${info.url}`);
        }
        setState({ youtubeLive: !!info.live });
      } catch (e) {
        console.error('YouTube live check failed:', e?.message || e);
      }
    });
  }
});


// Optional: If you want to keep the scheduled news job, keep this block, otherwise remove it if not needed
client.on('ready', async (c) => {
  console.log(`${c.user.tag} is online.`);

  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  if (channel && greetServer) {
    greetChatGpt(channel, 'Greet your servants');
  }

  // Only schedule news if the command exists
  if (client.commands.has('news')) {
    schedule.scheduleJob('0 * * * *', async () => {
      console.log('Scheduled task: Fetching and posting the latest news.');
      const newsCommand = client.commands.get('news');
      if (!newsCommand) {
        console.error('News command not found!');
        return;
      }
      const result = await newsCommand.fetchLatestNews();
      if (!result) {
        console.log('No new articles to post.');
        return;
      }
      const { embed, guid } = result;
      const channelId = process.env.CHANNEL_ID;
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          console.error('Channel not found or is not text-based!');
          return;
        }
        console.log(`Attempting to send embed for article: ${embed.data.title}`);
        await channel.send({ embeds: [embed] });
        console.log(`Scheduled task: Posted new article: ${embed.data.title}`);
        newsCommand.writeCache({ lastArticleGuid: guid });
      } catch (error) {
        console.error('Error fetching the channel or sending the message:', error);
      }
    });
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (
    message.content.includes(`<@!${client.user.id}>`) ||
    message.content.includes(`<@${client.user.id}>`)
  ) {
    askChatGPT(message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  lastInteractionTime = Date.now();

  if (!interaction.isChatInputCommand()) return;

  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    console.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing command ${interaction.commandName}:`, error);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'There was an error while executing this command!',
          flags: 64,
        });
      } else {
        await interaction.reply({
          content: 'There was an error while executing this command!',
          flags: 64,
        });
      }
    } catch (err) {
      console.error('Failed to send error response to interaction:', err?.message || err);
    }
  }
});

setInterval(async () => {
  const currentTime = Date.now();
  const oneHour = 60 * 60 * 1000;

  if (currentTime - lastInteractionTime > oneHour) {
    console.log('Bot has been idle for 1 hour. Executing stop logic.');

    const stopCommand = client.commands.get('stop');
    if (stopCommand) {
      try {
        await stopCommand.execute({
          deferReply: async () => {},
          followUp: async (message) => console.log(message),
        });
      } catch (error) {
        console.error('Error executing stop command:', error);
      }
    }

    lastInteractionTime = Date.now();
  }
}, 60 * 1000);

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const voiceChannel = oldState.channel || newState.channel;

  if (voiceChannel) {
    const botVoiceState = voiceChannel.guild.members.me.voice;

    if (
      botVoiceState &&
      botVoiceState.channelId === voiceChannel.id &&
      voiceChannel.members.size === 1
    ) {
      const connection = getVoiceConnection(voiceChannel.guild.id);
      if (connection) {
        connection.destroy();
        console.log('Bot disconnected due to empty voice channel.');
      } else {
        console.log('No active connection found.');
      }
    }
  }
});

async function askChatGPT(userMessage) {
  userMessage.channel.sendTyping();
  try {
    const response = await openai.chat.completions.create({
      model: process.env.CLIENT_MODEL,
      messages: [
        { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
        { role: 'user', content: userMessage.content },
      ],
    });

    const assistantReply = response.choices[0].message.content;
    userMessage.reply(assistantReply);
  } catch (error) {
    console.error('Error in askChatGPT:', error);
    userMessage.reply('An error occurred while trying to fetch the response.');
  }
}

async function greetChatGpt(channel, messageToSend) {
  try {
    const response = await openai.chat.completions.create({
      model: process.env.CLIENT_MODEL,
      messages: [
        { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
        { role: 'user', content: messageToSend },
      ],
    });

    const assistantReply = response.choices[0].message.content;
    channel.send(assistantReply);
  } catch (error) {
    console.error('Error in greetChatGpt:', error);
    return 'An error occurred while trying to fetch the response.';
  }
}

process.on('SIGINT', () => {
  console.log('Bot is shutting down...');
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
// index.js
