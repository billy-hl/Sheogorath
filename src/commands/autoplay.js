const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Toggle autoplay - automatically play similar songs when the queue is empty'),
  async execute(interaction) {
    try {
      await interaction.deferReply({ flags: 64 });
    } catch (err) {
      console.error('ERROR: deferReply failed:', err);
      return;
    }

    try {
      const queue = getQueue(interaction.guild.id);
      queue.autoplay = !queue.autoplay;

      if (queue.autoplay) {
        await interaction.editReply('🔄 **Autoplay enabled!** I\'ll play similar songs when the queue runs out.');
      } else {
        await interaction.editReply('⏹️ **Autoplay disabled.** Playback will stop when the queue is empty.');
      }
    } catch (err) {
      console.error('Error toggling autoplay:', err);
      try {
        await interaction.editReply('❌ Failed to toggle autoplay.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
