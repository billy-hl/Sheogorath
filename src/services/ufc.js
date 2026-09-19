'use strict';
/**
 * A Discord scheduled event for each UFC card and Contender Series night.
 *
 * The card comes from ESPN's public scoreboard. ESPN no longer carries the
 * fights — Paramount+ does — but it still publishes the schedule, the bouts and
 * the broadcaster, with no key. It is an unofficial endpoint, so a shape change
 * shows up here as a logged warning and no event, never as a crash.
 *
 * Each event is created from the Monday of fight week and re-synced every few
 * hours until the first bout, so a scratched or swapped bout reaches the
 * event on its own. With `voiceChannel` configured it is a voice event in that
 * room; without one, Discord needs an External event with a location, so the
 * broadcaster goes there. The text `channel` gets one post linking to each
 * event when it is created.
 *
 * What was created is kept in guild state, keyed to ESPN's event id, so a
 * restart never makes a duplicate. An event somebody deletes by hand stays
 * deleted: that is a person deciding they did not want it.
 */
const axios = require('axios');
const { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';
const SYNC_HOURS = 6;
// Discord needs an end time for an External event. A main card runs about
// three hours; a little slack keeps the event open through the main event.
// The event itself opens with the prelims, when people start watching.
const MAIN_CARD_HOURS = 4;
const TZ = 'America/New_York';

async function scoreboard(dates) {
  const res = await axios.get(SCOREBOARD_URL, { params: dates ? { dates } : {}, timeout: 15000 });
  return res.data || {};
}

/** Fight week starts Monday 00:00 Eastern, the week the card falls in. */
function fightWeekStart(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const back = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  // Noon UTC on the Eastern calendar date, stepped back to Monday, then
  // pulled to midnight Eastern. Noon keeps DST changes from moving the day.
  const monday = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day - back, 12));
  const offsetH = new Date(monday.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
    - new Date(monday.toLocaleString('en-US', { timeZone: TZ })).getTime();
  return new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()) + offsetH);
}

/** ESPN's `dates` filter works in US Eastern days, not UTC ones. */
function easternDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date).replace(/-/g, '');
}

/** Every card whose fight week has begun and that has not finished. */
async function upcomingCards(now = new Date()) {
  const calendar = (await scoreboard()).leagues?.[0]?.calendar || [];
  const due = calendar.filter((c) => c.label && c.startDate
    && new Date(c.endDate || c.startDate) > now
    && fightWeekStart(new Date(c.startDate)) <= now);

  const cards = [];
  for (const entry of due) {
    // The calendar's time is only roughly the event's, so fetch the bouts from
    // the card's own day and match on the name.
    const events = (await scoreboard(easternDay(new Date(entry.startDate)))).events || [];
    const event = events.find((e) => e.name === entry.label);
    const card = event && parseCard(event);
    if (card) cards.push(card);
  }
  return cards;
}

/**
 * The main card is the latest start-time block on the card. ESPN lists bouts
 * from the first prelim down to the main event, each with its block's time.
 */
function parseCard(event) {
  const bouts = (event.competitions || []).map((c) => ({
    start: new Date(c.startDate || c.date),
    weight: c.type?.abbreviation || '',
    fighters: [...(c.competitors || [])]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((p) => p.athlete?.displayName)
      .filter(Boolean),
    broadcast: c.broadcast || c.broadcasts?.[0]?.names?.[0] || null,
  })).filter((b) => b.fighters.length === 2 && !Number.isNaN(b.start.getTime()));
  if (!bouts.length) return null;

  const mainStart = new Date(Math.max(...bouts.map((b) => b.start.getTime())));
  const main = bouts.filter((b) => b.start.getTime() === mainStart.getTime()).reverse();
  const firstStart = new Date(Math.min(...bouts.map((b) => b.start.getTime())));
  return {
    espnId: String(event.id),
    name: event.name,
    // A Contender Series night has no main event, just five fights for a contract.
    contender: /contender series/i.test(event.name || ''),
    start: firstStart,
    mainStart,
    prelimsStart: firstStart < mainStart ? firstStart : null,
    broadcast: main[0].broadcast || 'Paramount+',
    main,
  };
}

