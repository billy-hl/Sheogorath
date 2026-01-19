'use strict';
require('dotenv').config();

// Suppress ytdl-core warnings globally and prevent debug file creation
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  if (args.some(arg => typeof arg === 'string' && 
      (arg.includes('decipher function') || arg.includes('n transform function')))) {
    return; // Suppress ytdl-core warnings
  }
  originalConsoleWarn(...args);
};

// Override fs.writeFileSync to prevent ytdl-core from creating debug files
const fs = require('fs');
const originalWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function(filename, ...args) {
  if (typeof filename === 'string' && filename.includes('player-script.js')) {
    return; // Prevent creating player-script.js files
  }
  return originalWriteFileSync.call(this, filename, ...args);
};
const { Client, GatewayIntentBits, Collection, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const schedule = require('node-schedule');
const { getState, setState } = require('./storage/state');

const fetch = require('node-fetch');
const { getNewArticles } = require('./services/rss-feed');

// Channel IDs
const UFC_NEWS_CHANNEL_ID = '1462490563155726367'; // UFC news channel

let greetServer = false; // Flag to track if the live stream has been announced
let lastInteractionTime = Date.now(); // Track the last interaction time
const conversationHistory = new Map(); // Store conversation history per user

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
      const channel = await client.channels.fetch('380486887309180929');
      if (!channel || !channel.isTextBased()) return;
      
      // 3% chance to send a random engaging message
      if (Math.random() < 0.03) {
        // Fetch recent messages from the AI channel for context
        const recentMessages = await channel.messages.fetch({ limit: 20 });
        const conversationContext = recentMessages
          .filter(msg => !msg.author.bot || msg.author.id === client.user.id)
          .reverse()
          .slice(-10) // Get last 10 relevant messages
          .map(async msg => {
            let content = msg.author.id === client.user.id ? msg.content : `${msg.author.username}: ${msg.content}`;
            
            // Clean up user mentions in conversation context
            if (msg.author.id !== client.user.id) {
              const mentionRegex = /<@!?(\d+)>/g;
              let match;
              while ((match = mentionRegex.exec(msg.content)) !== null) {
                const userId = match[1];
                try {
                  const user = await client.users.fetch(userId);
                  const username = user.username;
                  content = content.replace(match[0], `@${username}`);
                } catch (error) {
                  console.log(`Could not fetch user ${userId} in conversation context, keeping original mention`);
                }
              }
            }
            
            return {
              role: msg.author.id === client.user.id ? 'assistant' : 'user',
              content: content
            };
          });

        const conversationalPrompts = [
          "Based on the recent conversation, share a relevant thought or continue the discussion in your chaotic style.",
          "Comment on something that was just discussed or ask a follow-up question about recent topics.",
          "Share your 'wisdom' about a topic that was mentioned recently, in your typical Mad King manner.",
          "React to the ongoing conversation with a sarcastic or threatening observation.",
          "Pick up on a theme from recent messages and elaborate on it chaotically."
        ];
        
        const randomPrompt = conversationalPrompts[Math.floor(Math.random() * conversationalPrompts.length)];
        
        const axios = require('axios');
        const response = await axios.post('https://api.x.ai/v1/chat/completions', {
          model: 'grok-code-fast-1',
          messages: [
            { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
            ...conversationContext,
            { role: 'user', content: randomPrompt }
          ],
          max_tokens: 200,
          temperature: 0.7,
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
            'Content-Type': 'application/json',
          },
        });
        
        const message = response.data.choices[0].message.content;
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

});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  // Instagram video downloader
  const instagramRegex = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/gi;
  const instagramMatch = message.content.match(instagramRegex);
  
  if (instagramMatch) {
    const fs = require('fs');
    const path = require('path');
    const { promisify } = require('util');
    const exec = promisify(require('child_process').exec);
    
    for (const url of instagramMatch) {
      try {
        await message.channel.sendTyping();
        
        const outputPath = path.join(__dirname, '..', 'temp', `instagram_${Date.now()}.mp4`);
        const tempDir = path.join(__dirname, '..', 'temp');
        
        // Create temp directory if it doesn't exist
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        console.log(`Downloading Instagram video from: ${url}`);
        
        // Download with yt-dlp (no format specification - let yt-dlp choose best)
        const { stdout, stderr } = await exec(`yt-dlp --no-check-certificate -o "${outputPath}" "${url}"`);
        
        console.log('yt-dlp stdout:', stdout);
        if (stderr) console.log('yt-dlp stderr:', stderr);
        
        if (fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          const fileSizeMB = stats.size / (1024 * 1024);
          
          // Discord file size limit is 25MB for regular servers
          if (fileSizeMB > 24) {
            try {
              await message.reply('❌ Video is too large to upload (>24MB). Try a shorter clip!');
            } catch (permError) {
              console.log('Could not send message (missing permissions)');
            }
            fs.unlinkSync(outputPath);
            continue;
          }
          
          try {
            await message.reply({
              content: `🎬 Here's the Instagram video from ${message.author}:`,
              files: [outputPath]
            });
            console.log('✅ Instagram video sent successfully');
          } catch (sendError) {
            console.log('❌ Failed to send video. Error:', sendError.message);
            const permissions = message.channel.permissionsFor(message.guild.members.me);
            const hasAttachFiles = permissions.has('AttachFiles');
            console.log('Has AttachFiles permission:', hasAttachFiles);
            
            if (!hasAttachFiles) {
              try {
                await message.reply('❌ I downloaded the video but need the **Attach Files** permission to send it here!');
              } catch (e) {
                console.log('Could not send error message');
              }
            }
          }
          
          // Clean up
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } else {
          console.error('Video file not found after download');
        }
        
      } catch (error) {
        console.error('Instagram download error:', error.message || error);
        // Silently fail - don't try to react if we don't have permissions
      }
    }
  }
  
  if (
    message.content.includes(`<@!${client.user.id}>`) ||
    message.content.includes(`<@${client.user.id}>`) ||
    message.content.toLowerCase().includes('@sheogorath') ||
    message.content.toLowerCase().includes('@sherogorath')
  ) {
    console.log(`Mention detected in channel ${message.channelId} by ${message.author.username}: ${message.content}`);
    askChatGPT(message);
  }
  
  // Enhanced conversational triggers
  const content = message.content.toLowerCase();
  const triggers = [
    'sheogorath',
    'mad king',
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
    const axios = require('axios');
    const response = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-code-fast-1',
      messages: [
        { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
        { role: 'user', content: prompt }
      ],
      max_tokens: 200,
      temperature: 0.7,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    
    const message = response.data.choices[0].message.content;
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
  
  console.log(`Processing AI request from ${userMessage.author.username} in channel ${userMessage.channelId}`);
  
  try {
    // Clean up user mentions to use actual usernames instead of raw IDs
    let cleanedContent = userMessage.content;
    const mentionRegex = /<@!?(\d+)>/g;
    let match;
    while ((match = mentionRegex.exec(userMessage.content)) !== null) {
      const userId = match[1];
      try {
        const user = await client.users.fetch(userId);
        const username = user.username;
        cleanedContent = cleanedContent.replace(match[0], `@${username}`);
      } catch (error) {
        console.log(`Could not fetch user ${userId}, keeping original mention`);
        // Keep the original mention if we can't fetch the user
      }
    }
    
    const messages = [
      { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
      // Reduce conversation history to last 5 messages to save tokens
      ...history.slice(-5), // Keep last 5 messages for context
      { role: 'user', content: cleanedContent }
    ];
    
    const axios = require('axios');
    const response = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-code-fast-1',
      messages: messages,
      max_tokens: 500, // Increased significantly to give more room
      temperature: 0.7,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000, // Increased timeout
    });

    console.log(`Full API response:`, JSON.stringify(response.data, null, 2));
    console.log(`Response choices:`, response.data.choices);
    console.log(`Response choices length:`, response.data.choices ? response.data.choices.length : 'undefined');

    const assistantReply = response.data.choices[0].message.content;
    console.log(`AI response generated: ${assistantReply ? assistantReply.substring(0, 200) : 'EMPTY RESPONSE'}...`);
    console.log(`Response length: ${assistantReply ? assistantReply.length : 0} characters`);
    
    // Check if response is empty and provide fallback
    const finalReply = assistantReply && assistantReply.trim() ? assistantReply : "The Mad King contemplates your words... but finds them unworthy of a proper response. Try again, mortal!";
    
    // Store conversation (keep last 15 exchanges)
    history.push(
      { role: 'user', content: cleanedContent },
      { role: 'assistant', content: finalReply }
    );
    if (history.length > 30) { // Keep max 30 messages (15 exchanges)
      history.splice(0, history.length - 30);
    }
    conversationHistory.set(userId, history);
    
    // Send response to the designated AI channel instead of replying
    const aiChannelId = '380486887309180929';
    
    // If the mention is in the AI channel, reply directly
    if (userMessage.channelId === aiChannelId) {
      console.log(`Mention in AI channel, replying directly`);
      await userMessage.reply(finalReply);
    } else {
      // Try to send to AI channel, fallback to original channel
      try {
        const aiChannel = await client.channels.fetch(aiChannelId);
        if (aiChannel && aiChannel.isTextBased()) {
          await aiChannel.send(finalReply);
          console.log(`Response sent to AI channel ${aiChannel.id}`);
        } else {
          console.log(`AI channel not found, replying in original channel ${userMessage.channelId}`);
          await userMessage.reply(finalReply);
        }
      } catch (channelError) {
        console.log(`Error accessing AI channel, replying in original channel ${userMessage.channelId}:`, channelError.message);
        await userMessage.reply(finalReply);
      }
    }
  } catch (error) {
    console.error('Error in askChatGPT:', error);
    console.log(`Error details: ${error.message}`);
    console.log(`Sending error response to channel ${userMessage.channelId}`);
    await userMessage.reply('❌ An error occurred while trying to fetch the AI response. The Mad King is... temporarily indisposed.');
  }
}

async function greetChatGpt(channel, messageToSend) {
  try {
    const axios = require('axios');
    const response = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-code-fast-1',
      messages: [
        { role: 'system', content: process.env.CLIENT_INSTRUCTIONS || 'You are Grok, a helpful AI assistant.' },
        { role: 'user', content: messageToSend }
      ],
      max_tokens: 200,
      temperature: 0.7,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const assistantReply = response.data.choices[0].message.content;
    channel.send(assistantReply);
  } catch (error) {
    console.error('Error in greetChatGpt:', error);
    return 'An error occurred while trying to fetch the response.';
  }
}

// Clean shutdown handler
process.on('SIGINT', () => {
  console.log('Bot is shutting down...');
  
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
