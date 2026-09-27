'use strict';
/**
 * Says when the UFC post-fight press conference goes live on YouTube.
 *
 * Not the RSS feed services/youtube.js reads: UFC's feed 404s, and a feed would
 * say a stream exists, not that it has started. Instead the channel's Live tab
 * is read for anything titled as a post-fight press conference that is not yet
 * a finished recording, and each such video's own page settles whether it is
 * live now. The channel's /live redirect is no use here — on fight night it
 * points at whichever premiere UFC has scheduled next, not the presser.
 *
 * Both pages are unofficial and a megabyte each, so this only looks during a
 * fight night: from the first bout of a card services/ufc.js has made an event
 * for, until WINDOW_HOURS later. Outside that it makes no requests at all.
 *
 * A presser is announced once per video id, kept in guild state so a restart
 * mid-conference does not announce it again.
 */
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');

const STREAMS_URL = 'https://www.youtube.com/@ufc/streams';
const WATCH_URL = 'https://www.youtube.com/watch?v=';
const YOUTUBE_RED = 0xff0033;
const POLL_MINUTES = 2;
// Early prelims to the end of a pay-per-view presser is about eight hours.
const WINDOW_HOURS = 10;
const PRESSER = /post[\s-]*fight press conference/i;
const REMEMBER = 20;
// English, and past the EU consent wall, so titles and markers come back as expected.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Sheogorath)',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+1',
};

async function page(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return String(res.data || '');
}

/** Every video on the Live tab as { id, title, badges }. */
function parseStreams(html) {
  const json = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html)?.[1];
  if (!json) throw new Error('no ytInitialData on the Live tab');
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    const v = o.lockupViewModel;
    if (v?.contentId && v.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      out.push({
        id: v.contentId,
        title: v.metadata?.lockupMetadataViewModel?.title?.content || '',
        badges: [...JSON.stringify(v.contentImage || {}).matchAll(/"text":"([^"]{1,30})"/g)].map((m) => m[1]),
      });
      return;
    }
    for (const k in o) walk(o[k]);
  })(JSON.parse(json));
  return out;
}

/**
 * Pressers not yet over. A finished stream carries its duration as a badge;
 * live and upcoming ones do not, so those are the ones worth a closer look.
 */
function candidates(videos) {
  return videos.filter((v) => PRESSER.test(v.title) && !v.badges.some((b) => /^\d+(:\d{2})+$/.test(b)));
}

async function isLiveNow(id) {
  return /"isLiveNow":true/.test(await page(WATCH_URL + id));
}

/** True while any guild's UFC card is inside its fight-night window. */
function fightNight(now = Date.now()) {
  return guildIds().some((id) => getGuildConfig(id)?.ufc
    && Object.values(getGuildState(id).ufcEvents || {})
      .some((e) => now >= e.start && now < e.start + WINDOW_HOURS * 3600 * 1000));
}

function buildEmbed(video) {
  return new EmbedBuilder()
    .setColor(YOUTUBE_RED)
    .setAuthor({ name: 'UFC is live on YouTube' })
    .setTitle(video.title.slice(0, 256))
    .setURL(WATCH_URL + video.id)
    .setImage(`https://i.ytimg.com/vi/${video.id}/hqdefault_live.jpg`)
    .setTimestamp(new Date());
}

async function announce(client, guildId, video) {
  const cfg = getGuildConfig(guildId)?.ufc;
  const seen = getGuildState(guildId).ufcPresserSeen || [];
  if (!cfg?.channel || seen.includes(video.id)) return;

  const channel = await client.channels.fetch(cfg.channel).catch(() => null);
  if (!channel) {
    console.warn(`[UFC] ${guildId}: channel ${cfg.channel} is unreachable.`);
    return;
  }
  await channel.send({
    content: `${cfg.pingRole ? `<@&${cfg.pingRole}> ` : ''}The post-fight press conference is live — ${WATCH_URL}${video.id}`,
    embeds: [buildEmbed(video)],
    allowedMentions: cfg.pingRole ? { roles: [cfg.pingRole] } : { parse: [] },
  });
  setGuildState(guildId, { ufcPresserSeen: [...seen, video.id].slice(-REMEMBER) });
  console.log(`[UFC] ${guildId}: announced presser ${video.id} (${video.title}).`);
}

async function pollOnce(client) {
  if (!fightNight()) return;
  let live = [];
  try {
    for (const video of candidates(parseStreams(await page(STREAMS_URL)))) {
      if (await isLiveNow(video.id)) live.push(video);
    }
  } catch (err) {
    console.warn(`[UFC] presser check failed: ${err?.response?.status || ''} ${err?.message || err}`);
    return;
  }
  for (const guildId of guildIds()) {
    for (const video of live) {
      try {
        await announce(client, guildId, video);
      } catch (err) {
        console.warn(`[UFC] ${guildId}: presser announce failed: ${err?.message || err}`);
      }
    }
  }
}

function schedulePresserWatch(client) {
  const guilds = guildIds().filter((id) => getGuildConfig(id)?.ufc?.channel);
  if (!guilds.length) return;
  setInterval(() => { pollOnce(client).catch(() => {}); }, POLL_MINUTES * 60 * 1000);
  pollOnce(client).catch(() => {});
  console.log(`[UFC] Watching for post-fight pressers for ${guilds.length} guild(s) on fight nights.`);
}

module.exports = { schedulePresserWatch, pollOnce, parseStreams, candidates, isLiveNow, fightNight };
