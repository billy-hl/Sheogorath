'use strict';
/**
 * The Approve/Deny card.
 *
 * Anything Sheogorath is not allowed to do on his own lands here instead of
 * being dropped. That distinction is the whole point: a member can still get his
 * attention on a real problem — the request becomes a card in the staff channel
 * rather than nothing — but the thing that actually moves is a Sheriff's finger.
 *
 * Pending cards live in memory only. A restart loses them, and a click on a
 * stale card says so rather than acting on a decision nobody can see the
 * context for any more. That is the safe direction to fail: the cost is a
 * Sheriff re-doing it by hand, and the alternative is a card outliving the
 * situation it was raised about.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { isStaff } = require('../utils/permissions');
const { aiTitles, getGuildConfig } = require('../config/guilds');
const { logAiAction, staffChannel } = require('../utils/aiAudit');
const { runAction, describeAction } = require('./executors');

const NAMESPACE = 'aiapprove';
/** Cards go stale after a day — long enough for an overnight, short enough
 * that nobody approves a timeout for an argument that ended last week. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** id -> { action, ctx, createdAt } */
const pending = new Map();
let seq = 0;

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(id);
  }
}

function buildRow(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${NAMESPACE}:${id}:approve`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${NAMESPACE}:${id}:deny`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

/**
 * Post one action for a Sheriff to rule on.
 *
 * @param {object} action  the parsed action, already normalized by the gate
 * @param {object} ctx     `{ guild, guildId, message, authorId, reason }`
 * @returns {Promise<boolean>} whether a card was actually posted
 */
async function proposeAction(action, ctx) {
  sweep();

  const channel = await staffChannel(ctx.guildId);
  if (!channel) {
    // No staff channel means no approval is possible, so the action is dead.
    // Recorded as a refusal rather than a proposal, because that is what
    // actually happened to it.
    logAiAction({
      guildId: ctx.guildId,
      verdict: 'deny',
      reason: `${ctx.reason} — and this guild has no staff channel to ask in`,
      action,
      authorId: ctx.authorId,
      channelId: ctx.message?.channelId,
    });
    return false;
  }

  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  const link = ctx.message?.url ? `\n${ctx.message.url}` : '';
  const who = ctx.authorId ? ` (prompted by <@${ctx.authorId}>)` : '';

  const card = await channel.send({
    content:
      `🗳️ **Sheogorath is asking permission**\n` +
      `> ${describeAction(action)}\n` +
      `Held because ${ctx.reason}.${who}${link}`,
    components: [buildRow(id)],
    allowedMentions: { parse: [] },
  });

  pending.set(id, {
    action,
    createdAt: Date.now(),
    ctx: {
      guild: ctx.guild,
      guildId: ctx.guildId,
      message: ctx.message || null,
      authorId: ctx.authorId || null,
      reason: ctx.reason,
    },
    cardId: card.id,
  });

  logAiAction({
    guildId: ctx.guildId,
    verdict: 'propose',
    reason: ctx.reason,
    action,
    authorId: ctx.authorId,
    channelId: ctx.message?.channelId,
    messageUrl: ctx.message?.url,
  });

  return true;
}

/** Whether an interaction belongs to this module. */
function isApprovalButton(interaction) {
  return interaction.isButton?.() && interaction.customId.startsWith(`${NAMESPACE}:`);
}

/**
 * Handle a click on Approve or Deny.
 *
 * The staff check here is not a duplicate of the one on the card's visibility —
 * channel permissions decide who can *see* the card, this decides who can act on
 * it, and the two are not the same set in a guild where an Owner has given
 * someone read access to the log channel.
 */
async function handleApprovalButton(interaction) {
  const [, id, choice] = interaction.customId.split(':');

  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: `❌ Only ${aiTitles(getGuildConfig(interaction.guildId)).approvers} can rule on what Sheogorath asks for.`,
      flags: 64,
    });
  }

  const entry = pending.get(id);
  if (!entry) {
    await interaction.update({
      content: `${interaction.message.content}\n\n⌛ *This request has expired — the bot restarted, or it sat for over a day. Do it by hand if it still needs doing.*`,
      components: [buildRow(id, true)],
    }).catch(() => {});
    return;
  }

  pending.delete(id);
  const { action, ctx } = entry;

  if (choice === 'deny') {
    logAiAction({
      guildId: ctx.guildId,
      verdict: 'deny',
      reason: `denied by ${interaction.user.tag}`,
      action,
      authorId: ctx.authorId,
    });
    return interaction.update({
      content: `${interaction.message.content}\n\n⛔ **Denied** by <@${interaction.user.id}>.`,
      components: [buildRow(id, true)],
    });
  }

  // --- Approved. ---
  await interaction.deferUpdate();
  try {
    const summary = await runAction(action, ctx);
    // Deliberately not counted against the hourly budget in capabilities.js:
    // that budget exists to bound what Sheogorath does unsupervised, and this
    // was supervised. Rationing a Sheriff's own clicks would be backwards.
    logAiAction({
      guildId: ctx.guildId,
      verdict: 'execute',
      reason: `approved by ${interaction.user.tag}`,
      action,
      summary,
      authorId: ctx.authorId,
    });
    await interaction.editReply({
      content: `${interaction.message.content}\n\n✅ **Approved** by <@${interaction.user.id}> — ${summary}`,
      components: [buildRow(id, true)],
    });
  } catch (err) {
    logAiAction({
      guildId: ctx.guildId,
      verdict: 'error',
      reason: `approved by ${interaction.user.tag} but failed`,
      action,
      summary: err.message,
      authorId: ctx.authorId,
    });
    await interaction.editReply({
      content: `${interaction.message.content}\n\n⚠️ **Approved** by <@${interaction.user.id}> but it failed — ${err.message}`,
      components: [buildRow(id, true)],
    });
  }
}

/** How many cards are waiting. Used by /health and the status command. */
function pendingCount(guildId = null) {
  sweep();
  if (!guildId) return pending.size;
  return [...pending.values()].filter((e) => e.ctx.guildId === guildId).length;
}

module.exports = { proposeAction, isApprovalButton, handleApprovalButton, pendingCount, NAMESPACE };
