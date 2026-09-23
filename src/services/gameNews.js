'use strict';
/**
 * Game news for #game-updates, rare sales, and the dates that matter.
 *
 * News is each game's Steam announcements — the developer's own posts, the
 * same ones the store page shows — read from Steam's public news API. No key,
 * no quota. Only the `steam_community_announcements` feed is read: the API
 * also mixes in press coverage, which is not news from the game.
 *
 * As with the YouTube watcher, the loud failure is a first run posting a
 * backlog, so a game nobody has seen before is seeded silently and only what
 * appears afterwards is announced.
 *
 * Events are listed by hand in config — a wipe, a season launch — because no
 * feed publishes them in a shape worth trusting. Each becomes a Discord
 * scheduled event, created once and kept in step with config until it starts,
 * keyed so a restart never makes a duplicate. One deleted by hand stays
 * deleted, as in services/ufc.js.
 */
const axios = require('axios');
const { EmbedBuilder, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');

const NEWS_URL = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
const CLAN_IMAGES = 'https://clan.akamai.steamstatic.com/images';
const STEAM_BLUE = 0x1b2838;
const REMEMBER = 50;
const EXCERPT = 600;

async function fetchNews(appId) {
  const res = await axios.get(NEWS_URL, {
    params: { appid: appId, count: 10, feeds: 'steam_community_announcements' },
    timeout: 15000,
  });
  const items = res.data?.appnews?.newsitems || [];
  // Newest-first from the API; announcing wants oldest-first.
  return items.map((n) => ({
    gid: String(n.gid),
    title: n.title || 'Announcement',
    url: n.url,
    date: n.date ? new Date(n.date * 1000) : null,
    ...readBody(n.contents || ''),
  })).reverse();
}

/** Steam's BBCode, reduced to a Discord-sized excerpt and a picture. */
function readBody(bb) {
  const img = /\[img(?:\s+src="([^"]+)")?\]([^[]*)\[\/img\]/i.exec(bb);
  const video = /\[previewyoutube="([\w-]{11})/i.exec(bb)?.[1];
  let image = img ? (img[1] || img[2]).replace('{STEAM_CLAN_IMAGE}', CLAN_IMAGES) : null;
  if (!image && video) image = `https://img.youtube.com/vi/${video}/hqdefault.jpg`;
  if (image && !/^https:\/\//.test(image)) image = null;

  const text = bb
    .replace(/\[(img|previewyoutube|video)[^\]]*\][\s\S]*?\[\/\1\]/gi, '')
    .replace(/\[h[1-6]\]([\s\S]*?)\[\/h[1-6]\]/gi, '\n**$1**\n')
    .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '**$1**')
    .replace(/\[\*\]/g, '\n• ')
    .replace(/\[\/?(p|tr|list|olist)\]/gi, '\n')
    .replace(/\[\/t[dh]\]/gi, '  ')
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, '[$2]($1)')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const excerpt = text.length > EXCERPT ? `${text.slice(0, EXCERPT).replace(/\s+\S*$/, '')}…` : text;
  return { excerpt, image };
}

function buildEmbed(item, game) {
  const embed = new EmbedBuilder()
    .setColor(STEAM_BLUE)
    .setAuthor({ name: `${game.name} — news on Steam` })
    .setTitle(item.title.slice(0, 256))
    .setURL(item.url);
  if (item.excerpt) embed.setDescription(item.excerpt);
  if (item.image) embed.setImage(item.image);
  if (item.date) embed.setTimestamp(item.date);
  return embed;
}

async function pollNews(client, guildId, cfg) {
  const seen = getGuildState(guildId).gameNewsSeen || {};
  const next = { ...seen };
  let channel = null;

  for (const game of cfg.steamApps) {
    let items;
    try {
      items = await fetchNews(game.appId);
    } catch (err) {
      console.warn(`[GameNews] ${game.name}: fetch failed: ${err?.message || err}`);
      continue;
    }
    const known = seen[game.appId];
    if (!known) {
      next[game.appId] = items.map((i) => i.gid).slice(-REMEMBER);
      console.log(`[GameNews] ${game.name}: seeded ${items.length} existing post(s), announcing none.`);
      continue;
    }
    const fresh = items.filter((i) => !known.includes(i.gid));
    if (!fresh.length) continue;

    channel = channel || await client.channels.fetch(cfg.channel).catch(() => null);
    if (!channel) {
      console.warn(`[GameNews] ${guildId}: channel ${cfg.channel} is unreachable.`);
      break;
    }
    for (const item of fresh) {
      await channel.send({
        content: cfg.pingRole ? `<@&${cfg.pingRole}>` : undefined,
        embeds: [buildEmbed(item, game)],
        allowedMentions: cfg.pingRole ? { roles: [cfg.pingRole] } : { parse: [] },
      });
      console.log(`[GameNews] ${guildId}: announced ${game.name} "${item.title}".`);
    }
    next[game.appId] = [...known, ...fresh.map((i) => i.gid)].slice(-REMEMBER);
  }
  setGuildState(guildId, { gameNewsSeen: next });
}

