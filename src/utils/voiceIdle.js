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
      console.log(`[Voice] Auto-leaving ${guildId} after 5 minutes of inactivity`);
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
