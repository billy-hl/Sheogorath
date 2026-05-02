'use strict';
require('dotenv').config();

const fs = require('fs');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const { setUserActivity, getUserActivity, getUserNotes, addUserNote } = require('./storage/state');
const { getAIResponse, getAIResponseWithHistory } = require('./ai/grok');
const { handleInstagramLinks } = require('./services/instagram');
const { stopPlaying } = require('./music/player');
const { parseActions, executeActions } = require('./ai/actions');

// Channel IDs from environment
const AI_CHANNEL_ID = process.env.AI_CHANNEL_ID || '380486887309180929';

let lastInteractionTime = Date.now();
const conversationHistory = new Map();
// Per-user timers that fire a note-summarization pass 5 min after last exchange
const summarizeTimers = new Map();

const SUMMARIZE_DELAY_MS = 5 * 60 * 1000; // 5 minutes idle before summarizing
const SUMMARIZE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // once per 24 hours per user
const SUMMARIZE_MIN_MESSAGES = 6; // minimum messages before bothering

async function summarizeUserConversation(userId, username, history) {
  // Require a meaningful conversation
  if (!history || history.length < SUMMARIZE_MIN_MESSAGES) return;

  // 24-hour cooldown per user
  const activity = getUserActivity(userId);
  const lastRun = activity.lastNoteSummary ? new Date(activity.lastNoteSummary).getTime() : 0;
  if (Date.now() - lastRun < SUMMARIZE_COOLDOWN_MS) return;

  try {
    // Only send the last 6 messages (3 exchanges) to keep tokens low
    const transcript = history
      .slice(-6)
      .map(m => `${m.role === 'user' ? username : 'Sheogorath'}: ${m.content}`)
      .join('\n');

    const { getAIResponse } = require('./ai/grok');
    console.log(`[AutoNote] Running summarization for ${username} (${history.length} messages in history)`);
    const raw = await getAIResponse(
      `Based on this chat, write 1-2 short, brutally honest, NSFW and funny notes about "${username}". ` +
      `Be crude, savage, and specific. No filter. ` +
      `Return ONLY a JSON array of short strings. Example: ["Asks dumb questions after midnight", "Obsessed with UFC like a caveman"]\n\n${transcript}`,
      { rawSystemPrompt: 'You are a crude, uncensored note-taker. Respond only with a valid JSON array of strings. No extra text.', maxTokens: 100 }
    );
    console.log(`[AutoNote] Raw response for ${username}:`, raw);

    const jsonMatch = raw.match(/\[.*\]/s);
    if (!jsonMatch) return;
    const notes = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(notes)) return;

    for (const note of notes) {
      if (typeof note === 'string' && note.trim()) {
        addUserNote(userId, note.trim());
      }
    }

    // Record the time so we don't run again for 24h
    setUserActivity(userId, { lastNoteSummary: new Date().toISOString() });
    console.log(`[AutoNote] Saved ${notes.length} note(s) for ${username}`);
  } catch (e) {
    console.warn('[AutoNote] Summarization failed:', e?.message || e);
  }
}

