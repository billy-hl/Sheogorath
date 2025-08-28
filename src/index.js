'use strict';
require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, Collection, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { OpenAI } = require('openai');
const { getVoiceConnection } = require('@discordjs/voice');
const schedule = require('node-schedule');
const { getState, setState } = require('./storage/state');
const { checkKickLive } = require('./services/kick');
const { fetchLatestVideo, checkYouTubeLive } = require('./services/youtube');

const fetch = require('node-fetch');

let greetServer = false; // Flag to track if the live stream has been announced
let lastInteractionTime = Date.now(); // Track the last interaction time
let lastFishingChannelActivity = Date.now(); // Track last activity in fishing channel
const FISHING_CHANNEL_ID = '1410703437502353428'; // The fishing channel ID
const conversationHistory = new Map(); // Store conversation history per user

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

  // Proactive AI engagement - random messages every 45 minutes
  schedule.scheduleJob('*/45 * * * *', async () => {
    try {
      const channel = await client.channels.fetch(process.env.CHANNEL_ID);
      if (!channel || !channel.isTextBased()) return;
      
      // 15% chance to send a random engaging message
      if (Math.random() < 0.15) {
        const prompts = [
          "Share a random thought or observation about the current state of the server.",
          "Ask the users an interesting question to spark conversation.",
          "Share a piece of 'wisdom' in your typical chaotic style.",
          "Comment on something happening in the world of mortals."
        ];
        
        const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];
        
        const response = await openai.chat.completions.create({
          model: process.env.CLIENT_MODEL,
          messages: [
            { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
            { role: 'user', content: randomPrompt }
          ],
        });
        
        const message = response.choices[0].message.content;
        await channel.send(message);
      }
    } catch (e) {
      console.error('Proactive AI engagement failed:', e?.message || e);
    }
  });

  // Tournament checker - every 5 minutes
  schedule.scheduleJob('*/5 * * * *', async () => {
    try {
      const fishingGame = require('./services/fishing');
      const endedTournaments = fishingGame.endExpiredTournaments();
      
      if (endedTournaments.length > 0) {
        const channel = await client.channels.fetch(process.env.CHANNEL_ID);
        if (!channel || !channel.isTextBased()) return;
        
        for (const tournament of endedTournaments) {
          await announceTournamentWinner(channel, tournament);
        }
      }
    } catch (e) {
      console.error('Tournament checker failed:', e?.message || e);
    }
  });
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

  // Track fishing channel activity
  if (message.channelId === FISHING_CHANNEL_ID) {
    lastFishingChannelActivity = Date.now();
  }
  if (
    message.content.includes(`<@!${client.user.id}>`) ||
    message.content.includes(`<@${client.user.id}>`)
  ) {
    askChatGPT(message);
  }
  
  // Enhanced conversational triggers
  const content = message.content.toLowerCase();
  const triggers = [
    'sheogorath',
    'mad king',
    'hey bot',
    'ai',
    'tell me',
    'what do you think',
    'help me',
    'i need advice'
  ];
  
  const isTriggered = triggers.some(trigger => content.includes(trigger));
  
  if (isTriggered && !message.content.includes(`<@!${client.user.id}>`) && !message.content.includes(`<@${client.user.id}>`)) {
    askChatGPT(message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  lastInteractionTime = Date.now();

  // Track fishing channel activity
  if (interaction.channelId === FISHING_CHANNEL_ID) {
    lastFishingChannelActivity = Date.now();
  }

  try {
    if (interaction.isButton()) {
      // Handle button interactions for games
      if (interaction.customId.startsWith('guess_')) {
        await handleGuessGame(interaction);
        return;
      }
      if (interaction.customId.startsWith('minigame_')) {
        await handleMiniGameButton(interaction);
        return;
      }
      if (interaction.customId === 'refresh_challenges') {
        await handleChallengeRefresh(interaction);
        return;
      }
      if (interaction.customId === 'sell_all_fish') {
        await handleSellAllFish(interaction);
        return;
      }
      if (interaction.customId.startsWith('sell_fish_')) {
        await handleSellFishButton(interaction);
        return;
      }
      if (interaction.customId.startsWith('shop_')) {
        await handleShopActions(interaction);
        return;
      }
      if (interaction.customId.startsWith('stats_')) {
        await handleStatsActions(interaction);
        return;
      }
      if (interaction.customId.startsWith('fish_')) {
        await handleFishQuickActions(interaction);
        return;
      }

      // If we reach here, the button wasn't handled
      console.error(`Unhandled button interaction: ${interaction.customId}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ This button is not working properly. Please try again or contact an administrator.',
          flags: 64
        });
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      // Handle select menu interactions for fishing shop
      if (interaction.customId.startsWith('shop_')) {
        await handleShopPurchase(interaction);
        return;
      }
      if (interaction.customId === 'sell_fish') {
        await handleFishSell(interaction);
        return;
      }

      // If we reach here, the select menu wasn't handled
      console.error(`Unhandled select menu interaction: ${interaction.customId}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ This menu is not working properly. Please try again or contact an administrator.',
          flags: 64
        });
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    await command.execute(interaction);

  } catch (error) {
    console.error('Interaction error:', error);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: '❌ An error occurred while processing this interaction. Please try again.',
          flags: 64
        });
      } else {
        await interaction.reply({
          content: '❌ An error occurred while processing this interaction. Please try again.',
          flags: 64
        });
      }
    } catch (followUpError) {
      console.error('Failed to send error response:', followUpError);
    }
  }
});

setInterval(async () => {
  const currentTime = Date.now();
  const oneHour = 60 * 60 * 1000;
  const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

  // Check for fishing channel cleanup (5 minutes of inactivity)
  if (currentTime - lastFishingChannelActivity > fiveMinutes) {
    try {
      const channel = await client.channels.fetch(FISHING_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        // Fetch recent messages (last 100)
        const messages = await channel.messages.fetch({ limit: 100 });

        // Filter bot messages that are older than 5 minutes and not system messages
        const botMessages = messages.filter(msg =>
          msg.author.bot &&
          msg.author.id === client.user.id && // Only our bot's messages
          (currentTime - msg.createdTimestamp) > fiveMinutes &&
          !msg.system // Exclude system messages
        );

        if (botMessages.size > 0) {
          console.log(`Cleaning up ${botMessages.size} bot messages from fishing channel after 5 minutes of inactivity`);

          // Delete messages in bulk (Discord allows bulk delete for messages < 2 weeks old)
          const messageIds = botMessages.map(msg => msg.id);
          await channel.bulkDelete(messageIds, true).catch(error => {
            console.error('Bulk delete failed, trying individual deletes:', error);
            // Fallback to individual deletes if bulk fails
            return Promise.all(
              messageIds.map(id => channel.messages.delete(id).catch(() => {}))
            );
          });

          console.log(`Successfully cleaned up ${botMessages.size} messages from fishing channel`);
        }
      }
    } catch (error) {
      console.error('Fishing channel cleanup failed:', error);
    }

    // Reset the activity timer after cleanup
    lastFishingChannelActivity = Date.now();
  }

  // Original idle logic for bot shutdown
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
}, 60 * 1000); // Check every minute

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

