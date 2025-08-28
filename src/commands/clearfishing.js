const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearfishing')
    .setDescription('⚠️ ADMIN ONLY: Clear all fishing game data (irreversible)')
    .addStringOption(option =>
      option.setName('confirm')
        .setDescription('Type "CONFIRM" to proceed with clearing all data')
        .setRequired(true)),

  async execute(interaction) {
    // Check if user is an administrator
    const isAdmin = interaction.member.permissions.has('Administrator') || 
                   interaction.user.id === process.env.ADMIN_USER_ID;
    
    if (!isAdmin) {
      return await interaction.reply({
        content: '❌ This command is restricted to administrators only.',
        flags: 64
      });
    }

    const confirmation = interaction.options.getString('confirm');

    if (confirmation !== 'CONFIRM') {
      return await interaction.reply({
        content: '❌ You must type "CONFIRM" exactly to proceed with clearing all fishing data.',
        flags: 64
      });
    }

    await interaction.deferReply();

    try {
      const success = fishingGame.clearAllData();

      if (success) {
        const embed = new EmbedBuilder()
          .setTitle('🗑️ Fishing Data Cleared')
          .setDescription('✅ **All fishing game data has been successfully cleared and reset to defaults.**\n\n**What was reset:**\n• All player data (levels, coins, inventory, stats)\n• Shop and market data\n• Challenge and achievement progress\n• Tournament data\n• Weather settings\n\n**Note:** This action cannot be undone. All players will need to start fresh.')
          .setColor(0xff6b6b)
          .setFooter({
            text: `Cleared by ${interaction.user.username}`,
            iconURL: interaction.user.displayAvatarURL({ dynamic: true })
          })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply('❌ Failed to clear fishing data. Please check the console for errors.');
      }

    } catch (error) {
      console.error('Clear fishing data error:', error);
      await interaction.editReply('❌ An error occurred while clearing the fishing data.');
    }
  }
};
