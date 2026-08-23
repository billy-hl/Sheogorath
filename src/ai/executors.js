'use strict';
/**
 * The actual doing. One function per capability, no policy of any kind.
 *
 * Split out from actions.js so that both paths into an action — Sheogorath
 * acting within his own authority, and a Sheriff clicking Approve on a card —
 * end up in the same code, and so that neither module has to require the other.
 * Nothing here checks permissions: by the time a call lands, capabilities.js has
 * either allowed it or a human has clicked the button.
 */
const { timeoutUser, warnUser, deleteMessage } = require('../services/automod');
const { addUserNote, clearUserNotes } = require('../storage/state');
const { addMemory } = require('../storage/memory');
const { CAPABILITIES } = require('./capabilities');

/**
 * Perform one action.
 *
 * @param {object} action  `{ type, userId?, duration?, reason?, ... }`
 * @param {object} ctx     `{ guild, guildId, message? }`
 * @returns {Promise<string>} a short past-tense description, for the audit line
 */
async function runAction(action, ctx) {
  const { guild, message } = ctx;
  const guildId = ctx.guildId || guild?.id;

  /**
   * Post something that belongs *after* Sheogorath's own reply.
   *
   * Actions are performed before the reply is sent — the reply's footer depends
   * on how they were ruled on — so an executor that sent prose directly would
   * have it land above the line introducing it. Anything pushed here is sent by
   * the caller once the reply is out. Approved-from-a-card actions have no
   * reply coming, so those fall back to sending immediately.
   */
  const follow = async (parts) => {
    if (Array.isArray(ctx.followUps)) ctx.followUps.push(...parts);
    else for (const part of parts) await message.channel.send(part);
  };

  switch (action.type) {
    case 'timeout': {
      await timeoutUser(guild, action.userId, action.duration, action.reason, {
        maxMinutes: CAPABILITIES.timeout.hardMaxMinutes,
      });
      return `timed out <@${action.userId}> for ${action.duration}m`;
    }

    case 'warn':
      await warnUser(guild, action.userId, action.reason);
      return `warned <@${action.userId}>`;

    case 'kick': {
      const member = await guild.members.fetch(action.userId);
      await member.kick(`[Sheogorath] ${action.reason}`);
      return `kicked <@${action.userId}>`;
    }

    case 'ban': {
      await guild.bans.create(action.userId, {
        reason: `[Sheogorath] ${action.reason}`,
        deleteMessageSeconds: (action.deleteDays || 0) * 24 * 60 * 60,
      });
      return `banned <@${action.userId}>`;
    }

    case 'delete': {
      // The message is only to hand on the path that started from it. An
      // approved card arriving minutes later has no message to delete, and
      // saying so is better than silently succeeding.
      if (!message) throw new Error('the message this referred to is no longer to hand');
      await deleteMessage(message, action.reason);
      return 'deleted the message';
    }

    case 'flag':
      // Nothing is done to anyone. The whole effect is the audit record, which
      // mirrors to the staff channel with the reason and a link to the message —
      // so this executor's only job is to say what happened.
      return `flagged a manipulation attempt by <@${action.userId}> — ${action.reason}`;

    case 'note':
      addUserNote(guildId, action.userId, action.note);
      return `noted against <@${action.userId}>`;

    case 'clearnotes':
      clearUserNotes(guildId, action.userId);
      return `cleared notes for <@${action.userId}>`;

    case 'memory':
      addMemory(guildId, action.userId, action.memory);
      return `remembered something about <@${action.userId}>`;

    case 'storytime': {
      // Posts the piece itself rather than handing it back, because it is prose
      // for the channel, not a line for the audit log. Sheogorath's own reply
      // still goes out alongside it — he introduces it, the chronicler writes it.
      const { generateInterlude, storyConfig, splitForDiscord } = require('../services/zomboid/storyTime');
      const cfg = storyConfig(guildId);
      if (!cfg) throw new Error('story time is not configured for this server');
      if (!message?.channel) throw new Error('there is no channel to tell it in');

      // The client comes off the message rather than from requiring index.js,
      // which would be a circular require for something already to hand.
      const text = await generateInterlude(cfg, message.client);
      if (!text) {
        await follow(['-# The chronicler turns a page and finds it blank — nothing has happened today worth the ink.']);
        return 'told an early tale, but the day was empty';
      }

      const hour = cfg.hour;
      const footer = `\n\n-# The full chronicle comes at ${String(hour).padStart(2, '0')}:00, as it always does.`;
      await follow(splitForDiscord(text + footer));
      return `told an early tale (${text.length} chars)`;
    }

    case 'pzrestart': {
      // The same path `/pz restart` uses, so players get the in-game warnings
      // and the scheduled-restart guards apply — including the refusal when one
      // is already running, which surfaces as a normal failure.
      const { startRestart } = require('../services/zomboid/restart');
      const reason = action.reason || 'asked for in chat';
      await startRestart(guildId, action.minutes, reason);
      return action.minutes > 0
        ? `scheduled a server restart in ${action.minutes} minute(s) — ${reason}`
        : `started a server restart now — ${reason}`;
    }

    case 'pzcommand': {
      // Required lazily: the Zomboid stack pulls in the whole RCON toolchain,
      // and guilds without the feature should not load it to run a warning.
      const { rcon } = require('../services/zomboid/rcon');
      const reply = await rcon(guildId, action.command);
      return `ran \`${action.command}\` — ${reply ? reply.slice(0, 300) : 'no reply'}`;
    }

    default:
      throw new Error(`no executor for "${action.type}"`);
  }
}

/** One-line rendering of a pending action, for approval cards and logs. */
function describeAction(action) {
  switch (action.type) {
    case 'timeout':   return `Time out <@${action.userId}> for ${action.duration} minute(s) — ${action.reason}`;
    case 'warn':      return `Warn <@${action.userId}> — ${action.reason}`;
    case 'kick':      return `Kick <@${action.userId}> — ${action.reason}`;
    case 'ban':       return `Ban <@${action.userId}> (deleting ${action.deleteDays || 0}d of messages) — ${action.reason}`;
    case 'delete':    return `Delete the triggering message — ${action.reason}`;
    case 'flag':      return `🚩 Manipulation attempt by <@${action.userId}> — ${action.reason}`;
    case 'note':      return `Note against <@${action.userId}>: ${action.note}`;
    case 'clearnotes':return `Clear all notes for <@${action.userId}>`;
    case 'memory':    return `Remember about <@${action.userId}>: ${action.memory}`;
    case 'storytime': return `Tell an early tale of the day so far — ${action.reason || 'someone asked'}`;
    case 'pzcommand': return `Run on the game server: \`${action.command}\``;
    case 'pzrestart': return action.minutes > 0
      ? `Restart the game server in ${action.minutes} minute(s) — ${action.reason || 'no reason given'}`
      : `Restart the game server NOW — ${action.reason || 'no reason given'}`;
    default:          return `${action.type} ${JSON.stringify(action)}`;
  }
}

module.exports = { runAction, describeAction };
