const { SlashCommandBuilder } = require('discord.js');
const { skipSong, getQueue } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),
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
        await interaction.editReply('❌ You need to be in a voice channel to skip songs!');
      } catch (err) {
        console.error('ERROR: editReply failed:', err);
      }
      return;
    }

    try {
      const queue = getQueue(interaction.guild.id);
      const currentSong = queue.nowPlaying?.title || 'current song';
      
      const success = skipSong(interaction.guild.id);
      if (success) {
        if (queue.songs.length > 0) {
          await interaction.editReply(`⏭️ Skipped: **${currentSong}**\nPlaying next song...`);
        } else {
          await interaction.editReply(`⏭️ Skipped: **${currentSong}**\nNo more songs in queue.`);
        }
      } else {
        await interaction.editReply('❌ No music is currently playing.');
      }
    } catch (err) {
      console.error('Error skipping song:', err);
      try {
        await interaction.editReply('❌ Failed to skip the song.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
