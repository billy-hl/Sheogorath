const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getQueue } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('View the current music queue'),
  async execute(interaction) {
    try {
      await interaction.deferReply();
    } catch (err) {
      console.error('ERROR: deferReply failed:', err);
      return;
    }

    try {
      const queue = getQueue(interaction.guild.id);
      
      const embed = new EmbedBuilder()
        .setTitle('🎵 Music Queue')
        .setColor(0x00ff00)
        .setTimestamp();

      if (!queue.nowPlaying && queue.songs.length === 0) {
        embed.setDescription('The queue is empty. Use `/play` to add songs!');
      } else {
        let description = '';
        
        if (queue.nowPlaying) {
          description += `**🎵 Now Playing:**\n${queue.nowPlaying.title}\n\n`;
        }
        
        if (queue.songs.length > 0) {
          description += '**📋 Up Next:**\n';
          queue.songs.slice(0, 10).forEach((song, index) => {
            const title = song.query.length > 50 ? song.query.substring(0, 47) + '...' : song.query;
            description += `${index + 1}. ${title}\n`;
          });
          
          if (queue.songs.length > 10) {
            description += `\n*...and ${queue.songs.length - 10} more songs*`;
          }
          
          embed.setFooter({ text: `Total songs in queue: ${queue.songs.length}` });
        } else {
          description += '\n*No songs in queue*';
        }
        
        embed.setDescription(description);
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('Error displaying queue:', err);
      try {
        await interaction.editReply('❌ Failed to display the queue.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
