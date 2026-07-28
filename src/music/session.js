'use strict';
/**
 * Shared playback session logic.
 *
 * This used to live inside commands/play.js, which meant it could only be
 * driven by a Discord interaction. The control API needs the same queue
 * advancement, autoplay and now-playing behaviour without an interaction to
 * hang it off, so it lives here and both surfaces call in.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const {
  play,
  players,
  getQueue,
  addToQueue,
  getNextSong,
  connectToChannel,
  getConnection,
  fetchRelatedSong,
} = require('./player');
const { createNowPlayingEmbed } = require('./embeds');

const MUSIC_CHANNEL_ID = process.env.MUSIC_CHANNEL_ID || '534553333034123289';
// Voice channel the control app falls back to when the bot isn't already
// connected. "Tapped In" on the primary guild.
const DEFAULT_VOICE_CHANNEL_ID = process.env.DEFAULT_VOICE_CHANNEL_ID || '949392766453043260';

// Track last now playing message to keep channel clean
const lastNowPlayingMessages = new Map(); // guildId -> messageId

/** The pause/skip/stop/remove control row attached to every now-playing post. */
function buildControlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_pause')
      .setLabel('⏯️ Pause/Resume')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('music_skip')
      .setLabel('⏭️ Skip')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_stop')
      .setLabel('⏹️ Stop')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music_remove')
      .setLabel('🗑️ Remove')
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * Post the now-playing embed to the music channel, clearing prior messages so
 * the channel stays a single live "player" rather than a scrolling log.
 */
async function postNowPlaying(client, guildId, fallbackSong, addedBy) {
  const channel = await client.channels.fetch(MUSIC_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const queue = getQueue(guildId);
  try {
    try {
      const messages = await channel.messages.fetch({ limit: 100 });
      await channel.bulkDelete(messages, true);
    } catch (err) {
      // bulkDelete refuses messages older than 14 days; not worth failing over.
      console.error('Could not clear music channel:', err.message);
    }

    const embed = await createNowPlayingEmbed(
      {
        ...(queue.nowPlaying || {}),
        url: queue.nowPlaying?.url,
        title: queue.nowPlaying?.title || fallbackSong?.title || fallbackSong?.query,
        query: fallbackSong?.query,
      },
      addedBy || fallbackSong?.addedBy || 'Unknown'
    );

    const msg = await channel.send({ embeds: [embed], components: [buildControlRow()] });
    lastNowPlayingMessages.set(guildId, msg.id);
  } catch (e) {
    console.error('Could not send now playing message:', e);
  }
}

/**
 * Advance to the next queued track, falling back to autoplay when the queue
 * empties. Uses channel.send rather than interaction.followUp because an
 * interaction token expires after 15 minutes and playback outlives that.
 */
async function playNextInQueue(client, connection, guildId) {
  const queue = getQueue(guildId);

  if (queue.songs.length === 0) {
    if (queue.autoplay && queue.lastVideoId) {
      try {
        const related = await fetchRelatedSong(guildId);
        if (related) {
          console.log(`Autoplay: Queuing related song: ${related.title}`);
          addToQueue(guildId, related);
          const channel = await client.channels.fetch(MUSIC_CHANNEL_ID).catch(() => null);
          if (channel) {
            try {
              await channel.send(`🔄 **Autoplay:** Queuing **${related.title}**`);
            } catch (e) {
              console.error('Could not send autoplay message:', e);
            }
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
    await postNowPlaying(client, guildId, nextSong, nextSong.addedBy);
  } catch (err) {
    console.error('Error playing next song in queue:', err);
    await playNextInQueue(client, connection, guildId);
  }
}

/**
 * Begin playing a track immediately, wiring the finish handler that keeps the
 * queue draining.
 */
async function startPlayback(client, connection, guildId, song) {
  const player = await play(connection, song.query, guildId, async () => {
    await playNextInQueue(client, connection, guildId);
  });
  players.set(guildId, player);
  await postNowPlaying(client, guildId, song, song.addedBy);
  return player;
}

/**
 * Resolve a voice connection for API-driven playback, which has no invoking
 * member to read a voice state from. Prefers an existing connection so we never
 * yank the bot out of a channel people are already listening in.
 */
async function ensureVoiceConnection(client, guildId) {
  const existing = getConnection({ id: guildId });
  if (existing) return existing;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error('Guild not found.');

  const channel = await guild.channels.fetch(DEFAULT_VOICE_CHANNEL_ID).catch(() => null);
  if (!channel) throw new Error('Configured voice channel not found.');
  if (channel.type !== ChannelType.GuildVoice) {
    throw new Error('Configured channel is not a voice channel.');
  }

  return connectToChannel(channel);
}

module.exports = {
  MUSIC_CHANNEL_ID,
  DEFAULT_VOICE_CHANNEL_ID,
  buildControlRow,
  postNowPlaying,
  playNextInQueue,
  startPlayback,
  ensureVoiceConnection,
  lastNowPlayingMessages,
};
