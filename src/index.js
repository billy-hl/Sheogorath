'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');

// Single-instance lock — exit immediately if another process holds the lock
const LOCK_FILE = path.join(__dirname, '..', 'sheogorath.lock');
try {
  const existing = fs.existsSync(LOCK_FILE) && parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  if (existing) {
    try { process.kill(existing, 0); } catch { fs.unlinkSync(LOCK_FILE); /* stale lock */ }
    if (fs.existsSync(LOCK_FILE)) {
      console.error(`[Lock] Another instance is already running (PID ${existing}). Exiting.`);
      process.exit(1);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch (e) {
  console.error('[Lock] Could not acquire lock:', e.message);
  process.exit(1);
}
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const { setUserActivity, getUserActivity, getUserNotes, addUserNote } = require('./storage/state');
const { addMemory } = require('./storage/memory');
const { getAIResponse, getAIResponseWithHistory, extractMemoryFromMessage } = require('./ai/grok');
const { handleInstagramLinks } = require('./services/instagram');
const { stopPlaying } = require('./music/player');
const { parseActions, executeActions } = require('./ai/actions');
const { checkCooldown, setCooldown } = require('./utils/cooldowns');
const { setClient, notifyError } = require('./utils/errorNotify');
const { isSexualizedTextImage } = require('./services/textImageMod');
const { trackCommand } = require('./commands/stats');
const { startControlApi } = require('./api/server');
const { getGuildConfig, guildIds, hasFeature } = require('./config/guilds');
const {
  musicDenialReason,
  commandDenialReason,
  commandsForGuild,
  isAdmin,
  STAFF_COMMANDS,
} = require('./utils/permissions');
const { logCommand, setClient: setAuditClient } = require('./utils/auditLog');
const { scheduleRaidWatch } = require('./services/zomboid/raidWatch');
const { scheduleModUpdates } = require('./services/zomboid/modUpdates');
const { scheduleEulogies } = require('./services/zomboid/eulogy');
const { handleThreadCreate } = require('./services/forums/handler');
const { scheduleTradeSweep } = require('./services/forums/tradeSweep');

let lastInteractionTime = Date.now();
const conversationHistory = new Map();
// Per-user timers that fire a note-summarization pass 5 min after last exchange
const summarizeTimers = new Map();

const SUMMARIZE_DELAY_MS = 5 * 60 * 1000; // 5 minutes idle before summarizing
const SUMMARIZE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // once per 24 hours per user
const SUMMARIZE_MIN_MESSAGES = 6; // minimum messages before bothering

async function summarizeUserConversation(guildId, userId, username, history) {
  // Require a meaningful conversation
  if (!history || history.length < SUMMARIZE_MIN_MESSAGES) return;

  // 24-hour cooldown per user
  const activity = getUserActivity(guildId, userId);
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
        addUserNote(guildId, userId, note.trim());
        addMemory(guildId, userId, note.trim(), 'auto-summary');
      }
    }

    // Record the time so we don't run again for 24h
    setUserActivity(guildId, userId, { lastNoteSummary: new Date().toISOString() });
    console.log(`[AutoNote] Saved ${notes.length} note(s) and memories for ${username}`);
  } catch (e) {
    console.warn('[AutoNote] Summarization failed:', e?.message || e);
  }
}

const requiredEnv = [
  'GROK_API_KEY',
  'CLIENT_NAME',
  'CLIENT_INSTRUCTIONS',
  'CLIENT_MODEL',
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
  ],
});

client.commands = new Map();

// Export client for other modules
module.exports = { client };


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


