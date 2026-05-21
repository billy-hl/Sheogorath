'use strict';
const { getVoiceConnection } = require('@discordjs/voice');

const voiceTimers = new Map();
const VOICE_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Mark voice channel as active (reset idle timer)
 */
function markVoiceActive(guildId) {
  if (voiceTimers.has(guildId)) {
    clearTimeout(voiceTimers.get(guildId));
  }
  
  const timer = setTimeout(() => {
    const connection = getVoiceConnection(guildId);
    if (connection && connection.state.status !== 'destroyed') {
      // Check if there are any users left in the voice channel
      const channel = connection.joinConfig.channelId;
      const guild = connection.joinConfig.guildId;
      
      // Need to get the actual channel object to check members
      const { client } = require('../index');
      if (client && client.guilds) {
        const guildObj = client.guilds.cache.get(guild);
        if (guildObj) {
          const voiceChannel = guildObj.channels.cache.get(channel);
          if (voiceChannel && voiceChannel.members) {
            const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
            if (humanMembers.size > 0) {
              console.log(`[Voice] Not leaving ${guildId} - ${humanMembers.size} user(s) still in channel`);
              // Restart the timer since people are still there
              markVoiceActive(guildId);
              return;
            }
          }
        }
      }
      
      console.log(`[Voice] Auto-leaving ${guildId} after 5 minutes of inactivity (channel empty)`);
      connection.destroy();
    }
    voiceTimers.delete(guildId);
  }, VOICE_IDLE_TIMEOUT);
  
  voiceTimers.set(guildId, timer);
}

/**
 * Cancel voice idle timer (user joined/bot playing)
 */
function cancelVoiceIdle(guildId) {
  if (voiceTimers.has(guildId)) {
    clearTimeout(voiceTimers.get(guildId));
    voiceTimers.delete(guildId);
  }
}

module.exports = { markVoiceActive, cancelVoiceIdle };
