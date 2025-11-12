const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getQueue } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show what\'s currently playing'),
  async execute(interaction) {
    try {
      await interaction.deferReply();
    } catch (err) {
      console.error('ERROR: deferReply failed:', err);
      return;
    }

    try {
      const queue = getQueue(interaction.guild.id);
      
      if (!queue.nowPlaying) {
        await interaction.editReply('❌ Nothing is currently playing. Use `/play` to start!');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🎵 Now Playing')
        .setDescription(`**${queue.nowPlaying.title}**`)
        .setColor(0x00ff00)
        .setTimestamp();

      if (queue.nowPlaying.url) {
        embed.setURL(queue.nowPlaying.url);
      }

      if (queue.songs.length > 0) {
        embed.addFields({
          name: '📋 Up Next',
          value: `${queue.songs.length} song(s) in queue`,
          inline: true
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('Error displaying now playing:', err);
      try {
        await interaction.editReply('❌ Failed to display now playing information.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