const requiredEnv = [
  'GROK_API_KEY',
  'CLIENT_NAME',
  'CLIENT_INSTRUCTIONS',
  'CLIENT_MODEL',
  'CHANNEL_ID',
  'DISCORD_TOKEN',
  'GUILD_ID',
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
    GatewayIntentBits.GuildPresences,
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

  // Proactive AI engagement - random messages every 45 minutes
  setInterval(async () => {
    try {
      const channel = await client.channels.fetch(AI_CHANNEL_ID);
      if (!channel || !channel.isTextBased()) return;
      
      // 1% chance to send a random engaging message
      if (Math.random() < 0.01) {
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
  }, 45 * 60 * 1000); // 45 minutes

});


client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  lastInteractionTime = Date.now();

  // Track last chat time for this user
  setUserActivity(message.author.id, { lastChat: new Date().toISOString() });
  
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
    return; // Prevent conversational triggers from also firing
  }
  
  // Conversational triggers - only in AI channel, whole-word matches only
  // Skip if the message already contains a direct bot mention (handled above)
  const isMention = message.content.includes(`<@!${client.user.id}>`) ||
                    message.content.includes(`<@${client.user.id}>`);
  if (!isMention && message.channelId === AI_CHANNEL_ID) {
    const content = message.content.toLowerCase();
    const triggerPattern = /\b(sheogorath|mad king)\b/i;
    
    if (triggerPattern.test(content)) {
      askChatGPT(message);
    }
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
  // Track when a user joins a voice channel (was not in one, now is)
  if (!oldState.channelId && newState.channelId && newState.member && !newState.member.user.bot) {
    setUserActivity(newState.member.id, { lastVoiceJoin: new Date().toISOString() });
  }

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

// AI welcome messages for new members (rate-limited: 1 per 10 seconds)
let lastWelcomeTime = 0;
client.on('guildMemberAdd', async (member) => {
  const now = Date.now();
  if (now - lastWelcomeTime < 10000) return; // Skip if within 10s cooldown
  lastWelcomeTime = now;
  
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

// --- UFC Stream Announcements ---
const STREAM_ANNOUNCE_CHANNEL = process.env.ANNOUNCEMENTS_CHANNEL_ID || AI_CHANNEL_ID;
const WATCHED_STREAMER_ID = '1464671421102952581';
const streamAnnounceCooldown = new Map();

async function announceStream(guild, userId, streamName) {
  // Cooldown: 1 announcement per hour
  const lastAnnounce = streamAnnounceCooldown.get(userId) || 0;
  if (Date.now() - lastAnnounce < 60 * 60 * 1000) return;
  streamAnnounceCooldown.set(userId, Date.now());

  const isUFC = /\b(ufc|mma|fight\s*night|ppv)\b/i.test(streamName || '');

  try {
    const channel = await client.channels.fetch(STREAM_ANNOUNCE_CHANNEL);
    if (!channel || !channel.isTextBased()) return;

    const member = await guild.members.fetch(userId);
    const displayName = member.displayName || member.user.username;

    if (isUFC) {
      const prompt = `Announce that ${displayName} is now streaming UFC/MMA live on Discord. Hype it up. Keep it under 200 characters.`;
      const announcement = await getAIResponse(prompt);
      await channel.send(`${announcement}\n\n<@${userId}> is live! <@&1269321898035249325>`);
    } else {
      await channel.send(`<@${userId}> is now streaming${streamName ? ` **${streamName}**` : ''}! <@&1269321898035249325>`);
    }
    console.log(`Stream announcement sent for ${displayName}`);
  } catch (error) {
    console.error('Stream announcement error:', error.message);
  }
}

// Detect Rich Presence streaming (Twitch/YouTube linked streams)
client.on('presenceUpdate', async (oldPresence, newPresence) => {
  if (!newPresence || newPresence.userId !== WATCHED_STREAMER_ID) return;

  const wasStreaming = oldPresence?.activities?.some(a => a.type === 1) || false;
  const streaming = newPresence.activities.find(a => a.type === 1);

  if (!streaming || wasStreaming) return;

  const streamName = streaming.details || streaming.state || streaming.name || '';
  await announceStream(newPresence.guild, newPresence.userId, streamName);
});

// Detect Go Live / screen share in voice channels
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.id !== WATCHED_STREAMER_ID) return;

  // User started streaming (Go Live)
  if (!oldState.streaming && newState.streaming) {
    console.log(`Go Live detected for user ${newState.id} in ${newState.channel?.name}`);
    const streamName = newState.channel?.name || '';
    await announceStream(newState.guild, newState.id, streamName);
  }
});

async function askChatGPT(userMessage) {
  // Keep the "is typing" indicator alive every 8s until we're done
  userMessage.channel.sendTyping();
  const typingInterval = setInterval(() => {
    userMessage.channel.sendTyping().catch(() => {});
  }, 8000);
  
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
    
    // Build notes context for this user
    const userNotes = getUserNotes(userId);
    const notesContext = userNotes.length > 0
      ? `[Notes about this user (${userMessage.author.username})]:\n` +
        userNotes.map((n, i) => `${i + 1}. ${n.text} (recorded ${n.addedAt})`).join('\n') + '\n'
      : '';

    const messages = [
      ...history.slice(-5),
      { role: 'user', content: notesContext ? `${notesContext}\n${cleanedContent}` : cleanedContent }
    ];
    
    const assistantReply = await getAIResponseWithHistory(messages);
    const raw = assistantReply && assistantReply.trim()
      ? assistantReply
      : "The Mad King contemplates your words... but finds them unworthy of a proper response. Try again, mortal!";

    // Parse and execute any AI-initiated actions
    const { cleanResponse, actions } = parseActions(raw);
    if (actions.length > 0) {
      await executeActions(actions, { guild: userMessage.guild, message: userMessage });
    }
    const finalReply = cleanResponse || raw;
    
    // Store conversation (keep last 15 exchanges)
    history.push(
      { role: 'user', content: cleanedContent },
      { role: 'assistant', content: finalReply }
    );
    if (history.length > 30) history.splice(0, history.length - 30);
    conversationHistory.set(userId, history);

    // Schedule a post-conversation note summarization (resets on each message)
    if (summarizeTimers.has(userId)) clearTimeout(summarizeTimers.get(userId));
    const snapHistory = [...history];
    const snapUsername = userMessage.author.username;
    summarizeTimers.set(userId, setTimeout(async () => {
      summarizeTimers.delete(userId);
      await summarizeUserConversation(userId, snapUsername, snapHistory);
    }, SUMMARIZE_DELAY_MS));
    
    // Always reply in the same channel the user messaged in
    clearInterval(typingInterval);
    const sendReply = async (channel, reply) => {
      // Split into 2000-char chunks if needed (Discord's limit)
      const chunks = [];
      let remaining = reply;
      while (remaining.length > 0) {
        if (remaining.length <= 2000) {
          chunks.push(remaining);
          break;
        }
        let splitAt = remaining.lastIndexOf('\n', 2000);
        if (splitAt < 1000) splitAt = remaining.lastIndexOf(' ', 2000);
        if (splitAt < 1000) splitAt = 2000;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
      }
      
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await userMessage.reply(chunks[i]);
        } else {
          await channel.send(chunks[i]);
        }
      }
    };

    await sendReply(userMessage.channel, finalReply);
  } catch (error) {
    clearInterval(typingInterval);
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
