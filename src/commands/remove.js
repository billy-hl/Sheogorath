const { SlashCommandBuilder } = require('discord.js');
const { removeFromQueue, getQueue } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a song from the queue')
    .addIntegerOption(option =>
      option.setName('position')
        .setDescription('Position of the song in the queue (1 = first in queue)')
        .setRequired(true)
        .setMinValue(1)),
  async execute(interaction) {
    try {
      await interaction.deferReply();
    } catch (err) {
      console.error('ERROR: deferReply failed:', err);
      return;
    }

    const position = interaction.options.getInteger('position');
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
      
      if (queue.songs.length === 0) {
        await interaction.editReply('❌ The queue is empty.');
        return;
      }
      
      if (position > queue.songs.length) {
        await interaction.editReply(`❌ Invalid position. The queue only has ${queue.songs.length} song(s).`);
        return;
      }
      
      const removed = removeFromQueue(interaction.guild.id, position - 1);
      
      if (removed) {
        await interaction.editReply(`✅ Removed from queue: **${removed.query}**`);
      } else {
        await interaction.editReply('❌ Failed to remove the song from the queue.');
      }
    } catch (err) {
      console.error('Error removing from queue:', err);
      try {
        await interaction.editReply('❌ Failed to remove the song from the queue.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
