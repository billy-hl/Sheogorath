const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytdlexec = require('youtube-dl-exec');

const players = new Map();
const queues = new Map();

// Queue management functions
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      songs: [],
      nowPlaying: null,
      isPlaying: false,
      autoplay: true,
      lastVideoId: null,
      playedHistory: new Set()
    });
  }
  return queues.get(guildId);
}

function addToQueue(guildId, song) {
  const queue = getQueue(guildId);
  queue.songs.push(song);
  return queue.songs.length;
}

function clearQueue(guildId) {
  const queue = getQueue(guildId);
  queue.songs = [];
  queue.nowPlaying = null;
  queue.isPlaying = false;
  queue.lastVideoId = null;
  queue.playedHistory = new Set();
}

function removeFromQueue(guildId, index) {
  const queue = getQueue(guildId);
  if (index >= 0 && index < queue.songs.length) {
    return queue.songs.splice(index, 1)[0];
  }
  return null;
}

function getNextSong(guildId) {
  const queue = getQueue(guildId);
  return queue.songs.shift();
}

async function resolveVideoUrl(url) {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('No URL or search term provided.');
  }
  
  // If valid video URL, use directly; else search via yt-dlp
  let videoUrl = url;
  let title = url;
  
  if (!ytdl.validateURL(url)) {
    try {
      const raw = await ytdlexec(`ytsearch1:${url}`, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        addHeader: [
          'referer:youtube.com',
          'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ],
      });
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const entry = data?.entries?.[0] || data;
      const id = entry?.id;
      title = entry?.title || url;
      const webpageUrl = entry?.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : null);
      if (!webpageUrl) throw new Error('No results found for your search.');
      videoUrl = webpageUrl;
    } catch (err) {
      console.error('Error searching YouTube via yt-dlp:', err?.stderr || err?.message || err);
      throw new Error('Failed to search YouTube for your query.');
    }
  } else {
    // Try to get title for URL
    try {
      const raw = await ytdlexec(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
      });
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      title = data?.title || url;
    } catch (err) {
      console.log('Could not fetch title for URL:', err.message);
    }
  }
  
  console.log('DEBUG: resolveVideoUrl() using videoUrl:', videoUrl);
  return { url: videoUrl, title };
}

async function play(connection, url, guildId, onFinish) {
  const { url: videoUrl, title } = await resolveVideoUrl(url);
  const queue = getQueue(guildId);
  queue.nowPlaying = { url: videoUrl, title };
  queue.isPlaying = true;
  
  // Track video ID for autoplay related songs
  const videoIdMatch = videoUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (videoIdMatch) {
    queue.lastVideoId = videoIdMatch[1];
    queue.playedHistory.add(videoIdMatch[1]);
    // Cap history at 50 entries to avoid memory bloat
    if (queue.playedHistory.size > 50) {
      const first = queue.playedHistory.values().next().value;
      queue.playedHistory.delete(first);
    }
  }
  
  console.log('DEBUG: play() using videoUrl:', videoUrl);
  
  // Get the best audio stream URL using yt-dlp
  const youtubedl = require('youtube-dl-exec');
  let streamUrl;
  
  try {
    const info = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      format: 'bestaudio/best'
    });
    
    // Find best audio format
    const audioFormats = info.formats.filter(f => 
      f.acodec && f.acodec !== 'none' && f.url
    );
    
    if (audioFormats.length === 0) {
      throw new Error('No audio formats found');
    }
    
    // Sort by quality
    audioFormats.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
    streamUrl = audioFormats[0].url;
    
    console.log('Got stream URL from yt-dlp, quality:', audioFormats[0].abr || audioFormats[0].tbr);
  } catch (err) {
    console.error('Error getting stream URL:', err);
    throw new Error('Failed to get audio stream from YouTube.');
  }
  
  // Stream the URL through ffmpeg for better compatibility
  const { spawn } = require('child_process');
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', streamUrl,
    '-analyzeduration', '0',
    '-loglevel', '0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  ffmpeg.stderr.on('data', (data) => {
    // Suppress ffmpeg logs unless there's an error
  });
  
  console.log('Created ffmpeg stream for audio');
  
  // Create audio resource from ffmpeg output
  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: require('@discordjs/voice').StreamType.Raw,
    inlineVolume: true
  });
  
  // Reuse existing player or create new one
  let player = players.get(guildId);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    players.set(guildId, player);
  }
  
  // Add error handler for the resource
  resource.playStream.on('error', error => {
    console.error('Stream error:', error);
  });
  
  player.play(resource);
  connection.subscribe(player);
  
  // Clear old listeners to avoid duplicates
  player.removeAllListeners(AudioPlayerStatus.Idle);
  player.removeAllListeners('error');
  
  player.on(AudioPlayerStatus.Idle, () => {
    console.log('Player went idle for guild:', guildId);
    const queue = getQueue(guildId);
    queue.isPlaying = false;
    queue.nowPlaying = null;
    
    if (onFinish) onFinish();
  });
  
  player.on('error', error => {
    console.error('Audio player error:', error);
    const queue = getQueue(guildId);
    queue.isPlaying = false;
    queue.nowPlaying = null;
  });
  
  return player;
}

