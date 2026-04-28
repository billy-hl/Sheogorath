const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setupAutoMod, getAutoModStatus } = require('../services/automod');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Manage AutoMod settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

    if (sub === 'status') {
      await interaction.deferReply({ flags: 64 });
      const status = await getAutoModStatus(interaction.guild);
      await interaction.editReply(
        `**AutoMod Status**\n` +
        `Blocked Words: ${status.blockWords ? '✅ Enabled' : '❌ Disabled'}\n` +
        `Anti-Spam: ${status.antiSpam ? '✅ Enabled' : '❌ Disabled'}`
      );
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
