const { SlashCommandBuilder } = require('discord.js');
const { pausePlaying } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current song'),
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
        await interaction.editReply('❌ You need to be in a voice channel to pause music!');
      } catch (err) {
        console.error('ERROR: editReply failed:', err);
      }
      return;
    }

    try {
      const success = pausePlaying(interaction.guild.id);
      if (success) {
        await interaction.editReply('⏸️ Paused the current song.');
      } else {
        await interaction.editReply('❌ No music is currently playing.');
      }
    } catch (err) {
      console.error('Error pausing music:', err);
      try {
        await interaction.editReply('❌ Failed to pause the music.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
