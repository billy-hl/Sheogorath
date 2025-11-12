const { SlashCommandBuilder } = require('discord.js');
const { clearQueue, getQueue, stopPlaying } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear all songs from the queue (keeps current song playing)'),
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
        await interaction.editReply('❌ You need to be in a voice channel to manage the queue!');
      } catch (err) {
        console.error('ERROR: editReply failed:', err);
      }
      return;
    }

    try {
      const queue = getQueue(interaction.guild.id);
      const queueLength = queue.songs.length;
      
      if (queueLength === 0) {
        await interaction.editReply('❌ The queue is already empty.');
        return;
      }
      
      // Clear only the queue, not the currently playing song
      queue.songs = [];
      
      await interaction.editReply(`✅ Cleared ${queueLength} song(s) from the queue.\nCurrent song will continue playing.`);
    } catch (err) {
      console.error('Error clearing queue:', err);
      try {
        await interaction.editReply('❌ Failed to clear the queue.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
