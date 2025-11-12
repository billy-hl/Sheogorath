const { SlashCommandBuilder } = require('discord.js');
const { stopPlaying } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop music playback and clear the queue'),
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
        await interaction.editReply('❌ You need to be in a voice channel to stop music!');
      } catch (err) {
        console.error('ERROR: editReply failed:', err);
      }
      return;
    }

    try {
      stopPlaying(interaction.guild.id);
      await interaction.editReply('⏹️ Stopped playback and cleared the queue.');
    } catch (err) {
      console.error('Error stopping music:', err);
      try {
        await interaction.editReply('❌ Failed to stop the music.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
