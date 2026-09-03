'use strict';
/**
 * Turning what Sheogorath said he wants to do into what actually happens.
 *
 * Three steps, deliberately separate files:
 *
 *   parseActions()    here — pull the tags out of the model's reply
 *   decide()          ai/capabilities.js — is he allowed to?
 *   runAction()       ai/executors.js — do it
 *
 * Nothing in this file judges an action on its merits. It resolves who the
 * target is, hands the decision to the gate, and routes the answer. That
 * ordering is the point: before the gate existed, every tag the model emitted
 * was performed, which meant anyone who could get a sentence in front of him
 * could aim him. Now the parse is untrusted input all the way through.
 *
 * Action tag format:
 *   [ACTION:timeout:userId:durationMinutes:reason]
 *   [ACTION:warn:userId:reason]
 *   [ACTION:kick:userId:reason]
 *   [ACTION:ban:userId:deleteDays:reason]
 *   [ACTION:delete:reason]
 *   [ACTION:flag:userId:reason]
 *   [ACTION:storytime:reason]
 *   [ACTION:note:userId:note text]
 *   [ACTION:clearnotes:userId]
 *   [ACTION:memory:userId:memory text]
 *   [ACTION:pz:server command]
 *   [ACTION:pzrestart:minutes:reason]
 */
const { decide, recordExecution, BREAKER_LIMIT } = require('./capabilities');
const { runAction } = require('./executors');
const { proposeAction } = require('./approvals');
const { logAiAction, notifyStaff } = require('../utils/aiAudit');
const { getGuildConfig } = require('../config/guilds');

const ACTION_TYPES = 'timeout|warn|kick|ban|delete|flag|storytime|note|clearnotes|memory|pzrestart|pz';

/**
 * Pull action tags out of a reply and strip them from the visible text.
 *
 * The scrubbing is belt-and-braces because a tag that survives into a Discord
 * message is worse than one that never parsed: it teaches every reader the exact
 * syntax to try in their next message. Truncated tags matter for the same
 * reason — `max_tokens` regularly cuts one in half.
 *
 * @returns {{cleanResponse: string, actions: object[]}}
 */
function parseActions(response) {
  const actionRegex = new RegExp(`\\[ACTION:(${ACTION_TYPES}):([^\\]]+)\\]`, 'g');
  const actions = [];
  let cleanResponse = response;

  let match;
  while ((match = actionRegex.exec(response)) !== null) {
    const [fullMatch, type, params] = match;
    const parts = params.split(':');

    switch (type) {
      case 'timeout': {
        const [userId, duration, ...reasonParts] = parts;
        actions.push({
          type: 'timeout',
          userId,
          duration: parseInt(duration, 10) || 5,
          reason: reasonParts.join(':') || 'AI-initiated timeout',
        });
        break;
      }
      case 'warn': {
        const [userId, ...reasonParts] = parts;
        actions.push({ type: 'warn', userId, reason: reasonParts.join(':') || 'AI-initiated warning' });
        break;
      }
      case 'kick': {
        const [userId, ...reasonParts] = parts;
        actions.push({ type: 'kick', userId, reason: reasonParts.join(':') || 'AI-initiated kick' });
        break;
      }
      case 'ban': {
        const [userId, days, ...reasonParts] = parts;
        actions.push({
          type: 'ban',
          userId,
          deleteDays: parseInt(days, 10) || 0,
          reason: reasonParts.join(':') || 'AI-initiated ban',
        });
        break;
      }
      case 'delete':
        actions.push({ type: 'delete', reason: parts.join(':') || 'AI-initiated deletion' });
        break;
      case 'storytime':
        actions.push({ type: 'storytime', reason: parts.join(':') || 'someone asked' });
        break;
      case 'flag': {
        const [userId, ...reasonParts] = parts;
        actions.push({ type: 'flag', userId, reason: reasonParts.join(':') || 'unspecified' });
        break;
      }
      case 'note': {
        const [userId, ...noteParts] = parts;
        actions.push({ type: 'note', userId, note: noteParts.join(':') });
        break;
      }
      case 'clearnotes':
        actions.push({ type: 'clearnotes', userId: parts[0] });
        break;
      case 'memory': {
        const [userId, ...memoryParts] = parts;
        actions.push({ type: 'memory', userId, memory: memoryParts.join(':') });
        break;
      }
      case 'pzrestart': {
        const [minutes, ...reasonParts] = parts;
        actions.push({
          type: 'pzrestart',
          minutes: parseInt(minutes, 10),
          reason: reasonParts.join(':') || 'asked for in chat',
        });
        break;
      }
      case 'pz':
        // Rejoined rather than taking parts[0]: PZ commands contain colons
        // (`Base.Axe`), and splitting one would send a truncated command.
        actions.push({ type: 'pzcommand', command: params.trim() });
        break;
    }

    cleanResponse = cleanResponse.replace(fullMatch, '').trim();
  }

  cleanResponse = scrub(cleanResponse);

  if (actions.length > 0) {
    console.log(`[Actions] Parsed ${actions.length} action tag(s): ${actions.map(a => a.type).join(', ')}`);
  }

  return { cleanResponse, actions };
}

