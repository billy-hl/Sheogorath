'use strict';
/**
 * Announces new uploads from the house YouTube channels.
 *
 * The RSS feed rather than the Data API, for the same reason the Twitch watcher
 * polls: no key to obtain, no quota to run out of, and nothing to rotate. The
 * feed carries the last fifteen uploads with ids and timestamps, which is all an
 * announcement needs.
 *
 * It is not dependable, though. For hours at a stretch, most days, it answers
 * 404 or 500 for channels that plainly exist and have uploads, and not for one
 * channel in particular. The site itself is served apart from the feed, so while
 * a feed is down the channel's uploads playlist page stands in: the same videos
 * in the same order, but a megabyte rather than eleven kilobytes, and with ages
 * ("3d ago") where the feed has timestamps.
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
// A channel's uploads playlist is its id with UC swapped for UU.
const UPLOADS = 'https://www.youtube.com/playlist?list=UU';
// English, and past the EU consent wall, so the page comes back in the shape parsed below.
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Sheogorath)',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+1',
};
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

/**
 * The page's data, in whichever of the two shapes YouTube served this time.
 *
 * It used to be one: an inline `var ytInitialData = {...};`. Since about
 * 2026-10-05 some responses instead carry the same JSON in a
 * `<script id="yt-initial-data" type="application/json">` element that the page
 * parses itself — about one fetch in five from leviathan, for the same URL a
 * second apart. Reading only the old shape made the fallback fail on those, so
 * a feed outage could lose polls even though the page was there.
 */
function initialData(html) {
  return /var ytInitialData = (\{.*?\});<\/script>/s.exec(html)?.[1]
    || /<script[^>]*\bid="yt-initial-data"[^>]*>(\{.*?\})<\/script>/s.exec(html)?.[1]
    || null;
}

/**
 * The uploads playlist page, oldest-first like parseFeed. Only what can be
 * watched now: a finished upload carries its duration as a badge and a live one
 * a LIVE badge, while something scheduled has neither and waits until it does.
 */
function parseUploadsPage(html) {
  const json = initialData(html);
  if (!json) throw new Error('no ytInitialData on the uploads page');
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    const v = o.lockupViewModel;
    if (v?.contentId && v.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const image = JSON.stringify(v.contentImage || {});
      if (/"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE"/.test(image) || /"text":"\d+(:\d{2})+"/.test(image)) {
        out.push({
          id: v.contentId,
          title: v.metadata?.lockupMetadataViewModel?.title?.content || v.contentId,
          published: null,
          thumb: `https://i.ytimg.com/vi/${v.contentId}/hqdefault.jpg`,
        });
      }
      return;
    }
    for (const k in o) walk(o[k]);
  })(JSON.parse(json).contents);
  return out.reverse();
}

async function fetchUploadsPage(channelId) {
  const res = await axios.get(UPLOADS + encodeURIComponent(channelId.slice(2)), {
    timeout: 15000,
    headers: PAGE_HEADERS,
  });
  return parseUploadsPage(String(res.data || ''));
}

// Channel ids whose feed is failing, with how many fetches in a row have failed,
// so an outage is logged as it starts and ends rather than on every poll.
const feedDown = new Map();

/**
 * The feed or, while it is down, the uploads page cut to start at the deepest
 * video already on record. The page reaches further back than the feed's
 * fifteen and leaves out uploads blocked in the bot's region, so an unrecorded
 * id below everything on record is old rather than new: it was past the feed's
 * reach when the feed was seeded. Seeding itself waits for the feed.
 */
async function fetchUploads(feed, known) {
  let feedError;
  try {
    const videos = await fetchFeed(feed.channelId);
    if (feedDown.has(feed.channelId)) {
      console.log(`[YouTube] ${feed.name}: feed is back after ${feedDown.get(feed.channelId)} failed fetch(es).`);
      feedDown.delete(feed.channelId);
    }
    return videos;
  } catch (err) {
    feedError = err?.message || String(err);
  }

  const failures = (feedDown.get(feed.channelId) || 0) + 1;
  feedDown.set(feed.channelId, failures);
  if (!known) throw new Error(`feed fetch failed: ${feedError}`);
  if (failures === 1) {
    console.warn(`[YouTube] ${feed.name}: feed fetch failed (${feedError}); reading the uploads page until it is back.`);
  }

  let videos;
  try {
    videos = await fetchUploadsPage(feed.channelId);
  } catch (err) {
    throw new Error(`feed fetch failed (${feedError}), and so did the uploads page: ${err?.message || err}`);
  }
  const deepest = videos.findIndex((v) => known.includes(v.id));
  if (deepest === -1) throw new Error(`feed fetch failed (${feedError}), and nothing on the uploads page is on record`);
  return videos.slice(deepest);
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
    const known = state[feed.channelId];
    let videos;
    try {
      videos = await fetchUploads(feed, known);
    } catch (err) {
      console.warn(`[YouTube] ${feed.name}: ${err?.message || err}`);
      continue;
    }

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

module.exports = {
  scheduleVideoWatch, pollOnce, pollGuild, fetchFeed, parseFeed, fetchUploadsPage, parseUploadsPage,
};
