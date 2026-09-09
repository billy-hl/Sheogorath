const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setupAutoMod, applyBaseline, parseWordList } = require('../services/automod');

const USAGE_HINT =
  'Give the words to block, comma-separated: `/automod words toggle:Enable words:first term, second term`';

/** Render a word list for an (ephemeral, admin-only) reply without blowing Discord's 2000-char cap. */
function listWords(words) {
  const shown = [];
  let length = 0;
  for (const word of words) {
    if (length + word.length + 4 > 900) break;
    shown.push(word);
    length += word.length + 4;
  }
  const rest = words.length - shown.length;
  return `> ${shown.map(w => `\`${w}\``).join(', ')}${rest ? ` … and ${rest} more` : ''}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Manage AutoMod settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('baseline')
        .setDescription('Create or repair the standard rule set (slurs, sexual content, spam, invite alerts)')
        .addBooleanOption(opt =>
          opt.setName('preview')
            .setDescription('Describe the changes without making them')))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('View current AutoMod status'))
    .addSubcommand(sub =>
      sub.setName('words')
        .setDescription('Toggle the blocked words filter and set the words it blocks')
        .addStringOption(opt =>
          opt.setName('toggle')
            .setDescription('Enable or disable')
            .setRequired(true)
            .addChoices(
              { name: 'Enable', value: 'on' },
              { name: 'Disable', value: 'off' }
            ))
        .addStringOption(opt =>
          opt.setName('words')
            .setDescription('Comma-separated words to block. Replaces the list; omit to keep the current one.')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('antispam')
        .setDescription('Toggle mention spam filter')
        .addStringOption(opt =>
          opt.setName('toggle')
            .setDescription('Enable or disable')
            .setRequired(true)
            .addChoices(
              { name: 'Enable', value: 'on' },
              { name: 'Disable', value: 'off' }
            ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'baseline') {
      await interaction.deferReply({ flags: 64 });
      const dryRun = interaction.options.getBoolean('preview') || false;
      try {
        const { results, alertChannel, exemptRoles } = await applyBaseline(interaction.guild, { dryRun });
        const lines = results.map((r) => `\u2022 **${r.name}** — ${r.action}: ${r.detail}`);
        await interaction.editReply(
          `**AutoMod baseline${dryRun ? ' (preview)' : ''}**\n${lines.join('\n')}\n\n` +
          `Alerts: ${alertChannel ? `<#${alertChannel}>` : '_nowhere — set channels.commandLog_'} · ` +
          `Exempt: ${exemptRoles.length ? exemptRoles.map((r) => `<@&${r}>`).join(' ') : '_nobody_'}`
        );
      } catch (err) {
        await interaction.editReply(`Failed: ${err.message}`);
      }
      return;
    }

    if (sub === 'status') {
      await interaction.deferReply({ flags: 64 });
      const rules = await interaction.guild.autoModerationRules.fetch();
      const mine = [...rules.values()].filter((r) => r.name.startsWith('Sheogorath-'));
      const body = mine.length
        ? mine.map((r) => {
            const line = `\u2022 **${r.name}** — ${r.enabled ? '✅ enabled' : '❌ disabled'}, ` +
              `${r.actions.length} action(s), ${r.exemptRoles.size} exempt role(s)`;
            // The keyword list is the one rule whose contents are worth reading
            // back. Every other rule's behaviour is fully described by its name;
            // this one is only as good as the terms somebody typed into it.
            const words = r.triggerMetadata?.keywordFilter || [];
            return words.length ? `${line}\n${listWords(words)}` : line;
          }).join('\n')
        : '_No Sheogorath rules exist yet. Run `/automod baseline`._';
      await interaction.editReply(`**AutoMod Status**\n${body}`);
      return;
    }

    if (sub === 'words') {
      await interaction.deferReply({ flags: 64 });
      const on = interaction.options.getString('toggle') === 'on';
      const raw = interaction.options.getString('words');
      const parsed = raw === null ? null : parseWordList(raw);

      if (on && parsed && parsed.accepted.length === 0) {
        await interaction.editReply(
          `Nothing changed — no usable terms in that list.\n${USAGE_HINT}`
        );
        return;
      }

      try {
        // Only forward a list with something in it, so a junk string alongside
        // `off` can't silently wipe the terms the guild already configured.
        const replace = parsed && parsed.accepted.length > 0;
        const state = await setupAutoMod(interaction.guild, {
          blockWords: on,
          ...(replace ? { customWords: parsed.accepted } : {}),
        });

        if (!on) {
          const stored = (state.blockedWords || []).length;
          await interaction.editReply(
            `Blocked words filter disabled.` +
            (stored ? ` The ${stored} configured term${stored === 1 ? '' : 's'} are kept for when you re-enable it.` : '')
          );
          return;
        }

        // The service refuses to claim a filter it did not build, so an
        // enable with an empty list comes back with blockWords still false.
        if (!state.blockWords) {
          await interaction.editReply(
            `Blocked words filter **not** enabled — this server has no words configured.\n${USAGE_HINT}`
          );
          return;
        }

        const words = state.blockedWords || [];
        await interaction.editReply(
          `Blocked words filter enabled — ${words.length} term${words.length === 1 ? '' : 's'} blocked.\n` +
          `${listWords(words)}` +
          (parsed && parsed.rejected.length
            ? `\nSkipped ${parsed.rejected.length} term${parsed.rejected.length === 1 ? '' : 's'} ` +
              `(longer than 60 characters, or past Discord's 1000-term limit).`
            : '')
        );
      } catch (err) {
        await interaction.editReply(`Failed to update: ${err.message}`);
      }
      return;
    }

    if (sub === 'antispam') {
      await interaction.deferReply({ flags: 64 });
      const on = interaction.options.getString('toggle') === 'on';
      try {
        await setupAutoMod(interaction.guild, { antiSpam: on });
        await interaction.editReply(`Anti-spam filter ${on ? 'enabled' : 'disabled'}.`);
      } catch (err) {
        await interaction.editReply(`Failed to update: ${err.message}`);
      }
      return;
    }
  },
};
