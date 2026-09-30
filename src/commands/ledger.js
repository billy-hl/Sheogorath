'use strict';
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const ledger = require('../services/ledger');

const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ledger')
    .setDescription("The group's book: bets, rulings and kept quotes")
    .addSubcommand((sub) => sub
      .setName('bets')
      .setDescription('Bets on, offers waiting, and who owes whom')
      .addUserOption((o) => o.setName('who').setDescription('Just one person, with their record')))
    .addSubcommand((sub) => sub
      .setName('rulings')
      .setDescription('What the Mad God has ruled, and it stands')
      .addStringOption((o) => o.setName('search').setDescription('Words to look for').setMaxLength(100)))
    .addSubcommand((sub) => sub
      .setName('quote')
      .setDescription('A quote from the Ledger, at random')
      .addUserOption((o) => o.setName('who').setDescription('Only things this person said')))
    .addSubcommand((sub) => sub
      .setName('strike')
      .setDescription('Take a quote of yours out of the Ledger (an Owner can strike anything)')
      .addStringOption((o) => o
        .setName('entry')
        .setDescription('Which one: start typing')
        .setRequired(true)
        .setAutocomplete(true))),

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused();
    return interaction.respond(ledger.strikeChoices(interaction.guildId, interaction.member, typed));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const quiet = { parse: [] };

    if (sub === 'bets') {
      const whoUser = interaction.options.getUser('who');
      return interaction.reply({ embeds: [ledger.betsEmbed(guildId, whoUser?.id || null)], allowedMentions: quiet });
    }

    if (sub === 'rulings') {
      return interaction.reply({ embeds: [ledger.rulingsEmbed(guildId, interaction.options.getString('search'))], allowedMentions: quiet });
    }

    if (sub === 'quote') {
      const whoUser = interaction.options.getUser('who');
      const quote = ledger.randomQuote(guildId, whoUser?.id || null);
      if (!quote) {
        return interaction.reply({
          content: whoUser
            ? `Nothing ${whoUser.username} has said is in the Ledger. Yet.`
            : 'The Ledger holds no quotes. Right-click a message, Apps, **Keep in the Ledger**.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({ content: ledger.quoteText(quote), allowedMentions: quiet });
    }

    if (sub === 'strike') {
      let struck;
      try {
        struck = ledger.strike(guildId, interaction.options.getString('entry'), interaction.member);
      } catch (err) {
        return interaction.reply({ content: `❌ ${sentence(err.message)}`, flags: MessageFlags.Ephemeral });
      }
      if (struck.kind === 'bet') {
        // Its card would otherwise go on offering buttons for a bet that is gone.
        await ledger.redraw(interaction.client, { ...struck.entry, status: 'struck' }).catch(() => {});
      }
      return interaction.reply({ content: `🗑️ **${struck.entry.id}** is struck from the Ledger.`, flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ content: '❌ That is not something /ledger does.', flags: MessageFlags.Ephemeral });
  },
};
