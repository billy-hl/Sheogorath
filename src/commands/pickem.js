'use strict';
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { standingsEmbed, openNext, currentSeason } = require('../services/pickem');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pickem')
    .setDescription("UFC pick'em: call the winners of each card and climb the season table")
    .addSubcommand((sub) => sub
      .setName('standings')
      .setDescription('The season table')
      .addIntegerOption((opt) => opt
        .setName('season')
        .setDescription('Which year (this one by default)')
        .setMinValue(2026)
        .setMaxValue(2100)))
    .addSubcommand((sub) => sub
      .setName('open')
      .setDescription('Open picks for the next card now, instead of waiting for fight week')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'standings') {
      const season = String(interaction.options.getInteger('season') || currentSeason());
      return interaction.reply({
        embeds: [standingsEmbed(interaction.guildId, season)],
        allowedMentions: { parse: [] },
      });
    }

    // `open` — admin-only, enforced in utils/permissions.js.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply(await openNext(interaction.client, interaction.guildId));
  },
};
