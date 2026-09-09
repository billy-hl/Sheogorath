const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setupAutoMod, getAutoModStatus, applyBaseline } = require('../services/automod');

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
        .setDescription('Toggle blocked words filter')
        .addStringOption(opt =>
          opt.setName('toggle')
            .setDescription('Enable or disable')
            .setRequired(true)
            .addChoices(
              { name: 'Enable', value: 'on' },
              { name: 'Disable', value: 'off' }
            )))
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
        ? mine.map((r) => `\u2022 **${r.name}** — ${r.enabled ? '✅ enabled' : '❌ disabled'}, ` +
            `${r.actions.length} action(s), ${r.exemptRoles.size} exempt role(s)`).join('\n')
        : '_No Sheogorath rules exist yet. Run `/automod baseline`._';
      await interaction.editReply(`**AutoMod Status**\n${body}`);
      return;
    }

    if (sub === 'words') {
      await interaction.deferReply({ flags: 64 });
      const on = interaction.options.getString('toggle') === 'on';
      try {
        await setupAutoMod(interaction.guild, { blockWords: on });
        await interaction.editReply(`Blocked words filter ${on ? 'enabled' : 'disabled'}.`);
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
