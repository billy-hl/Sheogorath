'use strict';
const { AutoModerationRuleTriggerType, AutoModerationActionType, AutoModerationRuleEventType } = require('discord.js');
const { getState, setState } = require('../storage/state');

// Default blocked words list
const DEFAULT_BLOCKED_WORDS = [
  // Add slurs and offensive terms here as needed
];

/**
 * Set up or update Discord native AutoMod rules for a guild.
 * @param {import('discord.js').Guild} guild
 * @param {Object} options
 * @param {boolean} [options.blockWords] - Enable keyword filter
 * @param {boolean} [options.antiSpam] - Enable mention spam filter
 * @param {string[]} [options.customWords] - Additional words to block
 */
async function setupAutoMod(guild, options = {}) {
  const state = getState();
  const automodState = state.automod || {};

  try {
    // Fetch existing rules to avoid duplicates
    const existingRules = await guild.autoModerationRules.fetch();

    // --- Keyword Filter Rule ---
    if (options.blockWords !== undefined) {
      const existingKeywordRule = existingRules.find(r => r.name === 'Sheogorath-BlockedWords');

      if (options.blockWords) {
        const words = [...DEFAULT_BLOCKED_WORDS, ...(options.customWords || [])];
        if (words.length === 0) {
          console.log('No blocked words configured, skipping keyword filter.');
        } else if (existingKeywordRule) {
          await existingKeywordRule.edit({
            enabled: true,
            triggerMetadata: { keywordFilter: words },
          });
        } else {
          await guild.autoModerationRules.create({
            name: 'Sheogorath-BlockedWords',
            eventType: AutoModerationRuleEventType.MessageSend,
            triggerType: AutoModerationRuleTriggerType.Keyword,
            triggerMetadata: { keywordFilter: words },
            actions: [
              {
                type: AutoModerationActionType.BlockMessage,
                metadata: { customMessage: 'The Mad King does not permit such language.' },
              },
            ],
            enabled: true,
          });
        }
        automodState.blockWords = true;
      } else {
        if (existingKeywordRule) {
          await existingKeywordRule.edit({ enabled: false });
        }
        automodState.blockWords = false;
      }
    }

    // --- Mention Spam Rule ---
    if (options.antiSpam !== undefined) {
      const existingSpamRule = existingRules.find(r => r.name === 'Sheogorath-AntiSpam');

      if (options.antiSpam) {
        if (existingSpamRule) {
          await existingSpamRule.edit({ enabled: true });
        } else {
          await guild.autoModerationRules.create({
            name: 'Sheogorath-AntiSpam',
            eventType: AutoModerationRuleEventType.MessageSend,
            triggerType: AutoModerationRuleTriggerType.MentionSpam,
            triggerMetadata: { mentionTotalLimit: 5 },
            actions: [
              {
                type: AutoModerationActionType.BlockMessage,
                metadata: { customMessage: 'Too many mentions. The Mad King demands order in chaos.' },
              },
              {
                type: AutoModerationActionType.Timeout,
                metadata: { durationSeconds: 300 }, // 5 minute timeout
              },
            ],
            enabled: true,
          });
        }
        automodState.antiSpam = true;
      } else {
        if (existingSpamRule) {
          await existingSpamRule.edit({ enabled: false });
        }
        automodState.antiSpam = false;
      }
    }

    setState({ automod: automodState });
    return automodState;
  } catch (error) {
    console.error('AutoMod setup error:', error.message);
    throw error;
  }
}

/**
 * Get current AutoMod status for a guild.
 */
async function getAutoModStatus(guild) {
  try {
    const existingRules = await guild.autoModerationRules.fetch();
    const keywordRule = existingRules.find(r => r.name === 'Sheogorath-BlockedWords');
    const spamRule = existingRules.find(r => r.name === 'Sheogorath-AntiSpam');

    return {
      blockWords: keywordRule?.enabled || false,
      antiSpam: spamRule?.enabled || false,
    };
  } catch (error) {
    console.error('Failed to fetch AutoMod status:', error.message);
    return { blockWords: false, antiSpam: false };
  }
}

// --- Mod action helpers (for AI actions layer) ---

/**
 * Timeout a guild member.
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @param {number} durationMinutes - Max 10 minutes for AI-initiated
 * @param {string} reason
 */
async function timeoutUser(guild, userId, durationMinutes, reason) {
  const maxMinutes = 10;
  const duration = Math.min(durationMinutes, maxMinutes);
  const member = await guild.members.fetch(userId);

  if (member.permissions.has('Administrator')) {
    throw new Error('Cannot timeout an administrator.');
  }
  if (member.user.bot) {
    throw new Error('Cannot timeout a bot.');
  }

  await member.timeout(duration * 60 * 1000, `[AI] ${reason}`);
  return { userId, duration, reason };
}

/**
 * Warn a user via DM.
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @param {string} reason
 */
async function warnUser(guild, userId, reason) {
  const member = await guild.members.fetch(userId);

  if (member.user.bot) return;

  try {
    await member.send(`⚠️ **Warning from ${guild.name}:** ${reason}`);
  } catch {
    // DMs might be closed
  }
  return { userId, reason };
}

/**
 * Delete a message.
 * @param {import('discord.js').Message} message
 * @param {string} reason
 */
async function deleteMessage(message, reason) {
  await message.delete();
  return { messageId: message.id, reason };
}

module.exports = {
  setupAutoMod,
  getAutoModStatus,
  timeoutUser,
  warnUser,
  deleteMessage,
};
