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

  if (interaction.isButton()) {
    // Handle button interactions for games
    if (interaction.customId.startsWith('guess_')) {
      await handleGuessGame(interaction);
      return;
    }
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
  }

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
      content: '❌ Invalid item selection!',
      ephemeral: true
    });
  }

  const item = itemCategory[itemKey];
  cost = item.cost;

  // Check if player can afford it
  if (playerData.coins < cost) {
    return await interaction.reply({
      content: `❌ You don't have enough coins! You need ${cost} coins, but only have ${playerData.coins}.`,
      ephemeral: true
    });
  }

  // Check if already equipped
  if (playerData.equipment[itemName] === itemKey) {
    return await interaction.reply({
      content: `❌ You already have the ${item.name} equipped!`,
      ephemeral: true
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

  await interaction.reply({ embeds: [embed], ephemeral: false });
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
      content: `❌ Invalid fish selection! Fish: ${fishName}`,
      ephemeral: true
    });
  }

  // Check if player has enough fish
  if (!playerData.inventory[fishName] || playerData.inventory[fishName] < quantity) {
    return await interaction.reply({
      content: `❌ You don't have enough ${fishName.replace('_', ' ')} to sell!`,
      ephemeral: true
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

  await interaction.reply({ embeds: [embed], ephemeral: false });
}process.on('SIGINT', () => {
  console.log('Bot is shutting down...');
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
// index.js
