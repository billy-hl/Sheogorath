const { SlashCommandBuilder } = require('discord.js');
const { resumePlaying } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused song'),
  async execute(interaction) {
    try {
      await interaction.deferReply();
    } catch (err) {
      console.error('ERROR: deferReply failed:', err);
      return;
    }

    const member = interaction.member;
    const voiceChannel = member.voice.channel;
    
    if (!voiceChannel) {
      try {
        await interaction.editReply('❌ You need to be in a voice channel to resume music!');
      } catch (err) {
        console.error('ERROR: editReply failed:', err);
      }
      return;
    }

    try {
      const success = resumePlaying(interaction.guild.id);
      if (success) {
        await interaction.editReply('▶️ Resumed playback.');
      } else {
        await interaction.editReply('❌ No music is currently paused.');
      }
    } catch (err) {
      console.error('Error resuming music:', err);
      try {
        await interaction.editReply('❌ Failed to resume the music.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
