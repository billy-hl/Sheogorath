'use strict';
const {
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
} = require('discord.js');
const { getGuildState, setGuildState } = require('../storage/state');
const { getGuildConfig } = require('../config/guilds');

// Discord's limits on a Keyword rule's filter list.
const MAX_KEYWORDS = 1000;
const MAX_KEYWORD_LENGTH = 60;

/**
 * Turn an admin-supplied comma-separated string into a keyword filter list.
 * Returns the accepted terms alongside anything dropped, so the caller can
 * tell the admin exactly what did and did not make it into the rule.
 * @param {string} input
 * @returns {{ accepted: string[], rejected: string[] }}
 */
function parseWordList(input) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();

  for (const raw of String(input || '').split(',')) {
    const word = raw.trim();
    if (!word) continue;

    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (word.length > MAX_KEYWORD_LENGTH || accepted.length >= MAX_KEYWORDS) {
      rejected.push(word);
    } else {
      accepted.push(word);
    }
  }

  return { accepted, rejected };
}

/**
 * Set up or update Discord native AutoMod rules for a guild.
 * @param {import('discord.js').Guild} guild
 * @param {Object} options
 * @param {boolean} [options.blockWords] - Enable keyword filter
 * @param {boolean} [options.antiSpam] - Enable mention spam filter
 * @param {string[]} [options.customWords] - Replaces the guild's stored word list;
 *   omit to re-use whatever was configured last
 */