// AI welcome messages for new members
client.on('guildMemberAdd', async (member) => {
  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;
    
    const prompt = `Welcome ${member.user.username} to the server in your typical chaotic, sarcastic, and threatening style. Make it memorable and fun.`;
    const welcomeMessage = await openai.chat.completions.create({
      model: process.env.CLIENT_MODEL,
      messages: [
        { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
        { role: 'user', content: prompt }
      ],
    });
    
    const message = welcomeMessage.choices[0].message.content;
    await channel.send(`🎉 ${message}`);
  } catch (error) {
    console.error('AI welcome message failed:', error);
    // Fallback welcome
    await channel.send(`🎉 Welcome ${member.user.username}! The Mad King awaits your entertainment...`);
  }
});

async function askChatGPT(userMessage) {
  userMessage.channel.sendTyping();
  
  const userId = userMessage.author.id;
  const history = conversationHistory.get(userId) || [];
  
  try {
    const messages = [
      { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
      ...history.slice(-8), // Keep last 8 messages for context
      { role: 'user', content: userMessage.content }
    ];
    
    const response = await openai.chat.completions.create({
      model: process.env.CLIENT_MODEL,
      messages: messages,
    });

    const assistantReply = response.choices[0].message.content;
    
    // Store conversation (keep last 10 exchanges)
    history.push(
      { role: 'user', content: userMessage.content },
      { role: 'assistant', content: assistantReply }
    );
    if (history.length > 20) { // Keep max 20 messages (10 exchanges)
      history.splice(0, history.length - 20);
    }
    conversationHistory.set(userId, history);
    
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

async function handleGuessGame(interaction) {
  const [action, value, targetNumber, maxNumber] = interaction.customId.split('_');
  const target = parseInt(targetNumber);
  const max = parseInt(maxNumber);

  if (action === 'giveup') {
    const embed = new EmbedBuilder()
      .setTitle('😔 Game Over')
      .setColor(0xff0000)
      .setDescription(`**The number was ${target}!**\n\n*"Giving up so soon? How utterly disappointing!"*`)
      .setFooter({
        text: `Game ended by ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    await interaction.update({
      embeds: [embed],
      components: []
    });
    return;
  }

  if (action === 'custom') {
    // This would require a modal, but for simplicity, let's just give a hint
    const hint = target > 50 ? 'high' : 'low';
    const embed = new EmbedBuilder()
      .setTitle('🎲 Custom Guess')
      .setColor(0xffa500)
      .setDescription(`**Think of a number and guess it!**\n\n*Hint: The number is ${hint}er than 50!*`)
      .setFooter({
        text: `Playing with ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    await interaction.update({
      embeds: [embed],
      components: []
    });
    return;
  }

  const guess = parseInt(value);
  let result;
  let color;
  let title;

  if (guess === target) {
    result = 'correct';
    color = 0x00ff00;
    title = '🎉 Correct!';
  } else if (guess < target) {
    result = 'too_low';
    color = 0xffa500;
    title = '📈 Too Low!';
  } else {
    result = 'too_high';
    color = 0xffa500;
    title = '📉 Too High!';
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color);

  if (result === 'correct') {
    embed.setDescription(`**You guessed ${guess}!**\n\n*"Well done! You have bested the Mad King... this time!"*`);
  } else {
    const direction = result === 'too_low' ? 'higher' : 'lower';
    embed.setDescription(`**You guessed ${guess}!**\n\n*"Try ${direction}! The number eludes you still!"*`);
  }

  embed.setFooter({
    text: `Guessing game with ${interaction.user.username}`,
    iconURL: interaction.user.displayAvatarURL({ dynamic: true })
  });

  // Update buttons if not correct
  let components = [];
  if (result !== 'correct') {
    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`guess_25_${target}_${max}`)
          .setLabel('25')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`guess_50_${target}_${max}`)
          .setLabel('50')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`guess_75_${target}_${max}`)
          .setLabel('75')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`guess_100_${target}_${max}`)
          .setLabel('100')
          .setStyle(ButtonStyle.Secondary)
      );

    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`guess_custom_${target}_${max}`)
          .setLabel('🎲 Custom Guess')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`guess_giveup_${target}_${max}`)
          .setLabel('😔 Give Up')
          .setStyle(ButtonStyle.Danger)
      );

    components = [row1, row2];
  }

  await interaction.update({
    embeds: [embed],
    components: components
  });
}

