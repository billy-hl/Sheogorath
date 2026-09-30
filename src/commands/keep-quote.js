'use strict';
/**
 * Right-click a message, Apps, "Keep in the Ledger": the words, exactly as
 * written, kept under whoever wrote them.
 *
 * The Apps menu rather than asking Sheogorath because this way nothing is
 * paraphrased: a quote is only worth keeping if it is what was actually said.
 * Asking him in a reply does the same thing (see the `quote` action).
 */
const { ContextMenuCommandBuilder, ApplicationCommandType, MessageFlags } = require('discord.js');
const ledger = require('../services/ledger');

const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Keep in the Ledger')
    .setType(ApplicationCommandType.Message),

  async execute(interaction) {
    const message = interaction.targetMessage;
    let kept;
    try {
      kept = ledger.keepMessage(interaction.guildId, message, interaction.user.id);
    } catch (err) {
      return interaction.reply({ content: `❌ ${sentence(err.message)}`, flags: MessageFlags.Ephemeral });
    }
    if (kept.already) {
      return interaction.reply({ content: `That is already in the Ledger as **${kept.quote.id}**.`, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({
      content: `📜 Kept in the Ledger as **${kept.quote.id}**:\n${ledger.quoteText(kept.quote)}`,
      allowedMentions: { parse: [] },
    });
  },
};
