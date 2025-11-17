const { SlashCommandBuilder } = require('discord.js');
const wakeWordDetector = require('../services/wake-word');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leavevoice')
    .setDescription('Bot leaves voice channel and stops listening'),

  async execute(interaction) {
    try {
      // Check if user is in a voice channel
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({
          content: '❌ You need to be in a voice channel!',
          flags: 64
        });
      }

      // Check if bot is listening in this channel
      if (!wakeWordDetector.isListening(voiceChannel.id)) {
        return interaction.reply({
          content: '❌ I\'m not in your voice channel!',
          flags: 64
        });
      }

      // Stop listening
      wakeWordDetector.stopListening(voiceChannel.id);

      await interaction.reply({
        content: '👋 Left voice channel',
        flags: 64
      });

    } catch (err) {
      console.error('Leave voice error:', err);
      await interaction.reply({
        content: `❌ Error: ${err.message}`,
        flags: 64
      });
    }
  }
};
