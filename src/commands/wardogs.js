'use strict';
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const wardogs = require('../services/wardogs');

const METRIC_CHOICES = Object.entries(wardogs.METRICS).map(([value, m]) => ({ name: m.label, value }));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wardogs')
    .setDescription('WARDOGS stats, read from the game itself')
    .addSubcommand((sub) => sub
      .setName('link')
      .setDescription('Sign in with Steam to link (or refresh) your WARDOGS stats'))
    .addSubcommand((sub) => sub
      .setName('stats')
      .setDescription('Wardog level, roles, cash and gold')
      .addUserOption((o) => o.setName('who').setDescription('Someone else who has linked')))
    .addSubcommand((sub) => sub
      .setName('leaderboard')
      .setDescription('Everyone here who has linked, ranked')
      .addStringOption((o) => o.setName('by').setDescription('What to rank by (default: Wardog level)').addChoices(...METRIC_CHOICES)))
    .addSubcommand((sub) => sub
      .setName('unlink')
      .setDescription('Forget your WARDOGS account and stats')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'link') {
      const url = wardogs.createLink(interaction);
      if (!url) {
        return interaction.reply({ content: '❌ WARDOGS linking is not set up on this bot (WARDOGS_PUBLIC_URL).', flags: MessageFlags.Ephemeral });
      }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Sign in with Steam').setURL(url),
      );
      return interaction.reply({
        content: 'Sign in through Steam\'s own page; your password never reaches this bot. '
          + 'The game is asked for your stats once, and its login is thrown away straight after. '
          + 'This link works once, for 10 minutes, and your stats will appear here when you are done.',
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'stats') {
      const user = interaction.options.getUser('who') || interaction.user;
      const entry = wardogs.getPlayer(user.id);
      if (!entry) {
        return interaction.reply({
          content: user.id === interaction.user.id
            ? 'You have not linked a WARDOGS account. `/wardogs link` to do it.'
            : `${user.username} has not linked a WARDOGS account.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({ embeds: [wardogs.statsEmbed(entry, user)], allowedMentions: { parse: [] } });
    }

    if (sub === 'leaderboard') {
      await interaction.deferReply();
      const embed = await wardogs.leaderboardEmbed(interaction.guild, interaction.options.getString('by') || 'level');
      return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    if (sub === 'unlink') {
      const removed = wardogs.unlink(interaction.user.id);
      return interaction.reply({
        content: removed ? '🗑️ Your WARDOGS account and its history are forgotten.' : 'You had nothing linked.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({ content: '❌ That is not something /wardogs does.', flags: MessageFlags.Ephemeral });
  },
};
