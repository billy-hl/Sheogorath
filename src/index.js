'use strict';
require('dotenv').config();

const fs = require('fs');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const schedule = require('node-schedule');
const { getState, setState } = require('./storage/state');
const { getNewArticles } = require('./services/rss-feed');
const { getAIResponse, getAIResponseWithHistory } = require('./ai/grok');
const { handleInstagramLinks } = require('./services/instagram');
const { stopPlaying } = require('./music/player');

// Channel IDs from environment
const UFC_NEWS_CHANNEL_ID = process.env.UFC_NEWS_CHANNEL_ID || '1462490563155726367';
const AI_CHANNEL_ID = process.env.AI_CHANNEL_ID || '380486887309180929';

let lastInteractionTime = Date.now();
const conversationHistory = new Map();

const requiredEnv = [
  'GROK_API_KEY',
  'CLIENT_NAME',
  'CLIENT_INSTRUCTIONS',
  'CLIENT_MODEL',
  'CHANNEL_ID',
  'DISCORD_TOKEN',
  'POLLING_RETRIES',
  'POLLING_TIMEOUT',
  'GUILD_ID',
  'DEFAULT_IMAGE_URL',
];

const missingEnv = requiredEnv.filter((envVar) => !process.env[envVar]);

if (missingEnv.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(', ')}`
  );
  process.exit(1);
}



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

  // Sherdog MMA RSS Feed Monitoring - Check every 15 minutes
  const SHERDOG_RSS = 'https://www.sherdog.com/rss/news.xml';
  let lastMMAArticleGuid = null;
  
  schedule.scheduleJob('*/15 * * * *', async () => {
    try {
      const newArticles = await getNewArticles(SHERDOG_RSS, lastMMAArticleGuid);
      
      if (newArticles.length > 0) {
        const channel = await client.channels.fetch(UFC_NEWS_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) return;
        
        // Post new articles (newest first, limit to 3 per check to avoid spam)
        for (const article of newArticles.slice(0, 3).reverse()) {
          const embed = {
            color: 0xE31C23, // Sherdog red
            author: {
              name: 'Sherdog MMA News',
              icon_url: 'https://www.sherdog.com/favicon.ico',
              url: 'https://www.sherdog.com/news'
            },
            title: `🥊 ${article.title}`,
            url: article.link,
            description: article.content || 'Click to read the full article',
            image: {
              url: 'https://dmxg5wxfqgb4u.cloudfront.net/styles/card/s3/2024-08/081724-UFC-306-Sean-OMalley-Merab-Dvalishvili-Press-Conference-THUMB-GettyImages-2165279081.jpg?itok=_XdXLNh7'
            },
            fields: article.categories && article.categories.length > 0 ? [
              {
                name: '📁 Category',
                value: article.categories[0],
                inline: true
              }
            ] : [],
            timestamp: new Date(article.pubDate).toISOString(),
            footer: { 
              text: 'Sherdog',
              icon_url: 'https://www.sherdog.com/favicon.ico'
            }
          };
          
          await channel.send({ embeds: [embed] });
          
          // Small delay between posts
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Update last seen article
        lastMMAArticleGuid = newArticles[0].guid;
        setState({ lastMMAArticleGuid });
      }
    } catch (e) {
      console.error('MMA RSS feed check failed:', e.message);
    }
  });
  
  // Initialize last article GUID from state
  const state = getState();
  if (state.lastMMAArticleGuid) {
    lastMMAArticleGuid = state.lastMMAArticleGuid;
  }

  // Run RSS check immediately on startup (after 5 seconds delay)
  setTimeout(async () => {
    console.log('Running initial MMA RSS feed check...');
    try {
      const newArticles = await getNewArticles(SHERDOG_RSS, lastMMAArticleGuid);
      console.log(`Found ${newArticles.length} new articles`);
      
      if (newArticles.length > 0) {
        const channel = await client.channels.fetch(UFC_NEWS_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) {
          console.error('UFC news channel not found or not text-based');
          return;
        }
        
        console.log(`Posting to channel ${UFC_NEWS_CHANNEL_ID}`);
        
        // Post new articles (newest first, limit to 3 per check to avoid spam)
        for (const article of newArticles.slice(0, 3).reverse()) {
          const embed = {
            color: 0xE31C23, // Sherdog red
            author: {
              name: 'Sherdog MMA News',
              icon_url: 'https://www.sherdog.com/favicon.ico',
              url: 'https://www.sherdog.com/news'
            },
            title: `🥊 ${article.title}`,
            url: article.link,
            description: article.content || 'Click to read the full article',
            image: {
              url: 'https://dmxg5wxfqgb4u.cloudfront.net/styles/card/s3/2024-08/081724-UFC-306-Sean-OMalley-Merab-Dvalishvili-Press-Conference-THUMB-GettyImages-2165279081.jpg?itok=_XdXLNh7'
            },
            fields: article.categories && article.categories.length > 0 ? [
              {
                name: '📁 Category',
                value: article.categories[0],
                inline: true
              }
            ] : [],
            timestamp: new Date(article.pubDate).toISOString(),
            footer: { 
              text: 'Sherdog',
              icon_url: 'https://www.sherdog.com/favicon.ico'
            }
          };
          
          await channel.send({ embeds: [embed] });
          
          console.log(`Posted article: ${article.title}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        lastMMAArticleGuid = newArticles[0].guid;
        setState({ lastMMAArticleGuid });
        console.log('Initial RSS feed check complete');
      } else {
        console.log('No new articles found');
      }
    } catch (e) {
      console.error('Initial MMA RSS feed check failed:', e.message);
    }
  }, 5000);

  // 

  // Proactive AI engagement - random messages every 45 minutes
  schedule.scheduleJob('*/45 * * * *', async () => {
    try {
      const channel = await client.channels.fetch(AI_CHANNEL_ID);
      if (!channel || !channel.isTextBased()) return;
      
      // 3% chance to send a random engaging message
      if (Math.random() < 0.03) {
        // Fetch recent messages from the AI channel for context
        const recentMessages = await channel.messages.fetch({ limit: 20 });
        const conversationContext = [];
        
        for (const msg of recentMessages.filter(m => !m.author.bot || m.author.id === client.user.id).reverse().values()) {
          let msgContent = msg.author.id === client.user.id ? msg.content : `${msg.author.username}: ${msg.content}`;
          conversationContext.push({
            role: msg.author.id === client.user.id ? 'assistant' : 'user',
            content: msgContent
          });
        }

        const conversationalPrompts = [
          "Based on the recent conversation, share a relevant thought or continue the discussion in your chaotic style.",
          "Comment on something that was just discussed or ask a follow-up question about recent topics.",
          "Share your 'wisdom' about a topic that was mentioned recently, in your typical Mad King manner.",
          "React to the ongoing conversation with a sarcastic or threatening observation.",
          "Pick up on a theme from recent messages and elaborate on it chaotically."
        ];
        
        const randomPrompt = conversationalPrompts[Math.floor(Math.random() * conversationalPrompts.length)];
        
        const aiMessage = await getAIResponseWithHistory([
          ...conversationContext.slice(-10),
          { role: 'user', content: randomPrompt }
        ], 200);
        
        await channel.send(aiMessage);
      }
    } catch (e) {
      console.error('Proactive AI engagement failed:', e?.message || e);
    }
  });

});