/** Strip complete, truncated and half-eaten action tags from visible text. */
function scrub(text) {
  return String(text)
    .replace(/\[ACTION:[^\]]*\]/gs, '')  // complete tags
    .replace(/\[ACTION:[^\]]*$/gm, '')   // truncated at end of line
    .replace(/\[ACTION:.*/gs, '')        // any leftover prefix
    .trim();
}

/**
 * Resolve the member an action is aimed at, if any.
 *
 * A miss is not an error — the model invents IDs, and an ID that isn't a member
 * of this guild is exactly the case the gate refuses on.
 */
async function resolveTarget(guild, userId) {
  if (!guild || !userId || !/^\d{17,20}$/.test(userId)) return null;
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

/**
 * Put every parsed action through the gate and route the verdict.
 *
 * @param {object[]} actions from parseActions
 * @param {object} context
 * @param {import('discord.js').Guild} context.guild
 * @param {import('discord.js').Message} [context.message] the triggering message
 * @param {string} [context.guildId]
 * @returns {Promise<object[]>} one result per action
 */
async function executeActions(actions, context) {
  const { guild, message } = context;
  const guildId = context.guildId || guild?.id;
  const guildConfig = getGuildConfig(guildId);
  const authorId = context.authorId || message?.author?.id || null;
  const requester = context.requester || message?.member || null;
  const botMember = guild?.members?.me || null;

  const results = [];

  for (const action of actions) {
    const targetMember = await resolveTarget(guild, action.userId);

    const { verdict, reason, action: gated } = decide(action, {
      guildId,
      guildConfig,
      authorId,
      requester,
      targetMember,
      botMember,
      // Needed by the help-channel rule in capabilities.js.
      channelId: message?.channelId,
    });

    const base = {
      guildId,
      action: gated,
      reason,
      authorId,
      channelId: message?.channelId,
      messageUrl: message?.url,
    };

    if (verdict === 'deny' || verdict === 'shadow') {
      logAiAction({ ...base, verdict });
      results.push({ ...gated, verdict, reason, success: false });
      continue;
    }

    if (verdict === 'propose') {
      await proposeAction(gated, { guild, guildId, message, authorId, reason })
        .catch((err) => console.warn('[Actions] Could not post approval card:', err.message));
      results.push({ ...gated, verdict, reason, success: false });
      continue;
    }

    // --- execute ---
    try {
      const summary = await runAction(gated, { guild, guildId, message, followUps: context.followUps });
      const { justTripped, count } = recordExecution(guildId, gated.type);
      logAiAction({ ...base, verdict: 'execute', summary });
      results.push({ ...gated, verdict, reason, success: true });

      if (justTripped) {
        // Staff hear about this once, on the way past the limit — after this
        // the gate quietly turns everything into proposals, and a channel full
        // of "brake still tripped" would be noise.
        await notifyStaff(
          guildId,
          `🛑 **Sheogorath has been put on a leash.** ${count} actions in the last hour ` +
          `(limit ${BREAKER_LIMIT}). Everything he wants to do now comes here for approval ` +
          `until the hour is out. Worth a look at what set him off.`
        ).catch(() => {});
      }
    } catch (err) {
      logAiAction({ ...base, verdict: 'error', summary: err.message });
      results.push({ ...gated, verdict, reason, success: false, error: err.message });
    }
  }

  return results;
}

module.exports = { parseActions, executeActions, scrub, ACTION_TYPES };