/**
 * Rare sales, from CheapShark (free, no key). "Rare" means the price is the
 * lowest the game has ever been, on a game people actually rate — not every
 * 90%-off shovelware title, which is most of what any deals feed carries.
 * Well-reviewed free-to-keep giveaways count whatever their price history.
 *
 * A game is announced again only at a lower price than last time, or a month
 * on, and never more than `maxPerDay` in a day.
 */
const CHEAPSHARK = 'https://www.cheapshark.com/api/1.0';
const CHEAPSHARK_UA = 'Sheogorath/1.0 (Discord bot)';
const DEAL_GREEN = 0x3fae49;
const STORE_NAMES = { 1: 'Steam', 7: 'GOG', 11: 'Humble', 25: 'Epic Games Store' };
const cheapshark = (path, params) => axios.get(`${CHEAPSHARK}${path}`, {
  params, timeout: 15000, headers: { 'User-Agent': CHEAPSHARK_UA },
}).then((r) => r.data);

async function rareDeals(d) {
  const deals = [];
  for (const storeID of d.stores) {
    const page = await cheapshark('/deals', { storeID, onSale: 1, sortBy: 'Deal Rating', pageSize: 60 });
    deals.push(...(Array.isArray(page) ? page : []));
  }
  const free = (x) => Number(x.salePrice) === 0 && Number(x.normalPrice) > 0;
  // A giveaway still has to be a game people like: stores give away DLC
  // packs and unreviewed filler too.
  const liked = (x) => (Number(x.steamRatingPercent) >= 75 && Number(x.steamRatingCount) >= 200)
    || Number(x.metacriticScore) >= 75;
  const candidates = deals.filter((x) => (free(x) && liked(x)) || (
    Number(x.savings) >= d.minSavings
    && Number(x.normalPrice) >= d.minNormalPrice
    && Number(x.steamRatingPercent) >= d.minRating
    && Number(x.steamRatingCount) >= d.minReviews));
  if (!candidates.length) return [];

  // The all-time low lives on the game record, not the deal. 25 ids a call.
  const lows = {};
  const ids = [...new Set(candidates.map((x) => x.gameID))];
  for (let i = 0; i < ids.length; i += 25) {
    Object.assign(lows, await cheapshark('/games', { ids: ids.slice(i, i + 25).join(',') }));
  }
  return candidates.filter((x) => free(x)
    || Number(x.salePrice) <= Number(lows[x.gameID]?.cheapestPriceEver?.price ?? -1));
}

function dealEmbed(x) {
  const sale = Number(x.salePrice);
  const store = STORE_NAMES[x.storeID] || 'the store';
  const embed = new EmbedBuilder()
    .setColor(DEAL_GREEN)
    .setAuthor({ name: sale === 0 ? `Free to keep on ${store}` : `All-time low on ${store}` })
    .setTitle(x.title.slice(0, 256))
    .setURL(`https://www.cheapshark.com/redirect?dealID=${x.dealID}`)
    .setDescription(sale === 0
      ? `~~$${x.normalPrice}~~ → **free**`
      : `~~$${x.normalPrice}~~ → **$${x.salePrice}** (−${Math.round(Number(x.savings))}%)`);
  if (x.steamRatingText) embed.addFields({ name: 'Steam reviews', value: `${x.steamRatingText} (${x.steamRatingPercent}%)`, inline: true });
  if (Number(x.metacriticScore) > 0) embed.addFields({ name: 'Metacritic', value: String(x.metacriticScore), inline: true });
  if (x.steamAppID) embed.setImage(`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${x.steamAppID}/header.jpg`);
  else if (x.thumb) embed.setThumbnail(x.thumb);
  return embed;
}

async function pollDeals(client, guildId, cfg) {
  const d = cfg.deals;
  const state = getGuildState(guildId);
  const last = state.gameDealsLastPoll || 0;
  if (Date.now() - last < d.pollMinutes * 60 * 1000) return;
  setGuildState(guildId, { gameDealsLastPoll: Date.now() });

  let found;
  try {
    found = await rareDeals(d);
  } catch (err) {
    console.warn(`[GameNews] ${guildId}: deals lookup failed: ${err?.response?.status || ''} ${err?.message || err}`);
    return;
  }

  const month = 30 * 24 * 3600 * 1000;
  const day = new Date().toISOString().slice(0, 10);
  const seen = Object.fromEntries(Object.entries(state.gameDealsSeen || {})
    .filter(([, v]) => Date.now() - v.at < month));
  let today = state.gameDealsDay === day ? state.gameDealsToday || 0 : 0;
  const fresh = found
    .filter((x) => !seen[x.gameID] || Number(x.salePrice) < seen[x.gameID].price)
    .sort((a, b) => Number(b.dealRating) - Number(a.dealRating));

  let channel = null;
  for (const x of fresh) {
    if (today >= d.maxPerDay) break;
    channel = channel || await client.channels.fetch(cfg.channel).catch(() => null);
    if (!channel) break;
    await channel.send({ embeds: [dealEmbed(x)], allowedMentions: { parse: [] } });
    seen[x.gameID] = { price: Number(x.salePrice), at: Date.now() };
    today++;
    console.log(`[GameNews] ${guildId}: deal "${x.title}" at $${x.salePrice}.`);
  }
  setGuildState(guildId, { gameDealsSeen: seen, gameDealsDay: day, gameDealsToday: today });
}