client.once(Events.ClientReady, async () => {
  setClient(client); // Enable error notifications
  setAuditClient(client); // Enable the command-log channel mirror

  // Control API for the companion app. Started after ready so it never reports
  // healthy before the client can actually act on a request. Failure here must
  // not take the bot down, so it's isolated.
  try {
    startControlApi(client);
  } catch (err) {
    console.error('[API] Failed to start control API:', err?.message || err);
  }

  // Register per-guild rather than globally: propagation is instant, and the
  // commands stay out of any guild the bot happens to be in but isn't
  // configured for. One guild failing must not stop the others registering.
  for (const guildId of guildIds()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.error(`[Commands] Configured guild ${guildId} not found — is the bot a member?`);
      continue;
    }
    try {
      const commands = commandsForGuild(commandDataArray, guildId);
      await guild.commands.set(commands);
      console.log(`[Commands] Registered ${commands.length} command(s) in ${guild.name}.`);
    } catch (error) {
      console.error(`[Commands] Error registering in ${guild.name}:`, error);
    }
  }

  // The daily Project Zomboid chronicle is no longer scheduled here. It runs as
  // a Claude Code scheduled task instead, which reads the same logs over SSH and
  // posts to the same channel. `services/zomboid/storyTime.js` is kept because
  // that task reuses its log collection and Discord splitting.

  // Watch for players quitting mid-fight to seal their safehouse. Isolated for
  // the same reason as above.
  try {
    scheduleRaidWatch(client);
  } catch (err) {
    console.error('[Zomboid] Failed to schedule raid watch:', err?.message || err);
  }

  // Watch the Workshop for updates to the mods the server runs. Isolated too —
  // this one can trigger a server restart, so a fault in it must not cascade.
  try {
    scheduleModUpdates(client);
  } catch (err) {
    console.error('[Zomboid] Failed to schedule mod update watch:', err?.message || err);
  }

  // Say goodbye to characters who die. Isolated like the rest — this one calls
  // out to the model, so a provider outage must not take the bot down.
  try {
    scheduleEulogies(client);
  } catch (err) {
    console.error('[Zomboid] Failed to schedule eulogies:', err?.message || err);
  }

  // Sweep stale offers off the trading board.
  try {
    scheduleTradeSweep(client);
  } catch (err) {
    console.error('[Trading] Failed to schedule stale sweep:', err?.message || err);
  }

  // Clean up old temp files on startup (older than 1 hour)
  try {
    const tempDir = path.join(__dirname, '..', 'temp');
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      let cleaned = 0;
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < oneHourAgo) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      }
      if (cleaned > 0) console.log(`[Cleanup] Removed ${cleaned} old temp file(s)`);
    }
  } catch (err) {
    console.error('[Cleanup] Failed to clean temp directory:', err.message);
  }

  // Memory monitoring - log every 30 minutes, clear old history if high
  setInterval(() => {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    console.log(`[Memory] ${heapUsedMB}MB / ${heapTotalMB}MB`);
    
    // If using >400MB, aggressively clear old conversation history
    if (heapUsedMB > 400) {
      let cleared = 0;
      for (const [key, history] of conversationHistory.entries()) {
        if (history.length > 10) {
          conversationHistory.set(key, history.slice(-10));
          cleared++;
        }
      }
      if (cleared > 0) {
        console.log(`[Memory] High usage detected, cleared history for ${cleared} users`);
      }
    }
  }, 30 * 60 * 1000); // 30 minutes

});


client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  lastInteractionTime = Date.now();

  // Everything below is guild-scoped. DMs and guilds absent from
  // config/guilds.json are ignored outright rather than half-handled.
  const guildId = message.guildId;
  const config = getGuildConfig(guildId);
  if (!config) return;

  // --- Text-image moderation (ASCII/Unicode sexualized art) ---
  if (hasFeature(guildId, 'textImageMod') && await isSexualizedTextImage(message.content)) {
    console.log(`[TextImageMod] Flagged message from ${message.author.username}: ${message.content.slice(0, 80)}`);
    try {
      await message.delete();
      const warn = await message.channel.send(
        `🔞 <@${message.author.id}> — text-based explicit images aren't allowed here. ` +
        `The Mad King sees all, mortal. Consider this a warning.`
      );
      // Auto-delete the warning after 10 seconds
      setTimeout(() => warn.delete().catch(() => {}), 10_000);
    } catch (err) {
      console.error('[TextImageMod] Failed to delete or warn:', err.message);
    }
    return;
  }

  // Track last chat time for this user
  setUserActivity(guildId, message.author.id, { lastChat: new Date().toISOString() });

  // Instagram video downloader
  if (hasFeature(guildId, 'instagram')) {
    await handleInstagramLinks(message);
  }

  // Mod requests used to be vetted here, on every message in the text channel.
  // They now arrive as forum posts and are handled by the threadCreate
  // listener below, which fires once per request rather than once per link.

  if (!hasFeature(guildId, 'ai')) return;

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

  // Conversational triggers - any channel, whole-word matches only.
  // Skip if the message already contains a direct bot mention (handled above)
  const isMention = message.content.includes(`<@!${client.user.id}>`) ||
                    message.content.includes(`<@${client.user.id}>`);
  if (!isMention) {
    const content = message.content.toLowerCase();
    const triggerPattern = /\b(sheogorath|mad king)\b/i;
    
    if (triggerPattern.test(content)) {
      askChatGPT(message);
    }
  }
});