async function setupAutoMod(guild, options = {}) {
  const automodState = getGuildState(guild.id).automod || {};

  try {
    // Fetch existing rules to avoid duplicates
    const existingRules = await guild.autoModerationRules.fetch();

    // --- Keyword Filter Rule ---
    if (options.blockWords !== undefined) {
      const existingKeywordRule = existingRules.find(r => r.name === 'Sheogorath-BlockedWords');

      if (options.blockWords) {
        // An explicit list replaces the stored one; omitting it re-uses what the
        // guild configured last, so `off` then `on` doesn't lose the list. The
        // live rule is the last resort, for when state.json has been lost.
        const stored = automodState.blockedWords || [];
        const live = existingKeywordRule?.triggerMetadata?.keywordFilter || [];
        const words = options.customWords ? [...options.customWords]
          : stored.length ? [...stored]
            : [...live];

        if (words.length === 0) {
          // Nothing to filter on. Leave the rule untouched and record that the
          // filter is off, so callers never report a filter the guild lacks.
          console.log('No blocked words configured, skipping keyword filter.');
          automodState.blockWords = false;
          automodState.blockedWords = [];
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

        if (words.length > 0) {
          automodState.blockWords = true;
          automodState.blockedWords = words;
        }
      } else {
        if (existingKeywordRule) {
          await existingKeywordRule.edit({ enabled: false });
        }
        // A list supplied alongside `off` is still worth keeping for next time.
        if (options.customWords) automodState.blockedWords = [...options.customWords];
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

    setGuildState(guild.id, { automod: automodState });
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
      blockedWords: keywordRule?.triggerMetadata?.keywordFilter || [],
      antiSpam: spamRule?.enabled || false,
    };
  } catch (error) {
    console.error('Failed to fetch AutoMod status:', error.message);
    return { blockWords: false, blockedWords: [], antiSpam: false };
  }
}

// --- Mod action helpers (for AI actions layer) ---

/**
 * Timeout a guild member.
 *
 * The ceiling is a parameter rather than a constant because two callers want
 * different ones: an unprompted AI timeout is capped at ten minutes by
 * ai/capabilities.js before it ever reaches here, while a longer one a Sheriff
 * has clicked Approve on should be allowed to be as long as it says. The
 * ten-minute default keeps any caller that doesn't think about it on the
 * cautious side.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @param {number} durationMinutes
 * @param {string} reason
 * @param {object} [opts]
 * @param {number} [opts.maxMinutes=10] hard ceiling applied to durationMinutes
 */
async function timeoutUser(guild, userId, durationMinutes, reason, { maxMinutes = 10 } = {}) {
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

/**
 * The rules a guild gets from `/automod baseline`.
 *
 * Discord's own filters, not a word list of ours. A hand-maintained list of
 * slurs is a losing game — it is always a transliteration behind — while the
 * preset is maintained by people whose job that is, in every language at once.
 *
 * Profanity is deliberately NOT among the presets. #rules says swearing is
 * fine, and an AutoMod rule that contradicts the posted rules teaches people
 * that the posted rules are decorative.
 *
 * Discord allows one MentionSpam, one Spam and one KeywordPreset rule per
 * guild, so these are singletons by name and editing them in place is the only
 * way to apply them twice.
 */
const BASELINE = [
  {
    name: 'Sheogorath-Presets',
    triggerType: AutoModerationRuleTriggerType.KeywordPreset,
    triggerMetadata: {
      presets: [
        AutoModerationRuleKeywordPresetType.Slurs,
        AutoModerationRuleKeywordPresetType.SexualContent,
      ],
      allowList: [],
    },
    // Blocked and reported. A preset false-positive is invisible to staff
    // otherwise, and the alert is how anyone finds out the filter is wrong.
    actions: ({ alertChannel }) => [
      { type: AutoModerationActionType.BlockMessage,
        metadata: { customMessage: 'Not in this hall.' } },
      ...(alertChannel ? [{ type: AutoModerationActionType.SendAlertMessage,
        metadata: { channel: alertChannel } }] : []),
    ],
  },
  {
    // Same name the older /automod antispam toggle uses, so the baseline adopts
    // that rule where it already exists rather than colliding with Discord's
    // one-MentionSpam-per-guild limit.
    name: 'Sheogorath-AntiSpam',
    triggerType: AutoModerationRuleTriggerType.MentionSpam,
    triggerMetadata: { mentionTotalLimit: 5 },
    actions: ({ alertChannel }) => [
      { type: AutoModerationActionType.BlockMessage,
        metadata: { customMessage: 'Too many mentions at once.' } },
      { type: AutoModerationActionType.Timeout, metadata: { durationSeconds: 300 } },
      ...(alertChannel ? [{ type: AutoModerationActionType.SendAlertMessage,
        metadata: { channel: alertChannel } }] : []),
    ],
  },
  {
    name: 'Sheogorath-Spam',
    triggerType: AutoModerationRuleTriggerType.Spam,
    triggerMetadata: {},
    actions: () => [
      { type: AutoModerationActionType.BlockMessage,
        metadata: { customMessage: 'That read as spam. If it was not, a Warden can let it through.' } },
    ],
  },
  {
    name: 'Sheogorath-InviteAlert',
    triggerType: AutoModerationRuleTriggerType.Keyword,
    // Rust-flavoured regex, evaluated by Discord rather than by us.
    triggerMetadata: { regexPatterns: ['discord\\.(gg|com/invite)/[A-Za-z0-9-]+'], keywordFilter: [] },
    // Alert only, no block. #rules permits a regular sharing a server they
    // like and forbids only drive-by invites from strangers — a distinction
    // AutoMod cannot draw, so it tells a Warden instead of guessing.
    actions: ({ alertChannel }) => (alertChannel
      ? [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: alertChannel } }]
      : []),
  },
];

/**
 * Create or update the baseline rules for a guild.
 *
 * Idempotent by rule name, like the rest of the setup tooling: a second run
 * edits what is there rather than colliding with Discord's per-type limits.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] describe the work without doing it
 */
async function applyBaseline(guild, { dryRun = false } = {}) {
  const config = getGuildConfig(guild.id);
  // Staff are exempt: a Warden quoting a slur to ask what to do about it must
  // not be swallowed by the filter that is there to help them.
  const exemptRoles = [config?.roles?.staff, config?.roles?.admin].filter(Boolean);
  const alertChannel = config?.channels?.modApprovals || config?.channels?.commandLog || null;

  const existing = await guild.autoModerationRules.fetch();
  const results = [];

  for (const spec of BASELINE) {
    const actions = spec.actions({ alertChannel });
    if (!actions.length) {
      results.push({ name: spec.name, action: 'skipped', detail: 'no alert channel configured, and this rule only alerts' });
      continue;
    }
    const found = existing.find((r) => r.name === spec.name);
    const payload = {
      enabled: true,
      actions,
      exemptRoles,
      triggerMetadata: spec.triggerMetadata,
    };

    if (dryRun) {
      results.push({ name: spec.name, action: found ? 'edit' : 'create',
        detail: `${actions.length} action(s), ${exemptRoles.length} exempt role(s)` });
      continue;
    }
    try {
      if (found) await found.edit(payload);
      else await guild.autoModerationRules.create({
        ...payload,
        name: spec.name,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: spec.triggerType,
      });
      results.push({ name: spec.name, action: found ? 'edited' : 'created',
        detail: `${actions.length} action(s), ${exemptRoles.length} exempt role(s)` });
    } catch (err) {
      results.push({ name: spec.name, action: 'FAILED', detail: err?.message || String(err) });
    }
  }
  return { results, alertChannel, exemptRoles };
}

module.exports = {
  setupAutoMod,
  applyBaseline,
  BASELINE,
  getAutoModStatus,
  parseWordList,
  timeoutUser,
  warnUser,
  deleteMessage,
};
