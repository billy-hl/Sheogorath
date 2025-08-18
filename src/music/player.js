const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection, demuxProbe } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytdlexec = require('youtube-dl-exec');

// Optional: Use cookies if provided to improve access to restricted videos
let requestOptions = undefined;
if (process.env.YOUTUBE_COOKIE) {
  requestOptions = { headers: { cookie: process.env.YOUTUBE_COOKIE } };
  console.log('DEBUG: YouTube cookie configured for ytdl-core requests.');
}

const players = new Map();

async function play(connection, url, onFinish) {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    console.error('play() called with invalid url:', url);
    throw new Error('No URL or search term provided.');
  }
  // Resolve URL: if valid video URL, use directly; else search via yt-dlp
  let videoUrl = url;
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
      const webpageUrl = entry?.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : null);
      if (!webpageUrl) throw new Error('No results found for your search.');
      videoUrl = webpageUrl;
    } catch (err) {
      console.error('Error searching YouTube via yt-dlp:', err?.stderr || err?.message || err);
      throw new Error('Failed to search YouTube for your query.');
    }
  }
  console.log('DEBUG: play() using videoUrl:', videoUrl);
  let audioStream;
  try {
    // Use @distube/ytdl-core for more reliable streaming
    audioStream = ytdl(videoUrl, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25,
      dlChunkSize: 0,
      requestOptions,
    });
  } catch (err) {
    console.error('Error creating ytdl stream for videoUrl:', videoUrl, err);
    throw new Error('Failed to create audio stream from YouTube.');
  }
  let probed;
  try {
    probed = await demuxProbe(audioStream);
  } catch (err) {
    console.error('Error probing stream type:', err);
    throw new Error('Failed to prepare audio stream.');
  }
  const resource = createAudioResource(probed.stream, { inputType: probed.type });
  let player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  player.play(resource);
  connection.subscribe(player);
  player.on(AudioPlayerStatus.Idle, () => {
    if (onFinish) onFinish();
  });
  return player;
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

module.exports = { play, connectToChannel, getConnection, players };
