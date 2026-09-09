'use strict';
/**
 * Announces when the house streamers go live.
 *
 * Polling rather than EventSub. EventSub would need a public HTTPS endpoint and
 * a subscription lifecycle to maintain; two channels on a three-minute poll sit
 * well inside Helix's rate limit, need nothing exposed to the internet, and
 * fail in a way that fixes itself on the next tick.
 *
 * The part that actually needs care is not going live — it is *staying* live. A
 * six-hour stream appears in every poll for six hours, so an announcement is
 * keyed to Twitch's own stream id and posted once per id. That id is kept in
 * guild state rather than in memory, so restarting the bot does not re-announce
 * a stream that is still running. A stream that stops and starts again gets a
 * new id from Twitch, and is announced again, which is correct.
 */
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');

const TWITCH_PURPLE = 0x9146ff;
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const STREAMS_URL = 'https://api.twitch.tv/helix/streams';

let token = null;
let tokenExpiry = 0;
let warnedMissingCreds = false;

const credentials = () => ({
  id: process.env.TWITCH_CLIENT_ID,
  secret: process.env.TWITCH_CLIENT_SECRET,
});

function configured() {
  const { id, secret } = credentials();
  return !!(id && secret);
}

/**
 * App access token, cached until a minute before it expires.
 *
 * client_credentials, not a user token: nothing here acts as a person, it only
 * reads which public channels are live, so there is no account to connect and
 * nothing to re-authorise when it lapses.
 */
async function appToken(force = false) {
  if (!force && token && Date.now() < tokenExpiry) return token;
  const { id, secret } = credentials();
  const res = await axios.post(TOKEN_URL, null, {
    params: { client_id: id, client_secret: secret, grant_type: 'client_credentials' },
    timeout: 10000,
  });
  token = res.data.access_token;
  tokenExpiry = Date.now() + Math.max(0, (res.data.expires_in || 3600) - 60) * 1000;
  return token;
}

/** @returns live streams among `logins`, keyed by lower-cased login. */
async function liveStreams(logins) {
  if (!logins.length) return new Map();
  const { id } = credentials();

  const call = async (bearer) => axios.get(STREAMS_URL, {
    params: { user_login: logins },
    paramsSerializer: (p) => p.user_login.map((l) => `user_login=${encodeURIComponent(l)}`).join('&'),
    headers: { 'Client-ID': id, Authorization: `Bearer ${bearer}` },
    timeout: 10000,
  });

  let res;
  try {
    res = await call(await appToken());
  } catch (err) {
    // A token can be revoked before it expires. One forced refresh, then give
    // up until the next tick rather than hammering the token endpoint.
    if (err?.response?.status !== 401) throw err;
    res = await call(await appToken(true));
  }

  const out = new Map();
  for (const s of res.data?.data || []) out.set(String(s.user_login).toLowerCase(), s);
  return out;
}

function buildEmbed(stream, display) {
  const url = `https://twitch.tv/${stream.user_login}`;
  const preview = String(stream.thumbnail_url || '')
    .replace('{width}', '1280').replace('{height}', '720');

  const embed = new EmbedBuilder()
    .setColor(TWITCH_PURPLE)
    .setAuthor({ name: `${display} is live on Twitch`, url })
    .setTitle(stream.title || url)
    .setURL(url)
    .setTimestamp(stream.started_at ? new Date(stream.started_at) : new Date());

  if (stream.game_name) embed.addFields({ name: 'Playing', value: stream.game_name, inline: true });
  // Cache-buster: Twitch serves the preview from one stable URL per channel, so
  // without it Discord shows whatever it cached from the last stream.
  if (preview) embed.setImage(`${preview}?t=${Date.now()}`);
  return embed;
}

async function pollGuild(client, guildId) {
  const cfg = getGuildConfig(guildId)?.twitch;
  if (!cfg?.channel || !cfg.streamers.length) return;

  const seen = getGuildState(guildId).twitchLive || {};
  const live = await liveStreams(cfg.streamers.map((s) => s.login));
  const next = {};
  let channel = null;

  for (const streamer of cfg.streamers) {
    const stream = live.get(streamer.login);
    if (!stream) continue;                       // offline: drops out of `next`
    next[streamer.login] = stream.id;
    if (seen[streamer.login] === stream.id) continue;   // already announced

    channel = channel || await client.channels.fetch(cfg.channel).catch(() => null);
    if (!channel) {
      console.warn(`[Twitch] ${guildId}: announce channel ${cfg.channel} is unreachable.`);
      return;
    }
    await channel.send({
      content: `${cfg.pingRole ? `<@&${cfg.pingRole}> ` : ''}**${streamer.name}** is live — https://twitch.tv/${streamer.login}`,
      embeds: [buildEmbed(stream, streamer.name)],
      allowedMentions: cfg.pingRole ? { roles: [cfg.pingRole] } : { parse: [] },
    });
    console.log(`[Twitch] ${guildId}: announced ${streamer.login} (stream ${stream.id}).`);
  }

  // Written every tick, not only on change: this is also what forgets a stream
  // that has ended, so the next one announces.
  setGuildState(guildId, { twitchLive: next });
}

async function pollOnce(client) {
  if (!configured()) return;
  for (const guildId of guildIds()) {
    try {
      await pollGuild(client, guildId);
    } catch (err) {
      console.warn(`[Twitch] ${guildId}: poll failed: ${err?.response?.status || ''} ${err?.message || err}`);
    }
  }
}

/**
 * Arm the poll. A guild with no `twitch` block is skipped by pollGuild, so this
 * is safe to call unconditionally; missing credentials stop it here instead.
 */
function scheduleStreamWatch(client) {
  const guilds = guildIds().filter((id) => getGuildConfig(id)?.twitch?.channel);
  if (!guilds.length) return;

  if (!configured()) {
    if (!warnedMissingCreds) {
      warnedMissingCreds = true;
      console.warn('[Twitch] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are unset — live announcements are off.');
    }
    return;
  }

  // Fastest poll any configured guild asks for; each guild is filtered by its
  // own state, so a shared tick costs one request for everybody.
  const minutes = Math.max(1, Math.min(...guilds.map((id) => getGuildConfig(id).twitch.pollMinutes)));
  setInterval(() => { pollOnce(client).catch(() => {}); }, minutes * 60 * 1000);
  pollOnce(client).catch(() => {});
  console.log(`[Twitch] Watching ${guilds.length} guild(s) every ${minutes} minute(s).`);
}

module.exports = { scheduleStreamWatch, pollOnce, configured };