function stopPlaying(guildId) {
  const player = players.get(guildId);
  if (player) {
    player.stop();
    players.delete(guildId);
  }
  clearQueue(guildId);
  
  const connection = getVoiceConnection(guildId);
  if (connection) {
    connection.destroy();
  }
}

function pausePlaying(guildId) {
  const player = players.get(guildId);
  if (player) {
    player.pause();
    return true;
  }
  return false;
}

function resumePlaying(guildId) {
  const player = players.get(guildId);
  if (player) {
    player.unpause();
    return true;
  }
  return false;
}

function skipSong(guildId) {
  const player = players.get(guildId);
  if (player) {
    player.stop(); // This will trigger the Idle event and play next song
    return true;
  }
  return false;
}

function connectToChannel(voiceChannel) {
  return joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });
}

function getConnection(guild) {
  return getVoiceConnection(guild.id);
}

// Fetch a related song using YouTube's auto-mix playlist (RD prefix)
async function fetchRelatedSong(guildId) {
  const queue = getQueue(guildId);
  const videoId = queue.lastVideoId;
  if (!videoId) return null;

  try {
    const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    console.log(`Autoplay: Fetching related songs from mix: ${mixUrl}`);
    
    const raw = await ytdlexec(mixUrl, {
      flatPlaylist: true,
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const entries = data?.entries || [];
    
    // Filter out songs we've already played
    const candidates = entries.filter(e => e?.id && !queue.playedHistory.has(e.id));
    
    if (candidates.length === 0) {
      console.log('Autoplay: No unplayed candidates found in mix, picking any entry');
      // Fall back to any entry that isn't the current song
      const fallback = entries.find(e => e?.id && e.id !== videoId);
      if (!fallback) return null;
      return {
        query: `https://www.youtube.com/watch?v=${fallback.id}`,
        title: fallback.title || 'Unknown',
        addedBy: 'Autoplay'
      };
    }
    
    // Pick a random song from the top 5 candidates for variety
    const pick = candidates[Math.floor(Math.random() * Math.min(5, candidates.length))];
    return {
      query: `https://www.youtube.com/watch?v=${pick.id}`,
      title: pick.title || 'Unknown',
      addedBy: 'Autoplay'
    };
  } catch (err) {
    console.error('Autoplay: Failed to fetch related songs:', err?.message || err);
    return null;
  }
}

// Expand a YouTube playlist URL into an array of individual video entries
async function expandPlaylist(playlistUrl) {
  try {
    console.log(`Expanding playlist: ${playlistUrl}`);
    const raw = await ytdlexec(playlistUrl, {
      flatPlaylist: true,
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const entries = data?.entries || [];
    
    // Cap at 100 songs
    const capped = entries.slice(0, 100);
    
    return {
      title: data?.title || 'Unknown Playlist',
      songs: capped.map(e => ({
        query: e?.webpage_url || `https://www.youtube.com/watch?v=${e?.id}`,
        title: e?.title || 'Unknown',
        id: e?.id
      })),
      totalCount: entries.length
    };
  } catch (err) {
    console.error('Playlist expansion failed:', err?.message || err);
    return null;
  }
}

module.exports = { 
  play, 
  connectToChannel, 
  getConnection, 
  players,
  resolveVideoUrl,
  getQueue,
  addToQueue,
  clearQueue,
  removeFromQueue,
  getNextSong,
  stopPlaying,
  pausePlaying,
  resumePlaying,
  skipSong,
  fetchRelatedSong,
  expandPlaylist
};
