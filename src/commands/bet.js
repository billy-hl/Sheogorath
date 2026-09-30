'use strict';
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const ledger = require('../services/ledger');

const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;

const against = (sub) => sub.addUserOption((o) => o
  .setName('against')
  .setDescription('Who you are betting (leave it empty and anyone may take it)'));
const stakes = (sub) => sub.addStringOption((o) => o
  .setName('stakes')
  .setDescription('What the loser owes: a beer, $5, a week with a stupid name')
  .setMaxLength(100));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bet')
    .setDescription('Put a bet to somebody. Nothing is on until they take it')
    .addSubcommand((sub) => stakes(against(sub
      .setName('offer')
      .setDescription('Bet on anything. Settled when the loser says so')
      .addStringOption((o) => o
        .setName('terms')
        .setDescription('What you say will happen')
        .setRequired(true)
        .setMaxLength(200))))
      .addStringOption((o) => o
        .setName('settle_by')
        .setDescription('When it will be known: Oct 20, Friday 8pm, in 2 weeks. He chases it then')
        .setMaxLength(80)))
    .addSubcommand((sub) => stakes(against(sub
      .setName('ufc')
      .setDescription('Back a fighter on an upcoming card. It settles itself from the result')
      .addStringOption((o) => o
        .setName('pick')
        .setDescription('The fighter you are backing: start typing a name')
        .setRequired(true)
        .setAutocomplete(true))))),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'pick') return interaction.respond([]);
    const tz = getGuildConfig(interaction.guildId)?.timeZone || 'America/Chicago';
    const choices = await ledger.fightChoices(focused.value, tz).catch(() => []);
    return interaction.respond(choices);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const ephemeral = MessageFlags.Ephemeral;
    const opponent = interaction.options.getUser('against');
    const guildId = interaction.guildId;

    let againstMember = null;
    if (opponent) {
      if (opponent.bot) return interaction.reply({ content: '❌ Bots do not bet. They would only lose.', flags: ephemeral });
      againstMember = await interaction.guild.members.fetch(opponent.id).catch(() => null);
      if (!againstMember) return interaction.reply({ content: `❌ ${opponent.username} is not in this server.`, flags: ephemeral });
    }

    const input = {
      by: interaction.user.id,
      byName: interaction.member?.displayName || interaction.user.username,
      against: againstMember?.id || null,
      againstName: againstMember?.displayName || null,
      stakes: interaction.options.getString('stakes'),
      channelId: interaction.channelId,
    };

    // A UFC bet may have to read the fight list from ESPN first, which can take
    // longer than Discord waits for an answer.
    const deferred = sub === 'ufc';
    if (deferred) await interaction.deferReply({ flags: ephemeral });

    let bet;
    try {
      if (sub === 'offer') {
        bet = ledger.offerBet(guildId, {
          ...input,
          terms: interaction.options.getString('terms'),
          settleBy: interaction.options.getString('settle_by'),
        });
      } else if (sub === 'ufc') {
        bet = await ledger.offerUfcBet(guildId, { ...input, pick: interaction.options.getString('pick') });
      } else {
        throw new Error('that is not something /bet does');
      }
    } catch (err) {
      const content = `❌ ${sentence(err.message)}`;
      return deferred ? interaction.editReply({ content }) : interaction.reply({ content, flags: ephemeral });
    }

    const card = ledger.offerMessage(bet);
    if (deferred) {
      // Posted as a message of its own rather than as an edit of the deferred
      // reply: an edit never pings, and whoever the bet is put to should hear.
      const channel = interaction.channel || await interaction.client.channels.fetch(interaction.channelId);
      const message = await channel.send(card);
      ledger.attachCard(guildId, bet.id, message);
      return interaction.editReply({ content: `🥊 Your bet is on the card: ${message.url}` });
    }
    await interaction.reply(card);
    ledger.attachCard(guildId, bet.id, await interaction.fetchReply());
  },
};
