'use strict';
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const {
  postNow, showDate, setOptOut, parseMonthDay, dateName, partsIn,
} = require('../services/onThisDay');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('onthisday')
    .setDescription('The best of a date in years gone by')
    .addSubcommand((sub) => sub
      .setName('show')
      .setDescription('Dig up the best message from a date in years past')
      .addStringOption((opt) => opt
        .setName('date')
        .setDescription('Month and day, like 11-15 or Nov 15. Today by default.')))
    .addSubcommand((sub) => sub
      .setName('opt-out')
      .setDescription('Keep your old messages and your anniversary out of it'))
    .addSubcommand((sub) => sub
      .setName('opt-in')
      .setDescription('Let your old messages be dug up again'))
    .addSubcommand((sub) => sub
      .setName('post')
      .setDescription("Post today's to its channel now")),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const ephemeral = MessageFlags.Ephemeral;
    const cfg = getGuildConfig(guildId)?.onThisDay;
    if (!cfg) {
      return interaction.reply({ content: '❌ On this day is not set up here: it needs an `onThisDay.channel`.', flags: ephemeral });
    }

    if (sub === 'opt-out' || sub === 'opt-in') {
      const out = sub === 'opt-out';
      const changed = setOptOut(guildId, interaction.user.id, out);
      let reply;
      if (out) reply = changed ? 'Done. Your old messages stay buried, and your anniversary goes unmentioned.' : 'You were already out of it.';
      else reply = changed ? 'Done. Your old messages can be dug up again.' : 'You were never out of it.';
      return interaction.reply({ content: reply, flags: ephemeral });
    }

    if (sub === 'post') {
      // Admin-only, enforced in utils/permissions.js.
      await interaction.deferReply({ flags: ephemeral });
      const sent = await postNow(interaction.client, guildId);
      return interaction.editReply(sent
        ? `Posted: ${sent.url}`
        : 'Nothing from today in years past cleared the bar, and nobody has an anniversary. Nothing was posted.');
    }

    // show
    const typed = interaction.options.getString('date');
    let date;
    if (typed) {
      date = parseMonthDay(typed);
      if (!date) {
        return interaction.reply({ content: `I can't read "${typed}" as a date. Try 11-15 or Nov 15, month first.`, flags: ephemeral });
      }
    } else {
      const today = partsIn(new Date(), cfg.timeZone);
      date = { month: today.month, day: today.day };
    }

    // Reading nine years of a date can take a while the first time it is asked.
    await interaction.deferReply();
    const payload = await showDate(interaction.guild, date);
    return interaction.editReply(payload
      || `Nothing from ${dateName(date.month, date.day)} in years past drew enough of a reaction to dig up.`);
  },
};
