'use strict';
const { timeoutUser, warnUser, deleteMessage } = require('../services/automod');
const { addUserNote, clearUserNotes } = require('../storage/state');
const { addMemory } = require('../storage/memory');

/**
 * Action tag format the AI can include in its response:
 *   [ACTION:timeout:userId:durationMinutes:reason]
 *   [ACTION:warn:userId:reason]
 *   [ACTION:delete:reason]
 *   [ACTION:memory:userId:memory text]
 *
 * Returns { cleanResponse, actions[] }
 */
function parseActions(response) {
  const actionRegex = /\[ACTION:(timeout|warn|delete|note|clearnotes|memory):([^\]]+)\]/g;
  const actions = [];
  let cleanResponse = response;

  // Strip any incomplete/unclosed action tags that got cut off by token limit
  cleanResponse = cleanResponse.replace(/\[ACTION:[^\]]*$/g, '').trim();

  console.log('[Actions] Parsing response for action tags...');
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
        actions.push({
          type: 'warn',
          userId,
          reason: reasonParts.join(':') || 'AI-initiated warning',
        });
        break;
      }
      case 'delete': {
        actions.push({
          type: 'delete',
          reason: parts.join(':') || 'AI-initiated deletion',
        });
        break;
      }
      case 'note': {
        const [userId, ...noteParts] = parts;
        actions.push({
          type: 'note',
          userId,
          note: noteParts.join(':'),
        });
        break;
      }
      case 'clearnotes': {
        const [userId] = parts;
        actions.push({ type: 'clearnotes', userId });
        break;
      }
      case 'memory': {
        const [userId, ...memoryParts] = parts;
        actions.push({
          type: 'memory',
          userId,
          memory: memoryParts.join(':'),
        });
        break;
      }
    }

    // Strip the action tag from the visible response
    cleanResponse = cleanResponse.replace(fullMatch, '').trim();
  }

  if (actions.length > 0) {
    console.log(`[Actions] Found ${actions.length} action tag(s) in response`);
  } else {
    console.log('[Actions] No action tags found in response');
  }

  return { cleanResponse, actions };
}

/**
 * Execute parsed actions.
 * @param {Array} actions - From parseActions
 * @param {Object} context - { guild, message }
 */
async function executeActions(actions, context) {
  const { guild, message } = context;
  const results = [];

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'timeout':
          await timeoutUser(guild, action.userId, action.duration, action.reason);
          results.push({ ...action, success: true });
          console.log(`[AI Action] Timed out ${action.userId} for ${action.duration}m: ${action.reason}`);
          break;

        case 'warn':
          await warnUser(guild, action.userId, action.reason);
          results.push({ ...action, success: true });
          console.log(`[AI Action] Warned ${action.userId}: ${action.reason}`);
          break;

        case 'note':
          addUserNote(action.userId, action.note);
          results.push({ ...action, success: true });
          console.log(`[AI Action] Added note for ${action.userId}: ${action.note}`);
          break;

        case 'clearnotes':
          clearUserNotes(action.userId);
          results.push({ ...action, success: true });
          console.log(`[AI Action] Cleared notes for ${action.userId}`);
          break;

        case 'memory':
          addMemory(action.userId, action.memory);
          results.push({ ...action, success: true });
          console.log(`[AI Action] Saved memory for ${action.userId}: ${action.memory}`);
          break;

        case 'delete':
          if (message) {
            await deleteMessage(message, action.reason);
            results.push({ ...action, success: true });
            console.log(`[AI Action] Deleted message ${message.id}: ${action.reason}`);
          }
          break;
      }
    } catch (error) {
      console.error(`[AI Action] Failed to execute ${action.type}:`, error.message);
      results.push({ ...action, success: false, error: error.message });
    }
  }

  return results;
}

module.exports = { parseActions, executeActions };