/**
 * An event's cover, as a Buffer, or null: the configured `image` if there is
 * one (a game not on Steam), otherwise its Steam game's header art. The Steam
 * address comes from the store API because newer games keep their art under a
 * hashed path that cannot be guessed from the app id.
 */
async function coverArt(ev, guildId) {
  if (!ev.image && !ev.appId) return null;
  try {
    let url = ev.image;
    if (!url) {
      const res = await axios.get('https://store.steampowered.com/api/appdetails', {
        params: { appids: ev.appId, filters: 'basic' }, timeout: 15000,
      });
      url = res.data?.[ev.appId]?.data?.header_image;
    }
    if (!url) return null;
    const img = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    return Buffer.from(img.data);
  } catch (err) {
    console.warn(`[GameNews] ${guildId}: no cover art for "${ev.name}": ${err?.message || err}`);
    return null;
  }
}

function eventFields(ev) {
  const base = { name: ev.name, description: ev.description || undefined, scheduledStartTime: ev.start };
  if (ev.voiceChannel) return { ...base, channel: ev.voiceChannel };
  return { ...base, scheduledEndTime: ev.end, entityMetadata: { location: ev.location } };
}

async function syncEvents(client, guild, cfg) {
  const guildId = guild.id;
  const due = cfg.events.filter((ev) => ev.start.getTime() > Date.now());
  if (!due.length) return;
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageEvents)) {
    console.warn(`[GameNews] ${guildId}: missing Manage Events — cannot schedule ${due.length} event(s).`);
    return;
  }

  for (const ev of due) {
    const saved = getGuildState(guildId).gameEvents || {};
    const fields = eventFields(ev);
    try {
      if (saved[ev.key]) {
        const existing = await guild.scheduledEvents.fetch(saved[ev.key].eventId).catch(() => null);
        if (!existing) continue;   // deleted by hand; leave it deleted
        const changed = existing.name !== fields.name
          || (existing.description || '') !== (fields.description || '')
          || existing.scheduledStartTimestamp !== fields.scheduledStartTime.getTime()
          || (fields.channel ? existing.channelId !== fields.channel
            : existing.scheduledEndTimestamp !== fields.scheduledEndTime.getTime()
              || existing.entityMetadata?.location !== fields.entityMetadata.location);
        // A missing cover is looked for again on every sync until one turns up.
        const image = existing.image ? null : await coverArt(ev, guildId);
        if (changed || image) {
          await existing.edit(image ? { ...fields, image } : fields);
          console.log(`[GameNews] ${guildId}: updated event "${ev.name}"${image ? ' with its cover' : ''}.`);
        }
        continue;
      }

      const image = await coverArt(ev, guildId);
      const created = await guild.scheduledEvents.create({
        ...fields,
        ...(image ? { image } : {}),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: ev.voiceChannel ? GuildScheduledEventEntityType.Voice : GuildScheduledEventEntityType.External,
      });
      // Forget events a month gone, so the record never grows.
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      const kept = Object.fromEntries(Object.entries(saved).filter(([, v]) => v.start > cutoff));
      kept[ev.key] = { eventId: created.id, start: ev.start.getTime() };
      setGuildState(guildId, { gameEvents: kept });
      console.log(`[GameNews] ${guildId}: created event "${ev.name}".`);

      const channel = await client.channels.fetch(cfg.eventsChannel).catch(() => null);
      if (channel) await channel.send({ content: created.url, allowedMentions: { parse: [] } });
      else console.warn(`[GameNews] ${guildId}: events channel ${cfg.eventsChannel} is unreachable.`);
    } catch (err) {
      console.warn(`[GameNews] ${guildId}: event "${ev.name}" failed: ${err?.message || err}`);
    }
  }
}

async function pollOnce(client) {
  for (const guildId of guildIds()) {
    const cfg = getGuildConfig(guildId)?.gameNews;
    const guild = cfg && client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      await syncEvents(client, guild, cfg);
      await pollNews(client, guildId, cfg);
      if (cfg.deals) await pollDeals(client, guildId, cfg);
    } catch (err) {
      console.warn(`[GameNews] ${guildId}: poll failed: ${err?.message || err}`);
    }
  }
}

function scheduleGameNews(client) {
  const guilds = guildIds().filter((id) => getGuildConfig(id)?.gameNews);
  if (!guilds.length) return;
  const minutes = Math.max(5, Math.min(...guilds.map((id) => getGuildConfig(id).gameNews.pollMinutes)));
  setInterval(() => { pollOnce(client).catch(() => {}); }, minutes * 60 * 1000);
  pollOnce(client).catch(() => {});
  console.log(`[GameNews] Watching ${guilds.length} guild(s) every ${minutes} minute(s).`);
}

module.exports = { scheduleGameNews, pollOnce, fetchNews, readBody, rareDeals };