function describe(card) {
  const lines = card.main.map((b, i) =>
    `${i === 0 && !card.contender ? '**Main event:** ' : '• '}${b.fighters.join(' vs ')}${b.weight ? ` (${b.weight})` : ''}`);
  const at = (d) => d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const tail = card.prelimsStart
    ? `Prelims ${at(card.prelimsStart)} ET, main card ${at(card.mainStart)} ET, on ${card.broadcast}.`
    : `Live on ${card.broadcast}.`;
  return `${lines.join('\n')}\n\n${tail}`.slice(0, 1000);
}

function eventFields(card, cfg) {
  const base = { name: card.name.slice(0, 100), description: describe(card), scheduledStartTime: card.start };
  if (cfg.voiceChannel) return { ...base, channel: cfg.voiceChannel };
  return {
    ...base,
    scheduledEndTime: new Date(card.mainStart.getTime() + MAIN_CARD_HOURS * 3600 * 1000),
    entityMetadata: { location: card.broadcast.slice(0, 100) },
  };
}

async function syncCard(client, guild, cfg, card) {
  const guildId = guild.id;
  // Once the card has started Discord will not move the event, and there is
  // nothing left worth changing.
  if (Date.now() >= card.start.getTime()) return;

  const saved = getGuildState(guildId).ufcEvents || {};
  const fields = eventFields(card, cfg);

  if (saved[card.espnId]) {
    const existing = await guild.scheduledEvents.fetch(saved[card.espnId].eventId).catch(() => null);
    if (!existing) return;   // deleted by hand; leave it deleted
    const changed = existing.name !== fields.name
      || existing.description !== fields.description
      || existing.scheduledStartTimestamp !== fields.scheduledStartTime.getTime()
      || (fields.channel ? existing.channelId !== fields.channel
        : existing.entityMetadata?.location !== fields.entityMetadata.location);
    if (changed) {
      await existing.edit(fields);
      console.log(`[UFC] ${guildId}: updated "${card.name}".`);
    }
    return;
  }

  const created = await guild.scheduledEvents.create({
    ...fields,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType: cfg.voiceChannel ? GuildScheduledEventEntityType.Voice : GuildScheduledEventEntityType.External,
  });
  // Forget cards more than a fortnight gone, so the record never grows.
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  const kept = Object.fromEntries(Object.entries(saved).filter(([, v]) => v.start > cutoff));
  kept[card.espnId] = { eventId: created.id, start: card.start.getTime() };
  setGuildState(guildId, { ufcEvents: kept });
  console.log(`[UFC] ${guildId}: created event for "${card.name}".`);

  if (cfg.channel) {
    const channel = await client.channels.fetch(cfg.channel).catch(() => null);
    if (channel) await channel.send({ content: created.url, allowedMentions: { parse: [] } });
    else console.warn(`[UFC] ${guildId}: channel ${cfg.channel} is unreachable.`);
  }
}

async function syncOnce(client) {
  let cards;
  try {
    cards = await upcomingCards();
  } catch (err) {
    console.warn(`[UFC] ESPN lookup failed: ${err?.response?.status || ''} ${err?.message || err}`);
    return;
  }
  for (const guildId of guildIds()) {
    const cfg = getGuildConfig(guildId)?.ufc;
    const guild = cfg && client.guilds.cache.get(guildId);
    if (!guild || !cards.length) continue;
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageEvents)) {
      console.warn(`[UFC] ${guildId}: missing Manage Events — cannot post the card.`);
      continue;
    }
    for (const card of cards) {
      try {
        await syncCard(client, guild, cfg, card);
      } catch (err) {
        console.warn(`[UFC] ${guildId}: sync of "${card.name}" failed: ${err?.message || err}`);
      }
    }
  }
}

function scheduleUfcEvents(client) {
  const guilds = guildIds().filter((id) => getGuildConfig(id)?.ufc);
  if (!guilds.length) return;
  setInterval(() => { syncOnce(client).catch(() => {}); }, SYNC_HOURS * 3600 * 1000);
  syncOnce(client).catch(() => {});
  console.log(`[UFC] Posting weekly cards to ${guilds.length} guild(s), re-synced every ${SYNC_HOURS}h.`);
}

module.exports = { scheduleUfcEvents, syncOnce, upcomingCards, parseCard, describe, fightWeekStart };
