'use strict';
const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const events = require('../services/events');

const WHEN_HELP = 'When it starts: Friday 8pm, Dec 11 1pm PT, 2026-12-11 13:00';
const unix = (date) => Math.floor(date.getTime() / 1000);

/** The options add and edit share, after each one's own required ones. */
const details = (sub) => sub
  .addNumberOption((o) => o
    .setName('hours')
    .setDescription(`How long it runs (${events.DEFAULT_HOURS} hours if you don't say)`)
    .setMinValue(0.5)
    .setMaxValue(24))
  .addChannelOption((o) => o
    .setName('voice')
    .setDescription('Hold it in a voice channel')
    .addChannelTypes(ChannelType.GuildVoice))
  .addStringOption((o) => o
    .setName('where')
    .setDescription('Where it happens if not in voice: a game, a site')
    .setMaxLength(100))
  .addStringOption((o) => o
    .setName('about')
    .setDescription('A line or two about it')
    .setMaxLength(1000));

/** The event a person picked, or typed without picking. */
function keyFor(guildId, value) {
  const ev = events.eventsFor(guildId).find((e) => e.key === value) || events.findEvent(guildId, value);
  if (!ev) throw new Error(`there is no event like "${value}" coming up`);
  return ev.key;
}

/** A Steam app id from the picker, or from a configured game's name typed out. */
function appIdFor(guildId, value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return value;
  const games = getGuildConfig(guildId)?.gameNews?.steamApps || [];
  return games.find((g) => g.name.toLowerCase() === value.trim().toLowerCase())?.appId || null;
}

const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('The server calendar: add an event, change one, or see what is coming')
    .addSubcommand((sub) => details(sub
      .setName('add')
      .setDescription('Put an event on the calendar')
      .addStringOption((o) => o.setName('name').setDescription('What it is').setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName('when').setDescription(WHEN_HELP).setRequired(true).setMaxLength(80)))
      .addStringOption((o) => o
        .setName('game')
        .setDescription('The Steam game it is for, for its cover art')
        .setAutocomplete(true)))
    .addSubcommand((sub) => details(sub
      .setName('edit')
      .setDescription('Change an event you added (an Owner can change any)')
      .addStringOption((o) => o.setName('event').setDescription('Which one').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('name').setDescription('A new name').setMaxLength(100))
      .addStringOption((o) => o.setName('when').setDescription(WHEN_HELP).setMaxLength(80))))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Take an event you added off the calendar (an Owner can remove any)')
      .addStringOption((o) => o.setName('event').setDescription('Which one').setRequired(true).setAutocomplete(true)))
    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription("What's coming up")),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const typed = String(focused.value || '').toLowerCase();

    if (focused.name === 'game') {
      const games = getGuildConfig(interaction.guildId)?.gameNews?.steamApps || [];
      return interaction.respond(games
        .filter((g) => g.name.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((g) => ({ name: g.name.slice(0, 100), value: g.appId })));
    }

    const tz = getGuildConfig(interaction.guildId)?.timeZone || 'America/Chicago';
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' });
    const now = Date.now();
    return interaction.respond(events.eventsFor(interaction.guildId)
      .filter((e) => e.start.getTime() > now && e.name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((e) => ({ name: `${e.name.slice(0, 85)} · ${day.format(e.start)}`, value: e.key })));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const { guild, options: o } = interaction;
    const ephemeral = MessageFlags.Ephemeral;
    if (!getGuildConfig(guild.id)?.gameNews?.eventsChannel) {
      return interaction.reply({ content: '❌ This server has no events channel set up.', flags: ephemeral });
    }

    if (sub === 'list') {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [await events.listEmbed(guild)], allowedMentions: { parse: [] } });
    }

    await interaction.deferReply({ flags: ephemeral });
    const reply = (content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
    const voice = o.getChannel('voice');
    try {
      if (sub === 'add') {
        const { ev, discordEvent } = await events.addEvent(interaction.client, guild, {
          name: o.getString('name'),
          when: o.getString('when'),
          hours: o.getNumber('hours'),
          voice: voice?.id,
          where: o.getString('where'),
          appId: appIdFor(guild.id, o.getString('game')),
          about: o.getString('about'),
        }, interaction.member);
        return reply(`📅 **${ev.name}** is on the calendar for <t:${unix(ev.start)}:F> (<t:${unix(ev.start)}:R>).`
          + `${discordEvent ? `\n${discordEvent.url}` : ''}`);
      }

      if (sub === 'edit') {
        const changes = {
          name: o.getString('name'),
          when: o.getString('when'),
          hours: o.getNumber('hours'),
          voice: voice?.id,
          where: o.getString('where'),
          about: o.getString('about'),
        };
        if (Object.values(changes).every((v) => v === null || v === undefined)) {
          return reply('Nothing to change. Give it a new name, time, length, place or description.');
        }
        const { ev } = await events.editEvent(interaction.client, guild, keyFor(guild.id, o.getString('event')), changes, interaction.member);
        return reply(`🗓️ **${ev.name}** — <t:${unix(ev.start)}:F> (<t:${unix(ev.start)}:R>).`);
      }

      if (sub === 'remove') {
        const ev = await events.removeEvent(interaction.client, guild, keyFor(guild.id, o.getString('event')), interaction.member);
        return reply(`🗑️ **${ev.name}** is off the calendar.`);
      }
    } catch (err) {
      return reply(`❌ ${sentence(err.message)}`);
    }
    return reply('❌ That is not something /event does.');
  },
};