client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  lastInteractionTime = Date.now();
  
  // Instagram video downloader
  await handleInstagramLinks(message);
  
  if (
    message.content.includes(`<@!${client.user.id}>`) ||
    message.content.includes(`<@${client.user.id}>`) ||
    message.content.toLowerCase().includes('@sheogorath') ||
    message.content.toLowerCase().includes('@sherogorath')
  ) {
    console.log(`Mention detected in channel ${message.channelId} by ${message.author.username}: ${message.content}`);
    askChatGPT(message);
  }
  
  // Conversational triggers - only respond to bot-specific mentions
  const content = message.content.toLowerCase();
  const triggers = [
    'sheogorath',
    'mad king',
    'sheo'
  ];
  
  const isTriggered = triggers.some(trigger => content.includes(trigger));
  
  if (isTriggered && !message.content.includes(`<@!${client.user.id}>`) && !message.content.includes(`<@${client.user.id}>`)) {
    askChatGPT(message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  lastInteractionTime = Date.now();

  try {
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

// Idle check - shut down bot after 1 hour of inactivity
setInterval(async () => {
  const currentTime = Date.now();
  const oneHour = 60 * 60 * 1000;

  if (currentTime - lastInteractionTime > oneHour) {
    console.log('Bot has been idle for 1 hour. Stopping all music playback.');

    // Stop music in all guilds
    try {
      client.guilds.cache.forEach(guild => {
        stopPlaying(guild.id);
      });
      console.log('✅ Stopped all music playback due to inactivity.');
    } catch (error) {
      console.error('Error stopping music:', error);
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
    const message = await getAIResponse(prompt);
    await channel.send(`🎉 ${message}`);
  } catch (error) {
    console.error('AI welcome message failed:', error);
    try {
      const channel = await client.channels.fetch(process.env.CHANNEL_ID);
      if (channel) await channel.send(`🎉 Welcome ${member.user.username}! The Mad King awaits your entertainment...`);
    } catch (e) { /* ignore */ }
  }
});

async function askChatGPT(userMessage) {
  userMessage.channel.sendTyping();
  
  const userId = userMessage.author.id;
  const history = conversationHistory.get(userId) || [];
  
  console.log(`Processing AI request from ${userMessage.author.username} in channel ${userMessage.channelId}`);
  
  try {
    // Clean up user mentions to use actual usernames
    let cleanedContent = userMessage.content;
    const mentionRegex = /<@!?(\d+)>/g;
    let match;
    while ((match = mentionRegex.exec(userMessage.content)) !== null) {
      try {
        const user = await client.users.fetch(match[1]);
        cleanedContent = cleanedContent.replace(match[0], `@${user.username}`);
      } catch (e) { /* keep original mention */ }
    }
    
    const messages = [
      ...history.slice(-5),
      { role: 'user', content: cleanedContent }
    ];
    
    const assistantReply = await getAIResponseWithHistory(messages);
    const finalReply = assistantReply && assistantReply.trim()
      ? assistantReply
      : "The Mad King contemplates your words... but finds them unworthy of a proper response. Try again, mortal!";
    
    // Store conversation (keep last 15 exchanges)
    history.push(
      { role: 'user', content: cleanedContent },
      { role: 'assistant', content: finalReply }
    );
    if (history.length > 30) history.splice(0, history.length - 30);
    conversationHistory.set(userId, history);
    
    // Reply in the same channel, or redirect to AI channel
    if (userMessage.channelId === AI_CHANNEL_ID) {
      await userMessage.reply(finalReply);
    } else {
      try {
        const aiChannel = await client.channels.fetch(AI_CHANNEL_ID);
        if (aiChannel?.isTextBased()) {
          await aiChannel.send(finalReply);
        } else {
          await userMessage.reply(finalReply);
        }
      } catch (e) {
        await userMessage.reply(finalReply);
      }
    }
  } catch (error) {
    console.error('Error in askChatGPT:', error.message);
    await userMessage.reply('❌ An error occurred while trying to fetch the AI response. The Mad King is... temporarily indisposed.');
  }
}

// Clean shutdown handler
process.on('SIGINT', () => {
  console.log('Bot is shutting down...');
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
