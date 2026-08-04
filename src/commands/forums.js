'use strict';
/**
 * Stand up and inspect the request forums.
 *
 * Deliberately absent from COMMAND_FEATURES in utils/permissions.js: gating it
 * on the `forums` feature would make it unregisterable in exactly the guild
 * that needs it, since enabling that feature is what this command does. It is
 * Administrator-only instead.
 *
 * `apply` creates channels in a live guild and locks the old one read-only, so
 * it will not act without an explicit confirm — running it bare prints the
 * plan and stops.
 */
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { plan, apply, missingPermissions, configuredId } = require('../services/forums/setup');
const { FORUMS } = require('../services/forums/spec');
const { getGuildConfig } = require('../config/guilds');
const { isAdmin } = require('../utils/permissions');

function renderPlan(result) {
  const lines = ['**Forum setup plan**', ''];
  for (const step of result.steps) {
    const icon = { create: '🆕', replace: '♻️', reconcile: '🔧', ok: '✅' }[step.action];
    lines.push(`${icon} **${step.spec.name}** — ${step.detail}`);
  }
  if (result.blocked.length) {
    lines.push('', '**Blocked**');
    for (const b of result.blocked) lines.push(`- ${b}`);
  } else {
    lines.push('', 'Run `/forums apply confirm:True` to make these changes.');
  }
  return lines.join('\n').slice(0, 1900);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('forums')
    .setDescription('Manage the suggestion and mod-request forums')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('preview')
        .setDescription('Show what setup would create or change, without touching anything'))
    .addSubcommand(sub =>
      sub.setName('apply')
        .setDescription('Create or repair the forum channels and their tags')
        .addBooleanOption(opt =>
          opt.setName('confirm')
            .setDescription('Required — this creates channels and locks the old one read-only')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show how the forums are currently wired')),

  async execute(interaction) {
    if (!isAdmin(interaction.member)) {
      await interaction.reply({ content: 'Admins only, mortal.', flags: 64 });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const config = getGuildConfig(guild.id);

    if (!config) {
      await interaction.reply({
        content: 'This guild is not in config/guilds.json, so there is nothing to configure.',
        flags: 64,
      });
      return;
    }

    if (sub === 'preview') {
      await interaction.deferReply({ flags: 64 });
      await interaction.editReply(renderPlan(plan(guild, config)));
      return;
    }

    if (sub === 'apply') {
      const confirmed = interaction.options.getBoolean('confirm');
      await interaction.deferReply({ flags: 64 });

      if (!confirmed) {
        await interaction.editReply(
          `${renderPlan(plan(guild, config))}\n\nNothing was changed — \`confirm\` was False.`
        );
        return;
      }

      try {
        const { results, warnings } = await apply(guild, config);
        const lines = ['**Forum setup applied**', '', ...results.map((r) => `- ${r}`)];
        if (warnings.length) lines.push('', '**Warnings**', ...warnings.map((w) => `- ${w}`));
        lines.push('', 'Restart the bot (or re-run `/forums status`) to confirm the new wiring.');
        await interaction.editReply(lines.join('\n').slice(0, 1900));
      } catch (err) {
        await interaction.editReply(`Setup failed: ${err.message}`);
      }
      return;
    }

    if (sub === 'status') {
      await interaction.deferReply({ flags: 64 });
      const lines = ['**Forum status**', ''];

      lines.push(`Feature \`forums\`: ${config.features.includes('forums') ? '✅ enabled' : '❌ disabled'}`);
      const missing = missingPermissions(guild);
      lines.push(`Permissions: ${missing.length ? `❌ missing ${missing.join(', ')}` : '✅ all present'}`);
      lines.push('');

      for (const spec of FORUMS) {
        const id = configuredId(config, spec);
        const channel = id ? guild.channels.cache.get(id) : null;

        if (!channel) {
          lines.push(`❌ **${spec.name}** — ${id ? `configured as \`${id}\` but not found` : 'not configured'}`);
          continue;
        }
        if (channel.type !== ChannelType.GuildForum) {
          lines.push(`⚠️ **${spec.name}** — <#${channel.id}> is a text channel, not a forum. Run \`/forums apply\`.`);
          continue;
        }
        const have = new Set((channel.availableTags || []).map((t) => t.name));
        const gaps = spec.tags.filter((t) => !have.has(t.name));
        lines.push(
          `✅ **${spec.name}** — <#${channel.id}>, ${channel.availableTags.length} tag(s)` +
          (gaps.length ? ` — ⚠️ missing: ${gaps.map((g) => g.name).join(', ')}` : '')
        );
      }

      await interaction.editReply(lines.join('\n').slice(0, 1900));
    }
  },
};
