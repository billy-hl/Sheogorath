'use strict';
/**
 * The playtest agreement: one button that lets someone into the testers'
 * channel once they agree to keep the game to themselves.
 *
 * Pressing it gives the guild's `playtest.role` (which opens
 * `playtest.channel`) and writes who agreed, and when, in `playtest.log`: a
 * private channel, where the game posts its own NDA signatures too, so the two
 * records of a tester sit side by side. It only ever grants. Taking a tester
 * out is done by hand, by taking the role off.
 *
 * The button carries no role ID. What it grants is read from config, so a
 * crafted custom_id has nothing to name.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');

const ID = 'playtest:agree';
const TEAL = 0x3fbfb0;   // the game's own teal

const isPlaytestButton = (interaction) => interaction.customId === ID;
const configFor = (guildId) => getGuildConfig(guildId)?.playtest || null;
const channelOf = (cfg) => (cfg.channel ? `<#${cfg.channel}>` : 'the testers\' channel');

/** The posted message: the terms, and the one button. Posted by scripts/post-playtest.js. */
function buildMessage(guildId) {
  const cfg = configFor(guildId);
  if (!cfg) return null;
  const embed = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle(`🔒 ${cfg.game} playtest`)
    .setDescription(
      `${cfg.game} is not out yet, so everything in ${channelOf(cfg)} is confidential.\n\n` +
      'Press **I agree** to confirm you will not share, stream, post or talk about the game, its builds, ' +
      'screenshots, or anything from that channel with anyone outside the test group, and that you will ' +
      'sign the NDA in the game when you first open it. The channel opens to you straight away.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID).setLabel('I agree, let me in').setEmoji('✅').setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row] };
}

async function handleButton(interaction) {
  const cfg = configFor(interaction.guild.id);
  if (!cfg) {
    await interaction.reply({ content: 'That button is not wired to anything any more.', ephemeral: true });
    return;
  }

  const role = interaction.guild.roles.cache.get(cfg.role)
    || await interaction.guild.roles.fetch(cfg.role).catch(() => null);
  if (!role) {
    await interaction.reply({ content: 'The tester role has been deleted. Tell an admin.', ephemeral: true });
    return;
  }

  const me = interaction.guild.members.me;
  if (!me || role.position >= me.roles.highest.position) {
    console.warn(`[Playtest] ${interaction.guild.name}: "${role.name}" sits at or above my highest role.`);
    await interaction.reply({ content: 'I am not allowed to hand that role out. Tell an admin.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  if (member.roles.cache.has(role.id)) {
    await interaction.reply({ content: `You are already in: ${channelOf(cfg)}.`, ephemeral: true });
    return;
  }

  try {
    await member.roles.add(role, 'agreed to the playtest terms');
  } catch (err) {
    console.warn(`[Playtest] ${interaction.guild.name}: could not give "${role.name}": ${err?.message || err}`);
    await interaction.reply({ content: 'That did not work. Tell an admin.', ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `You are in: ${channelOf(cfg)}. Nothing about the game leaves the test group. ` +
      'The game will ask you to sign its NDA the first time you open it.',
    ephemeral: true,
  });

  // The record. After the role, so a failure here never costs anyone their way in.
  if (!cfg.log) return;
  try {
    const log = await interaction.guild.channels.fetch(cfg.log);
    await log.send({
      content: `✅ <@${member.id}> (**${member.user.username}**, ${member.id}) agreed to the playtest terms in Discord, ` +
        `<t:${Math.floor(Date.now() / 1000)}:f>.`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.warn(`[Playtest] ${interaction.guild.name}: could not record ${member.user.username}'s agreement: ${err?.message || err}`);
  }
}

module.exports = { isPlaytestButton, handleButton, buildMessage };
