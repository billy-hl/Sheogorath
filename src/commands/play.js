const { SlashCommandBuilder } = require('discord.js');
const { play, connectToChannel, getConnection, players, getQueue, addToQueue, getNextSong, resolveVideoUrl, fetchRelatedSong, expandPlaylist } = require('../music/player');

const MUSIC_CHANNEL_ID = '534553333034123289';

// Use channel.send() instead of interaction.followUp() to avoid 15-min token expiry
async function playNextInQueue(client, connection, guildId) {
  const channel = await client.channels.fetch(MUSIC_CHANNEL_ID).catch(() => null);
  const queue = getQueue(guildId);
  
  if (queue.songs.length === 0) {
    // Try autoplay if enabled
    if (queue.autoplay && queue.lastVideoId) {
      try {
        const related = await fetchRelatedSong(guildId);
        if (related) {
          console.log(`Autoplay: Queuing related song: ${related.title}`);
          addToQueue(guildId, related);
          if (channel) try {
            await channel.send(`🔄 **Autoplay:** Queuing **${related.title}**`);
          } catch (e) {
            console.error('Could not send autoplay message:', e);
          }
        } else {
          queue.isPlaying = false;
          queue.nowPlaying = null;
          return;
        }
      } catch (err) {
        console.error('Autoplay error:', err);
        queue.isPlaying = false;
        queue.nowPlaying = null;
        return;
      }
    } else {
      queue.isPlaying = false;
      queue.nowPlaying = null;
      return;
    }
  }
  
  const nextSong = getNextSong(guildId);
  if (!nextSong) return;
  
  try {
    const player = await play(connection, nextSong.query, guildId, async () => {
      await playNextInQueue(client, connection, guildId);
    });
    players.set(guildId, player);
    
    if (channel) try {
      await channel.send(`🎵 Now playing: **${queue.nowPlaying?.title || nextSong.query}**`);
    } catch (e) {
      console.error('Could not send now playing message:', e);
    }
  } catch (err) {
    console.error('Error playing next song in queue:', err);
    await playNextInQueue(client, connection, guildId);
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
      await interaction.deferReply({ flags: 64 });
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
    
    // Check if the URL contains a playlist (list= parameter)
    const isPlaylistUrl = /^https?:\/\/.*(youtube\.com|youtu\.be).*list=/.test(query);
    const isPurePlaylist = /^https?:\/\/.*(youtube\.com)\/playlist\?list=/.test(query);
    
    if (isPlaylistUrl) {
      try {
        await interaction.editReply('📋 Loading playlist...');
        
        const playlist = await expandPlaylist(query);
        if (!playlist || playlist.songs.length === 0) {
          await interaction.editReply('❌ Could not load the playlist or it\'s empty.');
          return;
        }
        
        let startIndex = 0;
        
        // If it's a watch URL with list= (not a pure playlist URL), 
        // find the specific video and start from there
        if (!isPurePlaylist) {
          const videoIdMatch = query.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
          if (videoIdMatch) {
            const videoId = videoIdMatch[1];
            const foundIndex = playlist.songs.findIndex(s => s.id === videoId);
            if (foundIndex >= 0) startIndex = foundIndex;
          }
        }
        
        const songsToAdd = playlist.songs.slice(startIndex);
        
        // Add all songs to queue
        for (const song of songsToAdd) {
          addToQueue(guildId, { query: song.query, title: song.title, addedBy: interaction.user.tag });
        }
        
        const cappedMsg = playlist.totalCount > 100 ? ` (capped at 100 of ${playlist.totalCount})` : '';
        await interaction.editReply(`📋 Added **${songsToAdd.length}** songs from **${playlist.title}**${cappedMsg}`);
        
        // Start playing if nothing is playing
        if (!queue.isPlaying) {
          queue.isPlaying = true;
          const firstSong = queue.songs.shift();
          if (firstSong) {
            const musicChannel = await interaction.client.channels.fetch(MUSIC_CHANNEL_ID).catch(() => null);
            const player = await play(connection, firstSong.query, guildId, async () => {
              await playNextInQueue(interaction.client, connection, guildId);
            });
            players.set(guildId, player);
            
            if (musicChannel) try {
              await musicChannel.send(`🎵 Now playing: **${queue.nowPlaying?.title || firstSong.title || firstSong.query}**`);
            } catch (e) {
              console.error('Could not send now playing message:', e);
            }
          }
        }
        
        return;
      } catch (err) {
        console.error('Playlist loading error:', err);
        await interaction.editReply('❌ Failed to load the playlist. Trying as a single video...');
        // Fall through to normal single-video handling
      }
    }
    
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
        await playNextInQueue(interaction.client, connection, guildId);
      });
      players.set(guildId, player);
      
      // Update with success message
      const nowPlaying = queue.nowPlaying?.title || query;
      if (!isUrl) {
        await interaction.editReply(`🎵 Now playing first result for: **${query}**\nTitle: **${nowPlaying}**`);
      } else {
        await interaction.editReply(`🎵 Now playing: **${nowPlaying}**`);
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