async function handleShopPurchase(interaction) {
  const fishingGame = require('./services/fishing');
  const [category, itemType, itemKey] = interaction.values[0].split('_');
  const userId = interaction.user.id;
  const playerData = fishingGame.getPlayerData(userId);
  const shopData = fishingGame.loadData().shop;

  let itemCategory, itemName, cost;

  if (itemType === 'rod') {
    itemCategory = shopData.rods;
    itemName = 'rod';
  } else if (itemType === 'bait') {
    itemCategory = shopData.bait;
    itemName = 'bait';
  } else if (itemType === 'hook') {
    itemCategory = shopData.hooks;
    itemName = 'hook';
  }

  if (!itemCategory || !itemCategory[itemKey]) {
    return await interaction.reply({
      content: '❌ **Item Not Available!**\n\nThis item may no longer be available or there might be an issue with the shop. Please refresh the shop menu and try again.',
      flags: 64
    });
  }

  const item = itemCategory[itemKey];
  cost = item.cost;

  // Check if player can afford it
  if (playerData.coins < cost) {
    return await interaction.reply({
      content: `❌ You don't have enough coins! You need ${cost} coins, but only have ${playerData.coins}.`,
      flags: 64
    });
  }

  // Check if already equipped
  if (playerData.equipment[itemName] === itemKey) {
    return await interaction.reply({
      content: `❌ You already have the ${item.name} equipped!`,
      flags: 64
    });
  }

  // Purchase the item
  playerData.coins -= cost;
  playerData.equipment[itemName] = itemKey;

  fishingGame.updatePlayerData(userId, {
    coins: playerData.coins,
    equipment: playerData.equipment
  });

  const embed = new EmbedBuilder()
    .setTitle('✅ Purchase Successful!')
    .setDescription(`**${item.name}** equipped!\n\n*${item.description}*`)
    .setColor(0x00ff00)
    .addFields({
      name: '💰 Remaining Coins',
      value: `${playerData.coins} coins`,
      inline: true
    })
    .setFooter({
      text: `Purchased by ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

  await interaction.reply({ embeds: [embed], flags: 0 });
}

async function handleSellAllFish(interaction) {
  const fishingGame = require('./services/fishing');
  const userId = interaction.user.id;
  const playerData = fishingGame.getPlayerData(userId);
  const marketData = fishingGame.loadData().market;

  // Check if player has any fish
  if (Object.keys(playerData.inventory).length === 0) {
    return await interaction.reply({
      content: '❌ You have no fish to sell!',
      flags: 64
    });
  }

  // Calculate total value of all fish
  let totalValue = 0;
  let totalFish = 0;
  const soldFish = [];

  Object.entries(playerData.inventory).forEach(([fishName, quantity]) => {
    const fishInfo = marketData.fish_prices[fishName];
    if (fishInfo) {
      const value = fishInfo.basePrice * quantity;
      totalValue += value;
      totalFish += quantity;
      soldFish.push(`${quantity}x ${fishName.replace('_', ' ')}`);
    }
  });

  // Clear entire inventory and add coins
  playerData.inventory = {};
  playerData.coins += totalValue;
  playerData.stats.totalCoins += totalValue;

  fishingGame.updatePlayerData(userId, {
    inventory: playerData.inventory,
    coins: playerData.coins,
    stats: playerData.stats
  });

  // Send confirmation first
  const confirmEmbed = new EmbedBuilder()
    .setTitle('💰 All Fish Sold!')
    .setDescription(`Sold **${totalFish} fish** for **${totalValue} coins**!`)
    .setColor(0x00ff00)
    .addFields({
      name: '🐟 Fish Sold',
      value: soldFish.join('\n'),
      inline: false
    }, {
      name: '💵 New Balance',
      value: `${playerData.coins} coins`,
      inline: true
    })
    .setFooter({
      text: `Sold by ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

  await interaction.reply({ embeds: [confirmEmbed], flags: 64 });

  // Then update the original message to show empty inventory
  const embed = new EmbedBuilder()
    .setTitle('💰 Sell Your Fish')
    .setDescription('Click on a fish below to sell it:')
    .setColor(0xffd700)
    .setFooter({
      text: `Market - ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

  embed.addFields({
    name: '📦 Your Inventory',
    value: 'All fish sold! 🎉',
    inline: false
  });

  // Only show navigation buttons (no fish buttons since inventory is empty)
  const navRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('shop_main')
        .setLabel('⬅️ Back to Shop')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('fish_help')
        .setLabel('🏠 Home')
        .setStyle(ButtonStyle.Primary)
    );

  // Update the original message
  try {
    await interaction.message.edit({ embeds: [embed], components: [navRow] });
  } catch (error) {
    console.error('Failed to update sell interface message:', error);
  }
}

async function handleSellFishButton(interaction) {
  const fishingGame = require('./services/fishing');
  const parts = interaction.customId.split('_');
  const fishName = parts.slice(2, -1).join('_'); // Handle fish names with underscores
  const quantity = parseInt(parts[parts.length - 1]);
  const userId = interaction.user.id;
  const playerData = fishingGame.getPlayerData(userId);
  const marketData = fishingGame.loadData().market;

  const fishInfo = marketData.fish_prices[fishName];
  if (!fishInfo) {
    return await interaction.reply({
      content: `❌ **Fish Not Found!**\n\nUnable to find pricing information for this fish. It may no longer be sellable or there might be a market issue.`,
      flags: 64
    });
  }

  // Check if player has enough fish
  if (!playerData.inventory[fishName] || playerData.inventory[fishName] < quantity) {
    return await interaction.reply({
      content: `❌ You don't have enough ${fishName.replace('_', ' ')} to sell!`,
      flags: 64
    });
  }

  // Calculate sale value
  const totalValue = fishInfo.basePrice * quantity;

  // Remove fish from inventory and add coins
  fishingGame.removeFromInventory(userId, fishName, quantity);
  playerData.coins += totalValue;
  playerData.stats.totalCoins += totalValue;

  fishingGame.updatePlayerData(userId, {
    coins: playerData.coins,
    stats: playerData.stats
  });

  // Send confirmation first
  const confirmEmbed = new EmbedBuilder()
    .setTitle('✅ Fish Sold!')
    .setDescription(`Sold **${quantity}x ${fishName.replace('_', ' ')}** for **${totalValue} coins**!`)
    .setColor(0x00ff00)
    .addFields({
      name: '💵 New Balance',
      value: `${playerData.coins} coins`,
      inline: true
    })
    .setFooter({
      text: `Sold by ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

  await interaction.reply({ embeds: [confirmEmbed], flags: 64 });

  // Then update the original message
  const updatedPlayerData = fishingGame.getPlayerData(userId);
  const embed = new EmbedBuilder()
    .setTitle('💰 Sell Your Fish')
    .setDescription('Click on a fish below to sell it:')
    .setColor(0xffd700)
    .setFooter({
      text: `Market - ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

  // Create updated components
  const components = [];
  let currentRow = new ActionRowBuilder();
  let buttonCount = 0;
  const maxButtonsPerRow = 5;
  const maxRows = 5;

  if (Object.keys(updatedPlayerData.inventory).length === 0) {
    embed.addFields({
      name: '📦 Your Inventory',
      value: 'All fish sold! 🎉',
      inline: false
    });
  } else {
    let inventoryText = '';
    Object.entries(updatedPlayerData.inventory).forEach(([fishNameKey, fishQuantity]) => {
      const fishInfoData = marketData.fish_prices[fishNameKey];
      if (fishInfoData) {
        const totalValueData = fishInfoData.basePrice * fishQuantity;
        const displayName = fishNameKey.replace('_', ' ');
        inventoryText += `**${displayName}** x${fishQuantity} - ${totalValueData}🪙\n`;

        // Create sell button for this fish
        if (buttonCount < maxButtonsPerRow * maxRows) {
          // Truncate fish name if too long for button label (Discord limit: 25 chars)
          let buttonLabel = `${displayName} (${fishQuantity})`;
          if (buttonLabel.length > 25) {
            buttonLabel = `${displayName.substring(0, 20)}... (${fishQuantity})`;
          }

          const button = new ButtonBuilder()
            .setCustomId(`sell_fish_${fishNameKey}_${fishQuantity}`)
            .setLabel(buttonLabel)
            .setStyle(ButtonStyle.Success);

          currentRow.addComponents(button);
          buttonCount++;

          // If row is full or we've reached max buttons per row, start new row
          if (currentRow.components.length >= maxButtonsPerRow) {
            components.push(currentRow);
            currentRow = new ActionRowBuilder();
          }
        }
      }
    });

    embed.addFields({
      name: '📦 Your Inventory',
      value: inventoryText || 'No sellable fish found.',
      inline: false
    });

    // Add the last row if it has components
    if (currentRow.components.length > 0) {
      components.push(currentRow);
    }
  }

  // Add navigation buttons in a separate row
  const navRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('sell_all_fish')
        .setLabel('💰 Sell Everything')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('shop_main')
        .setLabel('⬅️ Back to Shop')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('fish_help')
        .setLabel('🏠 Home')
        .setStyle(ButtonStyle.Primary)
    );

  components.push(navRow);

  // Update the original message (need to get the message from the interaction)
  try {
    await interaction.message.edit({ embeds: [embed], components: components });
  } catch (error) {
    console.error('Failed to update sell interface message:', error);
  }
}

async function handleFishSell(interaction) {
  const fishingGame = require('./services/fishing');
  const parts = interaction.values[0].split('_');
  const action = parts[0];
  const quantityStr = parts[parts.length - 1];
  const quantity = parseInt(quantityStr);
  // Reconstruct fish name (handles names with underscores like lunar_fish)
  const fishName = parts.slice(1, -1).join('_');
  const userId = interaction.user.id;
  const playerData = fishingGame.getPlayerData(userId);
  const marketData = fishingGame.loadData().market;

  const fishInfo = marketData.fish_prices[fishName];
  if (!fishInfo) {
    return await interaction.reply({
      content: `❌ **Fish Not Found!**\n\nUnable to find pricing information for this fish. It may no longer be sellable or there might be a market issue.`,
      flags: 64
    });
  }

  // Check if player has enough fish
  if (!playerData.inventory[fishName] || playerData.inventory[fishName] < quantity) {
    return await interaction.reply({
      content: `❌ You don't have enough ${fishName.replace('_', ' ')} to sell!`,
      flags: 64
    });
  }

  // Calculate sale value
  const totalValue = fishInfo.basePrice * quantity;

  // Remove fish from inventory and add coins
  fishingGame.removeFromInventory(userId, fishName, quantity);
  playerData.coins += totalValue;
  playerData.stats.totalCoins += totalValue;

  fishingGame.updatePlayerData(userId, {
    coins: playerData.coins,
    stats: playerData.stats
  });

  const embed = new EmbedBuilder()
    .setTitle('💰 Fish Sold!')
    .setDescription(`Sold **${quantity}x ${fishName.replace('_', ' ')}** for **${totalValue} coins**!`)
    .setColor(0x00ff00)
    .addFields({
      name: '💵 New Balance',
      value: `${playerData.coins} coins`,
      inline: true
    })
    .setFooter({
      text: `Sold by ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

  await interaction.reply({ embeds: [embed], flags: 0 });
}

async function handleMiniGameButton(interaction) {
  const fishingGame = require('./services/fishing');
  const [action, difficulty] = interaction.customId.split('_').slice(1);
  
  if (action === 'retry') {
    // Reuse the minigame command logic
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);
    
    // Check cooldown
    const now = Date.now();
    const cooldown = 30000;
    
    if (now - playerData.lastMiniGame < cooldown) {
      const remaining = Math.ceil((cooldown - (now - playerData.lastMiniGame)) / 1000);
      return await interaction.reply({
        content: `⏰ **Cooldown Active!** You must wait ${remaining} seconds before playing another mini-game.`,
        flags: 64
      });
    }

    const result = fishingGame.playMiniGame(userId, difficulty);
    
    const embed = new EmbedBuilder()
      .setTitle('🎮 Fishing Mini-Game')
      .setColor(result.success ? 0x00ff00 : 0xff0000)
      .setFooter({
        text: `Mini-game practice • ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    if (result.success) {
      embed.setDescription('🎉 **Success!** You caught the fish with a bonus!\n\n' + result.message);
    } else {
      embed.setDescription('❌ **Failed!** The fish got away!\n\n' + result.message);
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`minigame_retry_${difficulty}`)
          .setLabel('🎮 Play Again')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('minigame_different')
          .setLabel('🔄 Different Difficulty')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.update({ embeds: [embed], components: [row] });
    
  } else if (action === 'different') {
    // Show difficulty selection
    const embed = new EmbedBuilder()
      .setTitle('🎮 Choose Mini-Game Difficulty')
      .setDescription('Select a difficulty level to practice:')
      .setColor(0x4a90e2);

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('minigame_retry_common')
          .setLabel('🐟 Easy')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('minigame_retry_uncommon')
          .setLabel('🐠 Medium')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('minigame_retry_rare')
          .setLabel('🦈 Hard')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('minigame_retry_legendary')
          .setLabel('🐋 Expert')
          .setStyle(ButtonStyle.Danger)
      );

    await interaction.update({ embeds: [embed], components: [row] });
  }
}

async function handleChallengeRefresh(interaction) {
  const fishingGame = require('./services/fishing');
  const userId = interaction.user.id;
  const playerData = fishingGame.getPlayerData(userId);
  
  // Refresh challenges
  fishingGame.checkDailyChallenges(userId);
  fishingGame.checkWeeklyChallenges(userId);
  
  const data = fishingGame.loadData();
  const challenges = data.challenges;
  
  const embed = new EmbedBuilder()
    .setTitle('🎯 Fishing Challenges (Refreshed)')
    .setColor(0x4a90e2)
    .setFooter({
      text: `Challenges for ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    })
    .setTimestamp();

  // Get updated player data
  const updatedPlayerData = fishingGame.getPlayerData(userId);

  if (challenges.daily && challenges.daily.length > 0) {
    embed.addFields({
      name: '📅 Daily Challenges',
      value: challenges.daily.map(challenge => {
        const playerChallenge = updatedPlayerData.challenges.daily[challenge.id];
        const completed = playerChallenge && playerChallenge.completed;
        const progress = playerChallenge ? playerChallenge.progress : 0;
        const target = challenge.target;
        
        const status = completed ? '✅' : '⏳';
        const progressText = `${progress}/${target}`;
        
        return `${status} **${challenge.name}**\n${challenge.description}\n*Progress: ${progressText} • Reward: ${challenge.reward.coins} coins, ${challenge.reward.exp} XP*`;
      }).join('\n\n'),
      inline: false
    });
  }

  if (challenges.weekly && challenges.weekly.length > 0) {
    embed.addFields({
      name: '📊 Weekly Challenges',
      value: challenges.weekly.map(challenge => {
        const playerChallenge = updatedPlayerData.challenges.weekly[challenge.id];
        const completed = playerChallenge && playerChallenge.completed;
        const progress = playerChallenge ? playerChallenge.progress : 0;
        const target = challenge.target;
        
        const status = completed ? '✅' : '⏳';
        const progressText = `${progress}/${target}`;
        
        return `${status} **${challenge.name}**\n${challenge.description}\n*Progress: ${progressText} • Reward: ${challenge.reward.coins} coins, ${challenge.reward.exp} XP*`;
      }).join('\n\n'),
      inline: false
    });
  }

  // Add progress summary
  const dailyProgress = challenges.daily ? challenges.daily.filter(challenge => {
    const playerChallenge = updatedPlayerData.challenges.daily[challenge.id];
    return playerChallenge && playerChallenge.completed;
  }).length : 0;
  
  const weeklyProgress = challenges.weekly ? challenges.weekly.filter(challenge => {
    const playerChallenge = updatedPlayerData.challenges.weekly[challenge.id];
    return playerChallenge && playerChallenge.completed;
  }).length : 0;

  embed.addFields({
    name: '📈 Progress Summary',
    value: `**Daily:** ${dailyProgress}/${challenges.daily ? challenges.daily.length : 0} completed\n**Weekly:** ${weeklyProgress}/${challenges.weekly ? challenges.weekly.length : 0} completed`,
    inline: true
  });

  // Add refresh button
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('refresh_challenges')
        .setLabel('🔄 Refresh')
        .setStyle(ButtonStyle.Secondary)
    );

  await interaction.update({ embeds: [embed], components: [row] });
}

async function handleShopActions(interaction) {
  const fishingGame = require('./services/fishing');
  const parts = interaction.customId.split('_');
  const action = parts[1];

  if (action === 'purchase') {
    // Handle purchase
    const itemType = parts[2];
    const itemKey = parts.slice(3).join('_'); // Handle keys with underscores
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);
    const shopData = fishingGame.loadData().shop;

    let itemCategory, itemName;

    if (itemType === 'rod') {
      itemCategory = shopData.rods;
      itemName = 'rod';
    } else if (itemType === 'bait') {
      itemCategory = shopData.bait;
      itemName = 'bait';
    } else if (itemType === 'hook') {
      itemCategory = shopData.hooks;
      itemName = 'hook';
    }

    if (!itemCategory || !itemCategory[itemKey]) {
      return await interaction.reply({
        content: '❌ **Item Not Available!**\n\nThis item may no longer be available or there might be an issue with the shop. Please refresh the shop menu and try again.',
        flags: 64
      });
    }

    const item = itemCategory[itemKey];
    const cost = item.cost;

    // Check if player can afford it
    if (playerData.coins < cost) {
      return await interaction.reply({
        content: `❌ You don't have enough coins! You need ${cost} coins, but only have ${playerData.coins}.`,
        flags: 64
      });
    }

    // Check if already equipped
    if (playerData.equipment[itemName] === itemKey) {
      return await interaction.reply({
        content: `❌ You already have the ${item.name} equipped!`,
        flags: 64
      });
    }

    // Purchase the item
    playerData.coins -= cost;
    playerData.equipment[itemName] = itemKey;

    fishingGame.updatePlayerData(userId, {
      coins: playerData.coins,
      equipment: playerData.equipment
    });

    const embed = new EmbedBuilder()
      .setTitle('✅ Purchase Successful!')
      .setDescription(`**${item.name}** equipped!\n\n*${item.description}*`)
      .setColor(0x00ff00)
      .addFields({
        name: '💰 Remaining Coins',
        value: `${playerData.coins} coins`,
        inline: true
      })
      .setFooter({
        text: `Purchased by ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    await interaction.reply({ embeds: [embed], flags: 0 });

    return;
  }

  if (action === 'rods') {
    // Show rods shop
    const shopData = fishingGame.loadData().shop;
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);

    const embed = new EmbedBuilder()
      .setTitle('🎣 Fishing Rods')
      .setDescription(`**Your Coins:** ${playerData.coins} 🪙\n**Current Rod:** ${shopData.rods[playerData.equipment.rod].name}`)
      .setColor(0x8b4513)
      .setFooter({
        text: `Shop - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    // List rods
    let rodList = '';
    Object.entries(shopData.rods).forEach(([key, rod]) => {
      const equipped = playerData.equipment.rod === key ? ' ✅' : '';
      const canAfford = playerData.coins >= rod.cost;
      const priceText = canAfford ? `${rod.cost}🪙` : `~~${rod.cost}🪙~~ ❌`;
      
      rodList += `**${rod.name}** - ${priceText}${equipped}\n${rod.description}\n\n`;
    });

    embed.addFields({
      name: 'Available Rods',
      value: rodList,
      inline: false
    });

    // Create components array
    const components = [];

    // Create rod buttons row
    const rodRow = new ActionRowBuilder();
    Object.entries(shopData.rods).forEach(([key, rod]) => {
      const canAfford = playerData.coins >= rod.cost;
      const equipped = playerData.equipment.rod === key;
      
      let buttonLabel = rod.name;
      if (buttonLabel.length > 25) {
        buttonLabel = buttonLabel.substring(0, 22) + '...';
      }
      
      const button = new ButtonBuilder()
        .setCustomId(`shop_purchase_rod_${key}`)
        .setLabel(buttonLabel)
        .setStyle(canAfford ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!canAfford || equipped);
      
      rodRow.addComponents(button);
    });
    
    components.push(rodRow);

    // Add navigation row
    const navRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_main')
          .setLabel('⬅️ Back to Shop')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('🏠 Home')
          .setStyle(ButtonStyle.Primary)
      );

    components.push(navRow);

    await interaction.update({ embeds: [embed], components: components });

  } else if (action === 'bait') {
    // Show bait shop
    const shopData = fishingGame.loadData().shop;
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);

    const embed = new EmbedBuilder()
      .setTitle('🪱 Fishing Bait')
      .setDescription(`**Your Coins:** ${playerData.coins} 🪙\n**Current Bait:** ${shopData.bait[playerData.equipment.bait].name}`)
      .setColor(0x228b22)
      .setFooter({
        text: `Shop - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    // List bait
    let baitList = '';
    Object.entries(shopData.bait).forEach(([key, bait]) => {
      const equipped = playerData.equipment.bait === key ? ' ✅' : '';
      const canAfford = playerData.coins >= bait.cost;
      const priceText = canAfford ? `${bait.cost}🪙` : `~~${bait.cost}🪙~~ ❌`;
      
      baitList += `**${bait.name}** - ${priceText}${equipped}\n${bait.description}\n\n`;
    });

    embed.addFields({
      name: 'Available Bait',
      value: baitList,
      inline: false
    });

    // Create components array
    const components = [];

    // Create bait buttons row
    const baitRow = new ActionRowBuilder();
    Object.entries(shopData.bait).forEach(([key, bait]) => {
      const canAfford = playerData.coins >= bait.cost;
      const equipped = playerData.equipment.bait === key;
      
      let buttonLabel = bait.name;
      if (buttonLabel.length > 25) {
        buttonLabel = buttonLabel.substring(0, 22) + '...';
      }
      
      const button = new ButtonBuilder()
        .setCustomId(`shop_purchase_bait_${key}`)
        .setLabel(buttonLabel)
        .setStyle(canAfford ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!canAfford || equipped);
      
      baitRow.addComponents(button);
    });
    
    components.push(baitRow);

    // Add navigation row
    const navRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_main')
          .setLabel('⬅️ Back to Shop')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('🏠 Home')
          .setStyle(ButtonStyle.Primary)
      );

    components.push(navRow);

    await interaction.update({ embeds: [embed], components: components });

  } else if (action === 'hooks') {
    // Show hooks shop
    const shopData = fishingGame.loadData().shop;
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);

    const embed = new EmbedBuilder()
      .setTitle('🪝 Fishing Hooks')
      .setDescription(`**Your Coins:** ${playerData.coins} 🪙\n**Current Hook:** ${shopData.hooks[playerData.equipment.hook].name}`)
      .setColor(0x708090)
      .setFooter({
        text: `Shop - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    // List hooks
    let hookList = '';
    Object.entries(shopData.hooks).forEach(([key, hook]) => {
      const equipped = playerData.equipment.hook === key ? ' ✅' : '';
      const canAfford = playerData.coins >= hook.cost;
      const priceText = canAfford ? `${hook.cost}🪙` : `~~${hook.cost}🪙~~ ❌`;
      
      hookList += `**${hook.name}** - ${priceText}${equipped}\n${hook.description}\n\n`;
    });

    embed.addFields({
      name: 'Available Hooks',
      value: hookList,
      inline: false
    });

    // Create components array
    const components = [];

    // Create hook buttons row
    const hookRow = new ActionRowBuilder();
    Object.entries(shopData.hooks).forEach(([key, hook]) => {
      const canAfford = playerData.coins >= hook.cost;
      const equipped = playerData.equipment.hook === key;
      
      let buttonLabel = hook.name;
      if (buttonLabel.length > 25) {
        buttonLabel = buttonLabel.substring(0, 22) + '...';
      }
      
      const button = new ButtonBuilder()
        .setCustomId(`shop_purchase_hook_${key}`)
        .setLabel(buttonLabel)
        .setStyle(canAfford ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!canAfford || equipped);
      
      hookRow.addComponents(button);
    });
    
    components.push(hookRow);

    // Add navigation row
    const navRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_main')
          .setLabel('⬅️ Back to Shop')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('🏠 Home')
          .setStyle(ButtonStyle.Primary)
      );

    components.push(navRow);

    await interaction.update({ embeds: [embed], components: components });

  } else if (action === 'sell') {
    // Show sell interface
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);
    const marketData = fishingGame.loadData().market;

    const embed = new EmbedBuilder()
      .setTitle('💰 Sell Your Fish')
      .setDescription('Click on a fish below to sell it:')
      .setColor(0xffd700)
      .setFooter({
        text: `Market - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    // Create dynamic buttons for each fish
    const components = [];
    let currentRow = new ActionRowBuilder();
    let buttonCount = 0;
    const maxButtonsPerRow = 5;
    const maxRows = 5;

    if (Object.keys(playerData.inventory).length === 0) {
      embed.addFields({
        name: '📦 Your Inventory',
        value: 'You have no fish to sell! Go catch some first! 🎣',
        inline: false
      });
    } else {
      let inventoryText = '';
      Object.entries(playerData.inventory).forEach(([fishName, quantity]) => {
        const fishInfo = marketData.fish_prices[fishName];
        if (fishInfo) {
          const totalValue = fishInfo.basePrice * quantity;
          const displayName = fishName.replace('_', ' ');
          inventoryText += `**${displayName}** x${quantity} - ${totalValue}🪙\n`;

          // Create sell button for this fish
          if (buttonCount < maxButtonsPerRow * maxRows) {
            // Truncate fish name if too long for button label (Discord limit: 25 chars)
            let buttonLabel = `${displayName} (${quantity})`;
            if (buttonLabel.length > 25) {
              buttonLabel = `${displayName.substring(0, 20)}... (${quantity})`;
            }

            const button = new ButtonBuilder()
              .setCustomId(`sell_fish_${fishName}_${quantity}`)
              .setLabel(buttonLabel)
              .setStyle(ButtonStyle.Success);

            currentRow.addComponents(button);
            buttonCount++;

            // If row is full or we've reached max buttons per row, start new row
            if (currentRow.components.length >= maxButtonsPerRow) {
              components.push(currentRow);
              currentRow = new ActionRowBuilder();
            }
          }
        }
      });

      embed.addFields({
        name: '📦 Your Inventory',
        value: inventoryText || 'No sellable fish found.',
        inline: false
      });

      // Add the last row if it has components
      if (currentRow.components.length > 0) {
        components.push(currentRow);
      }
    }

    // Add navigation buttons in a separate row
    const navRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('sell_all_fish')
          .setLabel('💰 Sell Everything')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('shop_main')
          .setLabel('⬅️ Back to Shop')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('🏠 Home')
          .setStyle(ButtonStyle.Primary)
      );

    components.push(navRow);

    await interaction.update({ embeds: [embed], components: components });

  } else if (action === 'inventory') {
    // Show inventory
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);

    const embed = new EmbedBuilder()
      .setTitle('📦 Your Inventory')
      .setColor(0x9370db)
      .setFooter({
        text: `Inventory - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    if (Object.keys(playerData.inventory).length === 0) {
      embed.setDescription('Your inventory is empty! Go catch some fish! 🎣');
    } else {
      let inventoryText = '';
      Object.entries(playerData.inventory).forEach(([fishName, quantity]) => {
        inventoryText += `**${fishName.replace('_', ' ')}** x${quantity}\n`;
      });

      embed.setDescription('Here\'s what you have:');
      embed.addFields({
        name: '🐟 Fish',
        value: inventoryText,
        inline: false
      });
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_main')
          .setLabel('⬅️ Back to Shop')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('🏠 Home')
          .setStyle(ButtonStyle.Primary)
      );

    await interaction.update({ embeds: [embed], components: [row] });

  } else if (action === 'main') {
    // Back to main shop
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);

    const embed = new EmbedBuilder()
      .setTitle('🛒 Fishing Shop')
      .setDescription(`**Welcome back!**\n\n**Your Coins:** ${playerData.coins} 🪙\n\nChoose what you'd like to browse:`)
      .setColor(0x00ff00)
      .setFooter({
        text: `Shop - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_rods')
          .setLabel('🎣 Rods')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('shop_bait')
          .setLabel('🪱 Bait')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('shop_hooks')
          .setLabel('🪝 Hooks')
          .setStyle(ButtonStyle.Primary)
      );

    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_sell')
          .setLabel('💰 Sell Fish')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('shop_inventory')
          .setLabel('📦 Inventory')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.update({ embeds: [embed], components: [row1, row2] });
  }
}

async function handleStatsActions(interaction) {
  const fishingGame = require('./services/fishing');
  const action = interaction.customId.split('_')[1];
  const userId = interaction.user.id;
  const playerData = fishingGame.getPlayerData(userId);

  if (action === 'challenges') {
    // Show challenges
    fishingGame.checkDailyChallenges(userId);
    fishingGame.checkWeeklyChallenges(userId);
    
    const data = fishingGame.loadData();
    const challenges = data.challenges;
    
    const embed = new EmbedBuilder()
      .setTitle('🎯 Your Fishing Challenges')
      .setColor(0x4a90e2)
      .setFooter({
        text: `Challenges - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      })
      .setTimestamp();

    if (challenges.daily && challenges.daily.length > 0) {
      const dailyText = challenges.daily.map(challenge => {
        const playerChallenge = playerData.challenges.daily[challenge.id];
        const completed = playerChallenge && playerChallenge.completed;
        const progress = playerChallenge ? playerChallenge.progress : 0;
        const target = challenge.target;
        
        const status = completed ? '✅' : '⏳';
        return `${status} **${challenge.name}** (${progress}/${target})`;
      }).join('\n');

      embed.addFields({
        name: '📅 Daily Challenges',
        value: dailyText,
        inline: false
      });
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('stats_main')
          .setLabel('⬅️ Back to Stats')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('🏠 Home')
          .setStyle(ButtonStyle.Primary)
      );

    await interaction.update({ embeds: [embed], components: [row] });

  } else if (action === 'achievements') {
    // Show achievements
    const data = fishingGame.loadData();
    const allAchievements = data.achievements;
    
    const embed = new EmbedBuilder()
      .setTitle('🏆 Your Fishing Achievements')
      .setColor(0xffd700)
      .setDescription(`**Progress:** ${playerData.achievements.length}/${allAchievements.length} unlocked`)
      .setFooter({
        text: `${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      })
      .setTimestamp();

    // Show recent achievements
    const recentAchievements = allAchievements
      .filter(ach => playerData.achievements.includes(ach.id))
      .slice(-5); // Last 5 achievements

    if (recentAchievements.length > 0) {
      const achievementText = recentAchievements.map(ach => 
        `${ach.emoji} **${ach.name}** - ${ach.description}`
      ).join('\n');

      embed.addFields({
        name: '🏅 Recent Achievements',
        value: achievementText,
        inline: false
      });
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('stats_main')
          .setLabel('⬅️ Back to Stats')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('🏠 Home')
          .setStyle(ButtonStyle.Primary)
      );

    await interaction.update({ embeds: [embed], components: [row] });

  } else if (action === 'weather') {
    // Show weather
    const currentWeather = fishingGame.getCurrentWeather();
    const data = fishingGame.loadData();
    const weatherEffects = data.weather.effects;
    
    const embed = new EmbedBuilder()
      .setTitle('🌤️ Current Fishing Weather')
      .setDescription(`**${currentWeather.charAt(0).toUpperCase() + currentWeather.slice(1)}**`)
      .setColor(0x87ceeb)
      .addFields(
        {
          name: '📊 Catch Rate Multiplier',
          value: `${weatherEffects[currentWeather].catchMultiplier}x`,
          inline: true
        },
        {
          name: '💬 Conditions',
          value: weatherEffects[currentWeather].message,
          inline: true
        }
      )
      .setFooter({
        text: 'Weather affects fishing success rates',
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      })
      .setTimestamp();

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('stats_main')
          .setLabel('⬅️ Back to Stats')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('🏠 Home')
          .setStyle(ButtonStyle.Primary)
      );

    await interaction.update({ embeds: [embed], components: [row] });

  } else if (action === 'minigame') {
    // Show mini-game stats
    const embed = new EmbedBuilder()
      .setTitle('🎮 Mini-Game Statistics')
      .setColor(0xff6b35)
      .setDescription('Practice your fishing skills!')
      .addFields({
        name: '📊 Your Mini-Game Stats',
        value: 
          `**Last Mini-Game:** ${playerData.lastMiniGame ? new Date(playerData.lastMiniGame).toLocaleString() : 'Never'}\n` +
          `**Total Casts:** ${playerData.stats.totalCasts || 0}\n` +
          `**Practice Ready:** ${Date.now() - playerData.lastMiniGame > 30000 ? '✅' : '⏰'}`,
        inline: false
      })
      .setFooter({
        text: `Mini-Games - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('minigame_retry_common')
          .setLabel('🎮 Play Mini-Game')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('stats_main')
          .setLabel('⬅️ Back to Stats')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('🏠 Home')
          .setStyle(ButtonStyle.Primary)
      );

    await interaction.update({ embeds: [embed], components: [row] });

  } else if (action === 'main') {
    // Back to main stats
    const embed = new EmbedBuilder()
      .setTitle('📊 Fishing Statistics')
      .setDescription(`**Your Fishing Profile**\n\n**Level:** ${playerData.level}\n**Experience:** ${playerData.experience}\n**Coins:** ${playerData.coins}\n\nChoose what stats you'd like to view:`)
      .setColor(0x4a90e2)
      .setFooter({
        text: `Stats - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      })
      .setTimestamp();

    // Quick stats
    embed.addFields({
      name: '🎣 Fishing Stats',
      value: 
        `**Total Casts:** ${playerData.stats.totalCasts || 0}\n` +
        `**Fish Caught:** ${playerData.stats.totalFish || 0}\n` +
        `**Rare Fish:** ${playerData.stats.rareFish || 0}\n` +
        `**Legendary Fish:** ${playerData.stats.legendaryFish || 0}\n` +
        `**Biggest Catch:** ${playerData.stats.biggestCatch || 0} lbs`,
      inline: true
    });

    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('stats_challenges')
          .setLabel('🎯 Challenges')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('stats_achievements')
          .setLabel('🏆 Achievements')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('stats_weather')
          .setLabel('🌤️ Weather')
          .setStyle(ButtonStyle.Secondary)
      );

    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('stats_minigame')
          .setLabel('🎮 Mini-Game')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('fish_quick_cast')
          .setLabel('🎣 Go Fish!')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.update({ embeds: [embed], components: [row1, row2] });
  }
}

async function handleFishQuickActions(interaction) {
  const fishingGame = require('./services/fishing');
  const [action] = interaction.customId.split('_').slice(1);

  if (action === 'quick') {
    // Quick cast - use default river location
    const userId = interaction.user.id;
    const allowedChannelId = '1410703437502353428';

    // Check if command is used in the correct channel
    if (interaction.channelId !== allowedChannelId) {
      return await interaction.reply({
        content: `❌ Fishing is only allowed in the designated fishing channel! Please use the fishing commands there.`,
        flags: 64
      });
    }

    const playerData = fishingGame.getPlayerData(userId);

    await interaction.deferUpdate();

    try {
      // Check cooldown
      const now = Date.now();
      const lastCast = playerData.lastCast || 0;
      const cooldown = 1000;

      if (now - lastCast < cooldown) {
        const remaining = Math.ceil((cooldown - (now - lastCast)) / 1000);
        return await interaction.editReply(`⏰ **Cooldown Active!** You must wait ${remaining} seconds before casting again.`);
      }

      fishingGame.updatePlayerData(userId, { lastCast: now });
      const catchResult = fishingGame.attemptCatch(userId, 'river');

      const embed = new EmbedBuilder()
        .setTitle('🎣 Quick Fishing Adventure')
        .setColor(catchResult.success ? fishingGame.getRarityColor(catchResult.fish.rarity) : 0x666666)
        .setFooter({
          text: `Level ${playerData.level} Fisher • ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        });

      if (catchResult.success) {
        const fish = catchResult.fish;
        const emoji = fishingGame.getRarityEmoji(fish.rarity);
        
        embed.setDescription(`**🏞️ Tranquil River**

${emoji} **You caught a ${fish.name.replace('_', ' ')}!**

**Weight:** ${fish.weight} lbs
**Value:** ${fish.value} coins
**Rarity:** ${fish.rarity.charAt(0).toUpperCase() + fish.rarity.slice(1)}`);

        embed.addFields({
          name: '🌤️ Weather',
          value: catchResult.weather,
          inline: true
        });

        if (catchResult.miniGame && catchResult.miniGame.success) {
          embed.addFields({
            name: '🎮 Mini-Game Bonus!',
            value: catchResult.miniGame.message,
            inline: true
          });
        }
      } else {
        embed.setDescription(`**🏞️ Tranquil River**

🎣 **No fish this time!**

*The waters remain mysterious... try again!*`);

        embed.addFields({
          name: '🌤️ Weather',
          value: catchResult.weather,
          inline: true
        });
      }

      // Add quick action buttons
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('fish_quick_cast')
            .setLabel('🎣 Cast Again')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('fish_view_challenges')
            .setLabel('🎯 Challenges')
            .setStyle(ButtonStyle.Secondary)
        );

      await interaction.editReply({ embeds: [embed], components: [row] });

    } catch (error) {
      console.error('Quick cast error:', error);
      await interaction.editReply('❌ Something went wrong with your fishing trip! Please try again.');
    }

  } else if (action === 'help') {
    // Show main fishing help menu
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);

    const embed = new EmbedBuilder()
      .setTitle('🎣 Fishing Game')
      .setDescription(`**Welcome to the Fishing Game!**\n\n**Your Stats:**\n• Level: ${playerData.level}\n• Coins: ${playerData.coins}\n• Experience: ${playerData.experience}\n\nChoose what you'd like to do:`)
      .setColor(0x00ff00)
      .setFooter({
        text: `Fishing Game - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('fish_quick_cast')
          .setLabel('🎣 Go Fishing!')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('shop_main')
          .setLabel('🛒 Shop')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('stats_main')
          .setLabel('📊 Stats')
          .setStyle(ButtonStyle.Secondary)
      );

    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('fish_view_challenges')
          .setLabel('🎯 Challenges')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('fish_view_achievements')
          .setLabel('🏆 Achievements')
          .setStyle(ButtonStyle.Success)
      );

    await interaction.update({ embeds: [embed], components: [row1, row2] });

  } else if (action === 'view') {
    const subAction = interaction.customId.split('_')[2];
    
    if (subAction === 'challenges') {
      // Show challenges
      const userId = interaction.user.id;
      const playerData = fishingGame.getPlayerData(userId);
      
      fishingGame.checkDailyChallenges(userId);
      fishingGame.checkWeeklyChallenges(userId);
      
      const data = fishingGame.loadData();
      const challenges = data.challenges;
      
      const embed = new EmbedBuilder()
        .setTitle('🎯 Your Fishing Challenges')
        .setColor(0x4a90e2)
        .setFooter({
          text: `Challenges for ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      if (challenges.daily && challenges.daily.length > 0) {
        const dailyText = challenges.daily.map(challenge => {
          const playerChallenge = playerData.challenges.daily[challenge.id];
          const completed = playerChallenge && playerChallenge.completed;
          const progress = playerChallenge ? playerChallenge.progress : 0;
          const target = challenge.target;
          
          const status = completed ? '✅' : '⏳';
          return `${status} **${challenge.name}** (${progress}/${target})`;
        }).join('\n');

        embed.addFields({
          name: '📅 Daily Challenges',
          value: dailyText,
          inline: false
        });
      }

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('fish_quick_cast')
            .setLabel('🎣 Go Fish')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('refresh_challenges')
            .setLabel('🔄 Refresh')
            .setStyle(ButtonStyle.Secondary)
        );

      await interaction.update({ embeds: [embed], components: [row] });

    } else if (subAction === 'achievements') {
      // Show achievements
      const userId = interaction.user.id;
      const playerData = fishingGame.getPlayerData(userId);
      const data = fishingGame.loadData();
      const allAchievements = data.achievements;
      
      const embed = new EmbedBuilder()
        .setTitle('🏆 Your Fishing Achievements')
        .setColor(0xffd700)
        .setDescription(`**Progress:** ${playerData.achievements.length}/${allAchievements.length} unlocked`)
        .setFooter({
          text: `${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      // Show recent achievements
      const recentAchievements = allAchievements
        .filter(ach => playerData.achievements.includes(ach.id))
        .slice(-5); // Last 5 achievements

      if (recentAchievements.length > 0) {
        const achievementText = recentAchievements.map(ach => 
          `${ach.emoji} **${ach.name}** - ${ach.description}`
        ).join('\n');

        embed.addFields({
          name: '🏅 Recent Achievements',
          value: achievementText,
          inline: false
        });
      }

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('fish_quick_cast')
            .setLabel('🎣 Go Fish')
            .setStyle(ButtonStyle.Primary)
        );

      await interaction.update({ embeds: [embed], components: [row] });
    }
  }
}

async function announceTournamentWinner(channel, tournament) {
  try {
    if (!tournament.scores || Object.keys(tournament.scores).length === 0) {
      await channel.send(`🏆 **${tournament.name}** has ended! No participants scored any points.`);
      return;
    }

    // Sort participants by score
    const leaderboard = Object.entries(tournament.scores)
      .sort(([,a], [,b]) => b.score - a.score);

    const [winnerId, winnerScore] = leaderboard[0];
    const winner = await channel.client.users.fetch(winnerId).catch(() => null);
    const winnerName = winner ? winner.username : 'Unknown Fisher';

    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${tournament.name} - FINISHED!`)
      .setDescription(`**Winner: ${winnerName}** with ${winnerScore.score} points!`)
      .setColor(0xffd700)
      .addFields({
        name: '📊 Final Statistics',
        value: `Fish Caught: ${winnerScore.totalFish}\nTotal Weight: ${winnerScore.totalWeight}lbs\nRare Fish: ${winnerScore.rareFish}`,
        inline: true
      });

    // Top 3 leaderboard
    let leaderboardText = '';
    for (let i = 0; i < Math.min(3, leaderboard.length); i++) {
      const [userId, score] = leaderboard[i];
      const user = await channel.client.users.fetch(userId).catch(() => null);
      const username = user ? user.username : 'Unknown User';
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
      
      leaderboardText += `${medal} ${username} - ${score.score} points\n`;
    }

    embed.addFields({
      name: '🏅 Top 3',
      value: leaderboardText,
      inline: false
    });

    // Award prizes
    const fishingGame = require('./services/fishing');
    const prizePool = (tournament.entryFee || 0) * (tournament.participants?.length || 0);
    
    if (prizePool > 0) {
      // Give prize to winner
      const winnerData = fishingGame.getPlayerData(winnerId);
      winnerData.coins += prizePool;
      fishingGame.updatePlayerData(winnerId, { coins: winnerData.coins });
      
      embed.addFields({
        name: '💰 Prize Awarded',
        value: `${winnerName} received ${prizePool} coins!`,
        inline: true
      });
    }

    await channel.send({ embeds: [embed] });
    
  } catch (error) {
    console.error('Tournament winner announcement failed:', error);
    await channel.send(`🏆 **${tournament.name}** has ended! Check the leaderboard for results.`);
  }
}process.on('SIGINT', () => {
  console.log('Bot is shutting down...');
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
// index.js
