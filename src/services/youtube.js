'use strict';
/**
 * Announces new uploads from the house YouTube channels.
 *
 * The RSS feed rather than the Data API, for the same reason the Twitch watcher
 * polls: no key to obtain, no quota to run out of, and nothing to rotate. The
 * feed carries the last fifteen uploads with ids and timestamps, which is all an
 * announcement needs.
 *
 * The failure mode this has to avoid is the loud one — a first run posting
 * fifteen videos into a channel at once. So a feed nobody has seen before is
 * *seeded* silently: its current contents are recorded as already-announced and
 * nothing is posted. Only what shows up afterwards is new. Backfilling on
 * purpose is a separate, explicit act (scripts/youtube-backfill.js).
 */
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');

const YOUTUBE_RED = 0xff0033;
const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
// Plenty of headroom over the fifteen a feed carries, so nothing falls out of
// the record while it is still in the feed and gets announced twice.
const REMEMBER = 50;

/** Minimal parse. The feed is small, regular, and not worth a dependency. */
function parseFeed(xml) {
  const out = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = /<yt:videoId>(.*?)<\/yt:videoId>/.exec(entry)?.[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1];
    const published = /<published>(.*?)<\/published>/.exec(entry)?.[1];
    const thumb = /<media:thumbnail url="(.*?)"/.exec(entry)?.[1];
    if (id) out.push({ id, title: decode(title || id), published, thumb });
  }
  // Feed order is newest-first; announcing wants oldest-first.
  return out.reverse();
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();

async function fetchFeed(channelId) {
  const res = await axios.get(FEED + encodeURIComponent(channelId), {
    timeout: 15000,
    headers: { 'User-Agent': 'Sheogorath/1.0 (+discord bot)' },
  });
  return parseFeed(res.data);
}

function buildEmbed(video, feedName) {
  const url = `https://www.youtube.com/watch?v=${video.id}`;
  const embed = new EmbedBuilder()
    .setColor(YOUTUBE_RED)
    .setAuthor({ name: `${feedName} posted a video` })
    .setTitle(video.title)
    .setURL(url);
  if (video.published) embed.setTimestamp(new Date(video.published));
  if (video.thumb) embed.setImage(video.thumb);
  return embed;
}

/**
 * @param {object} opts
 * @param {boolean} [opts.announce=true] false records what is there without posting
 */
async function pollGuild(client, guildId, { announce = true } = {}) {
  const cfg = getGuildConfig(guildId)?.youtube;
  if (!cfg?.channel || !cfg.feeds.length) return { posted: 0, seeded: 0 };

  const state = getGuildState(guildId).youtubeSeen || {};
  const next = { ...state };
  let channel = null;
  let posted = 0;
  let seeded = 0;

  for (const feed of cfg.feeds) {
    let videos;
    try {
      videos = await fetchFeed(feed.channelId);
    } catch (err) {
      console.warn(`[YouTube] ${feed.name}: feed fetch failed: ${err?.message || err}`);
      continue;
    }

    const known = state[feed.channelId];
    if (!known) {
      // First sight of this feed. Record, say nothing.
      next[feed.channelId] = videos.map((v) => v.id).slice(-REMEMBER);
      seeded += videos.length;
      console.log(`[YouTube] ${feed.name}: seeded ${videos.length} existing upload(s), announcing none.`);
      continue;
    }

    const fresh = videos.filter((v) => !known.includes(v.id));
    if (!fresh.length) continue;

    if (announce) {
      channel = channel || await client.channels.fetch(cfg.channel).catch(() => null);
      if (!channel) {
        console.warn(`[YouTube] ${guildId}: announce channel ${cfg.channel} is unreachable.`);
        return { posted, seeded };
      }
      for (const video of fresh) {
        await channel.send({
          content: `${cfg.pingRole ? `<@&${cfg.pingRole}> ` : ''}**${feed.name}** posted a new video — https://www.youtube.com/watch?v=${video.id}`,
          embeds: [buildEmbed(video, feed.name)],
          allowedMentions: cfg.pingRole ? { roles: [cfg.pingRole] } : { parse: [] },
        });
        posted++;
        console.log(`[YouTube] ${guildId}: announced ${video.id} (${video.title}).`);
      }
    }
    next[feed.channelId] = [...known, ...fresh.map((v) => v.id)].slice(-REMEMBER);
  }

  setGuildState(guildId, { youtubeSeen: next });
  return { posted, seeded };
}

async function pollOnce(client) {
  for (const guildId of guildIds()) {
    try {
      await pollGuild(client, guildId);
    } catch (err) {
      console.warn(`[YouTube] ${guildId}: poll failed: ${err?.message || err}`);
    }
  }
}

function scheduleVideoWatch(client) {
  const guilds = guildIds().filter((id) => getGuildConfig(id)?.youtube?.channel);
  if (!guilds.length) return;

  // Uploads are not time-critical the way going live is, so this polls far more
  // slowly than the Twitch watcher and costs one request per feed per tick.
  const minutes = Math.max(5, Math.min(...guilds.map((id) => getGuildConfig(id).youtube.pollMinutes)));
  setInterval(() => { pollOnce(client).catch(() => {}); }, minutes * 60 * 1000);
  pollOnce(client).catch(() => {});
  console.log(`[YouTube] Watching ${guilds.length} guild(s) every ${minutes} minute(s).`);
}

module.exports = { scheduleVideoWatch, pollOnce, pollGuild, fetchFeed, parseFeed };
