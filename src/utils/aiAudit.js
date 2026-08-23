'use strict';
/**
 * Audit trail for everything Sheogorath decides on his own.
 *
 * Separate from the command log next door because the interesting column is
 * different. For a slash command the question is "who ran it"; there is always a
 * person. For an AI action the question is "why did he think that was allowed",
 * so every record carries the verdict capabilities.js reached and the reason it
 * gave — including for the ones that were refused, which are the records worth
 * having when something goes wrong.
 *
 * Two sinks, same split as the command log: everything to disk, the things staff
 * should see to a Discord channel.
 */
const path = require('path');
const { appendRecord, LOG_DIR } = require('./auditLog');
const { getGuildConfig } = require('../config/guilds');

const LOG_FILE = path.join(LOG_DIR, 'ai-actions.jsonl');

/** Verdicts staff are shown in Discord. Executions and refusals both matter; */
/** shadow entries would bury the channel, so they stay on disk. */
const MIRRORED = new Set(['execute', 'deny']);

const ICONS = {
  execute: '⚡',
  propose: '🗳️',
  shadow: '👁️',
  deny: '⛔',
  error: '⚠️',
};

let client = null;

/** Give the trail a Discord client so it can mirror to a channel. */
function setClient(c) {
  client = c;
}

/**
 * Where staff-facing AI notices go. `modApprovals` if the guild has set one,
 * otherwise the existing command log — a guild that already has one private
 * staff channel shouldn't be made to create a second.
 */
function staffChannelId(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg?.channels?.modApprovals || cfg?.channels?.commandLog || null;
}

async function staffChannel(guildId) {
  const id = staffChannelId(guildId);
  if (!id || !client) return null;
  try {
    const channel = await client.channels.fetch(id);
    return channel?.isTextBased() ? channel : null;
  } catch (err) {
    console.warn('[AI Audit] Could not reach the staff channel:', err.message);
    return null;
  }
}

/**
 * Record one decision.
 *
 * @param {object} entry
 * @param {string} entry.guildId
 * @param {'execute'|'propose'|'shadow'|'deny'|'error'} entry.verdict
 * @param {string} entry.reason      why capabilities.js landed there
 * @param {object} entry.action      the parsed action
 * @param {string} [entry.summary]   past-tense description of what happened
 * @param {string} [entry.authorId]  whose message triggered it
 * @param {string} [entry.channelId]
 * @param {string} [entry.messageUrl]
 * @param {boolean} [entry.requesterIsStaff]
 */
function logAiAction(entry) {
  const record = { at: new Date().toISOString(), ...entry };
  appendRecord(LOG_FILE, record);

  const tag = `[AI ${entry.verdict}]`;
  console.log(`${tag} ${entry.action?.type} — ${entry.reason}${entry.summary ? ` — ${entry.summary}` : ''}`);

  if (MIRRORED.has(entry.verdict)) {
    // Fire-and-forget, like the command mirror: telling staff must never delay
    // or fail the action it is describing.
    mirror(record).catch(() => {});
  }
  return record;
}

async function mirror(record) {
  const channel = await staffChannel(record.guildId);
  if (!channel) return;

  const { describeAction } = require('../ai/executors');
  const icon = ICONS[record.verdict] || '•';
  const what = record.summary || describeAction(record.action);
  const who = record.authorId ? ` (prompted by <@${record.authorId}>)` : '';
  const link = record.messageUrl ? `\n${record.messageUrl}` : '';

  await channel.send({
    content: `${icon} **Sheogorath ${record.verdict === 'execute' ? 'acted' : 'refused'}** — ${what}` +
      `\n> ${record.reason}${who}${link}`,
    allowedMentions: { parse: [] },
  });
}

/** One-off notice to staff that isn't tied to a single action. */
async function notifyStaff(guildId, content) {
  const channel = await staffChannel(guildId);
  if (!channel) return false;
  await channel.send({ content, allowedMentions: { parse: [] } });
  return true;
}

module.exports = { logAiAction, notifyStaff, setClient, staffChannel, staffChannelId, LOG_FILE };
