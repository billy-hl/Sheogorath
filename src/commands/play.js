const { SlashCommandBuilder } = require('discord.js');
const {
  connectToChannel,
  getConnection,
  getQueue,
  addToQueue,
  getNextSong,
  beginPlayback,
  endPlayback,
  emitState,
  resolveVideoUrl,
  expandPlaylist,
} = require('../music/player');
const { playNextInQueue, startPlayback } = require('../music/session');

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
        
        // Start playing if nothing is playing. beginPlayback covers the gap
        // between one track ending and the next becoming audible, which a bare
        // isPlaying check does not.
        if (beginPlayback(guildId)) {
          const firstSong = getNextSong(guildId);
          if (firstSong) {
            await startPlayback(interaction.client, connection, guildId, {
              ...firstSong,
              addedBy: firstSong.addedBy || interaction.user.tag,
            });
          } else {
            endPlayback(guildId);
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
      
      // Queue first, resolve second, and mutate the entry in place: entries
      // keep the order the commands arrived in, and the resolved video sticks
      // to the entry rather than being thrown away with the reply text.
      const entry = { query, addedBy: interaction.user.tag };
      addToQueue(guildId, entry);

      let title = query;
      try {
        const resolved = await resolveVideoUrl(query);
        title = resolved.title;
        // Pin the exact video we're about to name. Leaving the raw search
        // phrase here meant playback re-ran ytsearch1 minutes later and could
        // land on a different video than the one announced.
        entry.query = resolved.url;
        entry.title = resolved.title;
        emitState(guildId);
      } catch (err) {
        console.error('Could not resolve queued track:', err?.message || err);
      }

      // Something is already playing, or is mid-start: leave it queued.
      if (!beginPlayback(guildId)) {
        const position = queue.songs.indexOf(entry) + 1;
        await interaction.editReply(`➕ Added to queue (position ${position}): **${title}**`);
        return;
      }

      // Nothing playing — start from the head of the queue, not from this
      // request. If earlier songs were sitting there unplayed they go first.
      const first = getNextSong(guildId);
      if (!first) {
        endPlayback(guildId);
        await interaction.editReply('❌ Nothing in the queue to play.');
        return;
      }

      await startPlayback(interaction.client, connection, guildId, first);

      const startedTitle = queue.nowPlaying?.title || first.title || first.query;
      if (first === entry) {
        if (!isUrl) {
          await interaction.editReply(`🎵 Now playing first result for: **${query}**\nTitle: **${startedTitle}**`);
        } else {
          await interaction.editReply(`🎵 Now playing: **${startedTitle}**`);
        }
      } else {
        const position = queue.songs.indexOf(entry) + 1;
        await interaction.editReply(
          `▶️ Restarted the queue with **${startedTitle}**.\n➕ **${title}** is queued at position ${position}.`
        );
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
