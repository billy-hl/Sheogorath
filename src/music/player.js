const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection, demuxProbe } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytdlexec = require('youtube-dl-exec');
const { parseYouTubeUrl } = require('../services/youtube');

// Optional: Use cookies if provided to improve access to restricted videos
let requestOptions = undefined;
if (process.env.YOUTUBE_COOKIE) {
  requestOptions = { headers: { cookie: process.env.YOUTUBE_COOKIE } };
  console.log('DEBUG: YouTube cookie configured for ytdl-core requests.');
}

const players = new Map();
const queues = new Map(); // Store queue for each guild

// Queue management functions
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      songs: [],
      nowPlaying: null,
      isPlaying: false
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
  
  console.log('DEBUG: play() using videoUrl:', videoUrl);
  
  // Clean the URL to remove playlist and radio parameters that might cause issues
  let cleanedUrl = videoUrl;
  const parsed = parseYouTubeUrl(videoUrl);
  if (parsed && parsed.videoId) {
    cleanedUrl = `https://www.youtube.com/watch?v=${parsed.videoId}`;
    console.log('DEBUG: cleaned videoUrl to:', cleanedUrl);
  }
  
  // Get the direct audio stream URL using yt-dlp
  let streamUrl;
  try {
    const youtubedl = require('youtube-dl-exec');
    const info = await youtubedl(cleanedUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0']
    });
    
    if (!info.formats || info.formats.length === 0) {
      throw new Error('No formats available');
    }
    
    // Try to find audio-only formats first
    let audioFormats = info.formats.filter(f => 
      f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
    );
    
    // If no audio-only formats, use formats with audio (even if they have video)
    if (audioFormats.length === 0) {
      console.log('No audio-only formats, using formats with audio');
      audioFormats = info.formats.filter(f => f.acodec && f.acodec !== 'none');
    }
    
    if (audioFormats.length === 0) {
      throw new Error('No formats with audio found');
    }
    
    // Sort by audio bitrate (prefer higher quality)
    audioFormats.sort((a, b) => {
      const aQuality = a.abr || a.tbr || 0;
      const bQuality = b.abr || b.tbr || 0;
      return bQuality - aQuality;
    });
    
    streamUrl = audioFormats[0].url;
    
    console.log('Got direct stream URL, format:', audioFormats[0].ext, 
                'codec:', audioFormats[0].acodec, 
                'quality:', audioFormats[0].abr || audioFormats[0].tbr);
  } catch (err) {
    console.error('Error getting stream URL:', err);
    throw new Error('Failed to get audio stream from YouTube.');
  }
  
  // Create audio resource from the stream URL
  const resource = createAudioResource(streamUrl, {
    inlineVolume: true
  });
  let player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  player.play(resource);
  connection.subscribe(player);
  player.on(AudioPlayerStatus.Idle, () => {
    const queue = getQueue(guildId);
    queue.isPlaying = false;
    queue.nowPlaying = null;
    
    if (onFinish) onFinish();
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
  skipSong
};