/**
 * New forum post in #suggestions or #mod-requests.
 *
 * `newlyCreated` separates a genuine new post from the thread objects the
 * gateway replays when the bot gains access to an existing one — without it,
 * a reconnect would re-vet and re-tag the whole forum.
 */
client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
  if (!newlyCreated) return;
  lastInteractionTime = Date.now();

  await handleThreadCreate(thread).catch(err =>
    console.error('[Forums] Thread handling failed:', err?.message || err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  lastInteractionTime = Date.now();

  try {
    // Handle button interactions for music controls
    if (interaction.isButton()) {
      const { pausePlayer, resumePlayer, skipSong, stopPlayer } = require('./music/player');
      const { removeTrackFromRadio } = require('./commands/radio');
      const guildId = interaction.guild.id;

      // The now-playing card is visible to everyone, so its buttons need the
      // same gate as the commands rather than trusting who can see them.
      const denied = musicDenialReason(guildId, interaction.member);
      if (denied) {
        await interaction.reply({ content: denied, ephemeral: true });
        return;
      }

      switch (interaction.customId) {
        case 'music_pause':
          const player = require('./music/player').players.get(guildId);
          if (player) {
            if (player.state.status === 'playing') {
              pausePlayer(guildId);
              await interaction.reply({ content: '⏸️ Paused', ephemeral: true });
            } else {
              resumePlayer(guildId);
              await interaction.reply({ content: '▶️ Resumed', ephemeral: true });
            }
          } else {
            await interaction.reply({ content: '❌ No music playing', ephemeral: true });
          }
          break;

        case 'music_skip':
          await skipSong(guildId);
          await interaction.reply({ content: '⏭️ Skipped', ephemeral: true });
          break;

        case 'music_stop':
          stopPlayer(guildId);
          await interaction.reply({ content: '⏹️ Stopped', ephemeral: true });
          break;

        case 'music_remove':
          // Extract song title from embed
          const embed = interaction.message.embeds[0];
          if (embed && embed.description) {
            const trackTitle = embed.description.split('\n')[0].replace(/\*\*/g, '');
            const removed = removeTrackFromRadio(trackTitle);
            if (removed) {
              await skipSong(guildId);
              await interaction.reply({ content: `🗑️ Removed **${trackTitle}** from radio playlist and skipped`, ephemeral: true });
            } else {
              await interaction.reply({ content: `❌ Could not find **${trackTitle}** in radio playlist`, ephemeral: true });
            }
          } else {
            await interaction.reply({ content: '❌ Could not identify track', ephemeral: true });
          }
          break;
      }
      return;
    }

    // Autocomplete arrives as its own interaction type and must be answered
    // within 3s with respond() — it has no reply()/deferReply(), so it is routed
    // before the chat-command path and skips the denial, cooldown and audit
    // steps below, none of which can express themselves in a picker.
    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        try {
          await command.autocomplete(interaction);
        } catch (error) {
          console.error(`Autocomplete for /${interaction.commandName} failed:`, error);
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    // Privileged commands are mirrored to the guild's log channel; everything
    // is written to logs/commands.jsonl either way.
    const privileged = STAFF_COMMANDS.has(interaction.commandName) || isAdmin(interaction.member);

    const denied = commandDenialReason(interaction.commandName, interaction.guildId, interaction.member);
    if (denied) {
      // Refused attempts are the ones most worth having a record of.
      logCommand(interaction, { status: 'denied', detail: denied, privileged });
      return interaction.reply({ content: denied, flags: 64 });
    }

    // Check cooldown
    const cooldown = checkCooldown(interaction.user.id, interaction.commandName);
    if (cooldown) {
      return interaction.reply({
        content: `⏳ Please wait ${cooldown}s before using \`/${interaction.commandName}\` again.`,
        flags: 64
      });
    }

    // Set cooldown
    setCooldown(interaction.user.id, interaction.commandName);

    // Track command usage
    trackCommand(interaction.commandName);

    try {
      await command.execute(interaction);
      logCommand(interaction, { privileged });
    } catch (error) {
      // Logged here, where the arguments are still to hand, then rethrown so
      // the outer handler still owns telling the user.
      logCommand(interaction, {
        status: 'error',
        detail: error?.message || String(error),
        privileged,
      });
      throw error;
    }

  } catch (error) {
    console.error('Interaction error:', error);
    notifyError(`Command /${interaction.commandName} failed for ${interaction.user.username}`, error);
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

// Idle check - stop music after 1 hour of inactivity
setInterval(async () => {
  const currentTime = Date.now();
  const oneHour = 60 * 60 * 1000;

  if (currentTime - lastInteractionTime > oneHour) {
    // Active playback counts as activity — people listening to the radio
    // without chatting shouldn't have it killed under them
    const { players } = require('./music/player');
    const anyPlaying = [...players.values()].some(p => p.state.status === 'playing');
    if (anyPlaying) {
      lastInteractionTime = currentTime;
      return;
    }
    // Nothing is playing — nothing to stop, just reset the timer quietly
    const anyPlayers = players.size > 0;
    lastInteractionTime = currentTime;
    if (!anyPlayers) return;

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
    setUserActivity(newState.guild.id, newState.member.id, { lastVoiceJoin: new Date().toISOString() });
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

// Entrance announcements disabled.

// Music reaction controls
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (err) {
      console.error('Error fetching reaction:', err);
      return;
    }
  }

  const message = reaction.message;
  if (message.author.id !== client.user.id) return;
  // Check if message has embeds with "Now Playing" title
  const isNowPlaying = message.embeds.length > 0 && 
    (message.embeds[0].title === '🎵 Now Playing' || 
     message.content.startsWith('🎵 Now playing:') || 
     message.content.startsWith('📻 Radio started:'));
  if (!isNowPlaying) return;

  const { pausePlayer, resumePlayer, skipSong } = require('./music/player');
  const { removeTrackFromRadio } = require('./commands/radio');
  const guildId = message.guild.id;

  // Same gate as the buttons — anyone can add a reaction to a visible message.
  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (musicDenialReason(guildId, member)) {
    await reaction.users.remove(user.id).catch(() => {});
    return;
  }

  try {
    switch (reaction.emoji.name) {
      case '⏯️':
        const player = require('./music/player').players.get(guildId);
        if (player) {
          if (player.state.status === 'playing') {
            pausePlayer(guildId);
            await message.channel.send('⏸️ Paused').then(m => setTimeout(() => m.delete().catch(() => {}), 3000));
          } else {
            resumePlayer(guildId);
            await message.channel.send('▶️ Resumed').then(m => setTimeout(() => m.delete().catch(() => {}), 3000));
          }
        }
        break;

      case '⏭️':
        await skipSong(guildId);
        await message.channel.send('⏭️ Skipped').then(m => setTimeout(() => m.delete().catch(() => {}), 3000));
        break;

      case '⏹️':
        const { stopPlayer } = require('./music/player');
        stopPlayer(guildId);
        await message.channel.send('⏹️ Stopped').then(m => setTimeout(() => m.delete().catch(() => {}), 3000));
        break;

      case '🗑️':
        // Extract song title from message (either content or embed description)
        let trackTitle = null;
        const contentMatch = message.content.match(/\*\*(.+?)\*\*/);
        if (contentMatch) {
          trackTitle = contentMatch[1];
        } else if (message.embeds.length > 0) {
          const description = message.embeds[0].description;
          if (description) {
            // Extract first line (title) from embed description
            trackTitle = description.split('\n')[0].replace(/\*\*/g, '');
          }
        }
        
        if (trackTitle) {
          const removed = removeTrackFromRadio(trackTitle);
          if (removed) {
            await message.channel.send(`🗑️ Removed **${trackTitle}** from radio playlist, skipping...`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
            // Skip the current song
            await skipSong(guildId);
          } else {
            await message.channel.send(`❌ Could not find **${trackTitle}** in radio playlist`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
          }
        }
        break;
    }
  } catch (err) {
    console.error('Error handling music reaction:', err);
  }

  // Remove the user's reaction
  try {
    await reaction.users.remove(user.id);
  } catch (err) {
    console.error('Error removing reaction:', err);
  }
});

async function askChatGPT(userMessage) {
  // Keep the "is typing" indicator alive every 8s until we're done
  userMessage.channel.sendTyping();
  const typingInterval = setInterval(() => {
    userMessage.channel.sendTyping().catch(() => {});
  }, 8000);
  
  const userId = userMessage.author.id;
  const guildId = userMessage.guildId;
  // Keyed per guild so the same person talking in two servers gets two
  // separate conversations rather than one bleeding into the other.
  const historyKey = `${guildId}:${userId}`;
  const history = conversationHistory.get(historyKey) || [];

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
    const userNotes = getUserNotes(guildId, userId);
    const notesContext = userNotes.length > 0
      ? `[Notes about this user (${userMessage.author.username})]:\n` +
        userNotes.map((n, i) => `${i + 1}. ${n.text} (recorded ${n.addedAt})`).join('\n') + '\n'
      : '';

    // Add long-term memories
    const { formatMemoriesForContext } = require('./storage/memory');
    const memoriesContext = formatMemoriesForContext(guildId, userId);

    const messages = [
      ...history.slice(-5),
      { role: 'user', content: notesContext + memoriesContext + (notesContext || memoriesContext ? '\n' : '') + cleanedContent }
    ];
    
    const assistantReply = await getAIResponseWithHistory(messages);
    const raw = assistantReply && assistantReply.trim()
      ? assistantReply
      : "The Mad King contemplates your words... but finds them unworthy of a proper response. Try again, mortal!";

    console.log('[AI Response]', raw.substring(0, 200)); // Log first 200 chars to see if actions are present

    // Parse and execute any AI-initiated actions
    const { cleanResponse, actions } = parseActions(raw);
    if (actions.length > 0) {
      console.log(`[Actions] Detected ${actions.length} action(s):`, actions.map(a => `${a.type} for ${a.userId || 'N/A'}`));
      await executeActions(actions, { guild: userMessage.guild, message: userMessage, guildId });
    }

    // Final scrub — strip any remaining action tags regardless of parse result,
    // and handle edge case where cleanResponse is empty string (falls back to raw)
    const scrub = (text) => text
      .replace(/\[ACTION:[^\]]*\]/gs, '')   // complete tags (s flag = dotall, matches newlines)
      .replace(/\[ACTION:[^\]]*$/gm, '')    // truncated tags at end of line
      .replace(/\[ACTION:.*/gs, '')         // any leftover prefix
      .trim();

    const finalReply = scrub(cleanResponse) || scrub(raw);
    
    // Store conversation (keep last 15 exchanges)
    history.push(
      { role: 'user', content: cleanedContent },
      { role: 'assistant', content: finalReply }
    );
    if (history.length > 30) history.splice(0, history.length - 30);
    conversationHistory.set(historyKey, history);

    // Background memory extraction — fire-and-forget, no blocking
    extractMemoryFromMessage(userMessage.author.username, cleanedContent).then(fact => {
      if (fact) {
        addMemory(guildId, userId, fact);
        console.log(`[Memory] Auto-extracted for ${userMessage.author.username}: ${fact}`);
      }
    }).catch(() => {});

    // Schedule a post-conversation note summarization (resets on each message)
    if (summarizeTimers.has(historyKey)) clearTimeout(summarizeTimers.get(historyKey));
    const snapHistory = [...history];
    const snapUsername = userMessage.author.username;
    summarizeTimers.set(historyKey, setTimeout(async () => {
      summarizeTimers.delete(historyKey);
      await summarizeUserConversation(guildId, userId, snapUsername, snapHistory);
    }, SUMMARIZE_DELAY_MS));
    
    clearInterval(typingInterval);

    await sendReply(userMessage.channel, finalReply);
  } catch (error) {
    clearInterval(typingInterval);
    console.error('Error in askChatGPT:', error.message);
    notifyError(`askChatGPT failed for ${userMessage.author.username}`, error);
    await userMessage.reply('❌ An error occurred while trying to fetch the AI response. The Mad King is... temporarily indisposed.');
  }

  async function sendReply(channel, reply) {
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
  }
}

// Clean shutdown handler
process.on('SIGINT', () => {
  console.log('Bot is shutting down...');
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
