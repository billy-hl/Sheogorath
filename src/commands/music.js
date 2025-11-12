const { SlashCommandBuilder } = require('discord.js');
const { play, connectToChannel, getConnection, players, getQueue, addToQueue, getNextSong, resolveVideoUrl } = require('../music/player');
const { getAIResponse } = require('../ai/grok');

async function playNextInQueue(interaction, connection) {
  const guildId = interaction.guild.id;
  const queue = getQueue(guildId);
  
  if (queue.songs.length === 0) {
    queue.isPlaying = false;
    queue.nowPlaying = null;
    return;
  }
  
  const nextSong = getNextSong(guildId);
  if (!nextSong) return;
  
  try {
    const player = await play(connection, nextSong.query, guildId, async () => {
      try {
        await interaction.followUp(`✅ Finished: **${queue.nowPlaying?.title || 'Song'}**`);
      } catch (e) {
        console.error('Could not send followUp after song finished:', e);
      }
      // Play next song in queue
      await playNextInQueue(interaction, connection);
    });
    players.set(guildId, player);
    
    try {
      await interaction.followUp(`🎵 Now playing: **${queue.nowPlaying?.title || nextSong.query}**`);
    } catch (e) {
      console.error('Could not send now playing message:', e);
    }
  } catch (err) {
    console.error('Error playing next song in queue:', err);
    await playNextInQueue(interaction, connection);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube song by URL or search phrase')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('YouTube URL or search phrase (e.g. "lofi hip hop beats")')
        .setRequired(true)),
  async execute(interaction) {
    const query = interaction.options.getString('query');
    try {
      await interaction.deferReply();
    } catch (err) {
      console.error('ERROR: deferReply failed:', err);
      return;
    }
    if (!query || typeof query !== 'string' || query.trim() === '') {
      try {
        await interaction.editReply('❌ Please provide a valid YouTube URL or search phrase.');
      } catch (err) {
        console.error('ERROR: editReply failed (invalid query):', err);
      }
      return;
    }
    const member = interaction.member;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      try {
        await interaction.editReply('❌ Join a voice channel first!');
      } catch (err) {
        console.error('ERROR: editReply failed (no voice channel):', err);
      }
      return;
    }
    let connection = getConnection(interaction.guild);
    if (!connection) connection = connectToChannel(voiceChannel);
    
    const ytdl = require('@distube/ytdl-core');
    const isUrl = ytdl.validateURL(query);
    const guildId = interaction.guild.id;
    const queue = getQueue(guildId);
    
    try {
      if (isUrl) {
        await interaction.editReply(`🎵 Loading: ${query}`);
      } else {
        await interaction.editReply(`🔍 Searching YouTube for: **${query}**`);
      }
      
      // If something is already playing, add to queue
      if (queue.isPlaying) {
        const position = addToQueue(guildId, { query, addedBy: interaction.user.tag });
        
        // Resolve video info for better queue display
        try {
          const { title } = await resolveVideoUrl(query);
          await interaction.editReply(`➕ Added to queue (position ${position}): **${title}**`);
        } catch (err) {
          await interaction.editReply(`➕ Added to queue (position ${position}): **${query}**`);
        }
        return;
      }
      
      // Nothing playing, start playing immediately
      queue.isPlaying = true;
      const player = await play(connection, query, guildId, async () => {
        try {
          await interaction.followUp(`✅ Finished: **${queue.nowPlaying?.title || 'Song'}**`);
        } catch (e) {
          console.error('Could not send followUp after song finished:', e);
        }
        // Play next song in queue
        await playNextInQueue(interaction, connection);
      });
      players.set(guildId, player);
      
      // Update with success message
      const nowPlaying = queue.nowPlaying?.title || query;
      if (!isUrl) {
        await interaction.editReply(`🎵 Now playing first result for: **${query}**\nTitle: **${nowPlaying}**`);
      } else {
        await interaction.editReply(`🎵 Now playing: **${nowPlaying}**`);
      }
      
      // Add AI commentary about the music
      try {
        const aiPrompt = `Comment on someone playing "${nowPlaying}" in your typical chaotic, sarcastic style. Make it entertaining and related to music or the song if possible. Keep it brief.`;
        const aiComment = await getAIResponse(aiPrompt);
        
        await interaction.followUp(`🎭 *${aiComment}*`);
      } catch (aiError) {
        console.error('AI music comment failed:', aiError);
      }
    } catch (err) {
      console.error('Error playing music:', err);
      try {
        if (isUrl) {
          await interaction.editReply('❌ Failed to play the requested audio. Please check the URL and try again.');
        } else {
          await interaction.editReply(`❌ Failed to find or play results for: **${query}**. Try a different search phrase.`);
        }
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
