'use strict';
/**
 * The control surface for Sheogorath's own authority.
 *
 * The gate in ai/capabilities.js is deliberately dumb — a table and a few
 * rules, with no way to talk it round. This is how a human changes its mind:
 * how much rope he has, and what he has been doing with it. Owners only, and
 * mirrored to the staff log like everything else privileged, because "who moved
 * him to enforce" is exactly the question that gets asked afterwards.
 */
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const {
  MODES,
  DEFAULT_MODE,
  BREAKER_LIMIT,
  CAPABILITIES,
  modeFor,
  isBreakerTripped,
  resetBreaker,
  recentExecutions,
} = require('../ai/capabilities');
const { pendingCount } = require('../ai/approvals');
const { status: budgetStatus } = require('../ai/budget');
const { ensureParlour, PARLOUR_NAME } = require('../services/parlour');
const { getGuildConfig, updateGuildConfig } = require('../config/guilds');
const { staffChannelId, LOG_FILE } = require('../utils/aiAudit');
const { isAdmin } = require('../utils/permissions');

const MODE_BLURB = {
  shadow: 'Watching only. He records what he would have done and does none of it.',
  assist: 'Everything he wants to do comes to the staff channel for approval first.',
  enforce: 'He handles warnings, deletions and short timeouts himself. Kicks, bans and server commands still ask.',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sheo')
    .setDescription("Manage what Sheogorath is allowed to do on his own")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('What he is allowed to do, and what he has done this hour'))
    .addSubcommand(sub =>
      sub.setName('mode')
        .setDescription('Change how much he may do without asking')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('shadow watches, assist asks first, enforce lets him act')
            .setRequired(true)
            .addChoices(
              { name: 'shadow — watch only, act on nothing', value: 'shadow' },
              { name: 'assist — ask a Sheriff about everything', value: 'assist' },
              { name: 'enforce — act within his limits, ask about the rest', value: 'enforce' },
            )))
    .addSubcommand(sub =>
      sub.setName('unleash')
        .setDescription('Clear the hourly action brake early'))
    .addSubcommand(sub =>
      sub.setName('parlour')
        .setDescription(`Create #${PARLOUR_NAME}, where Sheogorath talks properly`)),

  async execute(interaction) {
    // Belt and braces over setDefaultMemberPermissions: that only hides the
    // command, and a guild that has overridden the permission in its own
    // settings would otherwise hand this to anyone it was shown to.
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: '❌ Only Owners can change what Sheogorath may do.', flags: 64 });
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'status') {
      const config = getGuildConfig(guildId);
      const mode = modeFor(config);
      const recent = recentExecutions(guildId);
      const byType = recent.reduce((acc, e) => ({ ...acc, [e.capability]: (acc[e.capability] || 0) + 1 }), {});
      const staffChannel = staffChannelId(guildId);

      const auto = Object.entries(CAPABILITIES).filter(([, c]) => c.tier === 'auto').map(([n]) => n);
      const ask = Object.entries(CAPABILITIES).filter(([, c]) => c.tier === 'propose').map(([n]) => n);

      const embed = new EmbedBuilder()
        .setTitle('Sheogorath — leash status')
        .setColor(mode === 'enforce' ? 0xd4af37 : mode === 'assist' ? 0x5865f2 : 0x747f8d)
        .addFields(
          { name: 'Mode', value: `**${mode}**${config?.ai?.mode ? '' : ` (unset, defaulting to ${DEFAULT_MODE})`}\n${MODE_BLURB[mode]}` },
          { name: 'Does himself', value: auto.join(', ') || 'nothing', inline: true },
          { name: 'Always asks', value: ask.join(', ') || 'nothing', inline: true },
          {
            name: 'Last hour',
            value: recent.length
              ? `${recent.length} action(s) — ${Object.entries(byType).map(([k, v]) => `${k} ×${v}`).join(', ')}`
              : 'nothing',
          },
          {
            name: 'Brake',
            value: isBreakerTripped(guildId)
              ? `🛑 **tripped** — everything is going to approval. \`/sheo unleash\` clears it.`
              : `running (trips past ${BREAKER_LIMIT} actions/hour)`,
          },
          { name: 'Awaiting a Sheriff', value: `${pendingCount(guildId)} card(s)`, inline: true },
          (() => {
            // Spend is one ceiling across every guild on this API key, so it is
            // reported the same in all of them rather than being split.
            const b = budgetStatus();
            const bar = '█'.repeat(Math.min(10, Math.round(b.percent / 10))).padEnd(10, '░');
            return {
              name: `Spend — ${b.month}`,
              value: `\`${bar}\` **$${b.spentUsd.toFixed(2)}** of $${b.limitUsd.toFixed(2)} (${b.percent.toFixed(1)}%)\n` +
                `${b.calls} call(s) this month, ${b.today.calls} today ($${b.today.spentUsd.toFixed(2)})` +
                (b.exceeded ? '\n🛑 **Spent out** — he is not answering until the month turns.' : ''),
            };
          })(),
          { name: 'Staff channel', value: staffChannel ? `<#${staffChannel}>` : '⚠️ none set — he cannot ask for anything', inline: true },
        )
        .setFooter({ text: `Full trail: logs/${require('path').basename(LOG_FILE)}` });

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    if (sub === 'mode') {
      const mode = interaction.options.getString('mode');
      if (!MODES.includes(mode)) {
        return interaction.reply({ content: `❌ Mode must be one of: ${MODES.join(', ')}.`, flags: 64 });
      }

      const previous = modeFor(getGuildConfig(guildId));
      try {
        // Persisted rather than held in memory: a restart must not quietly
        // hand him back powers someone deliberately took away.
        updateGuildConfig(guildId, { ai: { mode } });
      } catch (err) {
        return interaction.reply({ content: `❌ Could not save the change: ${err.message}`, flags: 64 });
      }

      return interaction.reply({
        content: `🔑 Sheogorath moved from **${previous}** to **${mode}**.\n> ${MODE_BLURB[mode]}`,
        flags: 64,
      });
    }

    if (sub === 'parlour') {
      await interaction.deferReply({ flags: 64 });
      try {
        const { channel, created, warnings } = await ensureParlour(interaction.guild, {
          reason: `Requested by ${interaction.user.tag}`,
        });
        const lines = [
          created
            ? `🎭 Made <#${channel.id}>. He answers everything said there without being called by name.`
            : `🎭 <#${channel.id}> is already the parlour — nothing to change.`,
          '> There he keeps 20 messages of conversation instead of 5, gets a 1200-token ceiling instead of 500, and the persona\'s "1-2 sentences" rule is lifted. Everything else — the permission gate, the facts, the budget — is unchanged.',
          '> It draws on the same monthly ceiling as the rest of him. Watch `/sheo status` for a few days.',
          ...warnings.map(w => `⚠️ ${w}`),
        ];
        return interaction.editReply(lines.join('\n'));
      } catch (err) {
        return interaction.editReply(`❌ Could not make the parlour: ${err.message}`);
      }
    }

    if (sub === 'unleash') {
      if (!isBreakerTripped(guildId)) {
        return interaction.reply({ content: 'The brake is not on. He is already free to act within his limits.', flags: 64 });
      }
      resetBreaker(guildId);
      return interaction.reply({ content: '🔓 Brake cleared. His hourly count starts again from zero.', flags: 64 });
    }
  },
};
