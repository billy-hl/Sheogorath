'use strict';
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const drops = require('../services/drops');

const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('drops')
    .setDescription('Twitch and Kick drops for the games we play')
    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('The games we follow, and which have drops on now'))
    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('Follow a game for drops')
      .addStringOption((o) => o
        .setName('game')
        .setDescription('As Twitch or Kick names it: Rust, Path of Exile 2')
        .setRequired(true)
        .setMaxLength(80)
        .setAutocomplete(true)))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Stop following a game you added (an Owner can remove any)')
      .addStringOption((o) => o
        .setName('game')
        .setDescription('Which one')
        .setRequired(true)
        .setAutocomplete(true))),

  async autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() || '').toLowerCase();
    const sub = interaction.options.getSubcommand();
    // Suggestions for add are the games with campaigns now, as the sites spell
    // them, from the last read: autocomplete has three seconds, not a fetch.
    const names = sub === 'add'
      ? drops.knownGameNames()
      : drops.gamesFor(interaction.guildId).map((g) => g.name);
    return interaction.respond(names
      .filter((n) => n.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const { guild } = interaction;
    const cfg = getGuildConfig(guild.id)?.gameNews;
    if (!cfg) {
      return interaction.reply({ content: '❌ This server has no game updates channel set up.', flags: MessageFlags.Ephemeral });
    }

    if (sub === 'list') {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [await drops.listEmbed(guild.id)], allowedMentions: { parse: [] } });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = (content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
    try {
      if (sub === 'add') {
        const game = drops.addGame(guild.id, interaction.options.getString('game'), interaction.member);
        const now = await drops.summaryFor(guild.id, game);
        // Anything on now goes to the channel straight away, not in half an hour.
        await drops.pollDrops(interaction.client, guild.id, cfg);
        return reply(`🎁 Following **${game.name}** for Twitch and Kick drops, posted in <#${cfg.drops?.channel || cfg.channel}>. ${now}`);
      }
      if (sub === 'remove') {
        const game = drops.removeGame(guild.id, interaction.options.getString('game'), interaction.member);
        return reply(`🗑️ No longer following **${game.name}** for drops.`);
      }
    } catch (err) {
      return reply(`❌ ${sentence(err.message)}`);
    }
    return reply('❌ That is not something /drops does.');
  },
};
