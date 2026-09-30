'use strict';
/**
 * The server's calendar: what is on it, how things get onto it, and the nudge
 * before each one starts.
 *
 * Launch dates used to be typed into config/guilds.json, so every new date and
 * every corrected time was a commit and a deploy — and the times were often
 * guesses waiting on a developer's announcement, so each correction was another
 * round of the same. Now anyone can put an event on with /event add or by
 * telling Sheogorath, and whoever added it, or an Owner, can move it or take it
 * off. What arrives that way lives in guild state. The events already in config
 * still count; a change to one of those is kept in state as an override, so
 * nobody has to open the file again. Config events belong to no one, so only an
 * Owner changes them.
 *
 * Every event becomes a Discord scheduled event, created once and kept in step
 * until it starts, keyed so a restart never makes a duplicate. One deleted by
 * hand in Discord stays deleted — unless somebody then edits it here, which is
 * somebody deciding they want it after all.
 *
 * The nudge covers every scheduled event in the server, these and the UFC cards
 * and any made by hand in Discord: fifteen minutes before it starts, the people
 * who clicked Interested are pinged by name in the events channel and a thread
 * is opened for the evening. Nobody interested, no post. A UFC card gets the
 * ping but not the thread, because pick'em already runs one.
 */
const axios = require('axios');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, GuildScheduledEventStatus, PermissionFlagsBits,
} = require('discord.js');
const { getGuildConfig, guildIds, hasFeature } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');
const { isAdmin } = require('../utils/permissions');
const { partsIn, zonedInstant, offsetLabel } = require('../utils/time');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long before an event its interested people hear about it. */
const REMIND_MINUTES = 15;

/** How often the clock is checked for events about to start. */
const REMIND_TICK_MINUTES = 2;

/** How far ahead an event may be put. Further than this is a typo, not a plan. */
const MAX_AHEAD_DAYS = 400;

/** How long an event runs when nobody says. */
const DEFAULT_HOURS = 3;

/** Reminder records are forgotten this long after they were sent. */
const FORGET_DAYS = 30;

/** How far ahead the calendar in his knowledge reaches, and how much of it he is shown. */
const CALENDAR_DAYS = 60;
const CALENDAR_MAX = 10;

/** Discord's list of events is re-read for his knowledge at most this often. */
const CALENDAR_TTL_MS = 5 * MINUTE_MS;

/** Mentions in one reminder, well inside Discord's 2000 characters. */
const MAX_PINGS = 80;

const unix = (ms) => Math.floor(ms / 1000);
const timeZoneOf = (guildId) => getGuildConfig(guildId)?.timeZone || 'America/Chicago';
const eventGuilds = () => guildIds().filter((id) => hasFeature(id, 'events') && getGuildConfig(id)?.gameNews?.eventsChannel);

// --- Reading "when" ---------------------------------------------------------

/** Zones people name at the end of a time, as the zones they mean. */
const ZONES = {
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', eastern: 'America/New_York',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mountain: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
  utc: 'UTC', gmt: 'UTC', z: 'UTC',
  bst: 'Europe/London', uk: 'Europe/London', cet: 'Europe/Paris', cest: 'Europe/Paris',
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const weekdayOf = (word) => (word.length >= 3 ? WEEKDAYS.findIndex((d) => d.startsWith(word)) : -1);
const monthOf = (word) => (word.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(word)) + 1 : 0);

function inRange(at, now) {
  if (Number.isNaN(at.getTime())) return { error: 'that is not a time I can read' };
  if (at.getTime() < now - 5 * MINUTE_MS) return { error: `<t:${unix(at.getTime())}:F> has already been` };
  if (at.getTime() > now + MAX_AHEAD_DAYS * DAY_MS) return { error: 'that is more than a year off' };
  return { at };
}

/** The date `days` after y-m-d, rolled over months and years. */
function plusDays(y, m, d, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * When something starts, from what people type.
 *
 * ISO times with their own offset ("2026-12-11T13:00-08:00"), dates and times
 * in the server's zone or a named one ("Dec 11 1pm PT", "2026-12-11 13:00 UTC",
 * "10/15 11am"), days of the week ("Friday 8pm", "next monday 9am", "tonight 9",
 * "tomorrow 7:30pm"), "in 2 hours" and "in 2 weeks". Always with a time of day:
 * an event with no time is a guess, and guesses are what this was built to stop.
 *
 * @returns {{ at: Date } | { error: string }}
 */
function parseWhen(text, timeZone, now = Date.now()) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'say when it starts' };

  // An ISO time carries its own offset and needs no help.
  const iso = /^(\d{4}-\d{2}-\d{2})[t ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(z|[+-]\d{2}:?\d{2})$/i.exec(raw);
  if (iso) {
    const offset = iso[3].toUpperCase() === 'Z' ? 'Z' : iso[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const clock = iso[2].length === 4 ? `0${iso[2]}` : iso[2];
    return inRange(new Date(`${iso[1]}T${clock}${offset}`), now);
  }

  let s = ` ${raw.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ')} `;
  let zone = timeZone;
  const named = / (et|est|edt|eastern|ct|cst|cdt|central|mt|mst|mdt|mountain|pt|pst|pdt|pacific|utc|gmt|z|bst|uk|cet|cest)(?: time)? $/.exec(s);
  if (named) {
    zone = ZONES[named[1]];
    s = `${s.slice(0, named.index)} `;
  }

  const relative = /^ in (\d+(?:\.\d+)?) ?(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w) $/.exec(s);
  if (relative) {
    const unit = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS, w: 7 * DAY_MS }[relative[2][0]];
    return inRange(new Date(now + Number(relative[1]) * unit), now);
  }

  // The time of day: the last thing in it that reads as one.
  const timeRe = / (?:(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)|(\d{1,2}):(\d{2})|(noon|midnight))(?= )/g;
  const found = [...s.matchAll(timeRe)].pop();
  let hour = null;
  let minute = 0;
  if (found) {
    if (found[6]) hour = found[6] === 'noon' ? 12 : 0;
    else if (found[3]) {
      const h = Number(found[1]);
      if (h < 1 || h > 12) return { error: `"${found[0].trim()}" is not a time of day` };
      hour = (h % 12) + (found[3].startsWith('p') ? 12 : 0);
      minute = Number(found[2] || 0);
    } else {
      hour = Number(found[4]);
      minute = Number(found[5]);
    }
    s = `${s.slice(0, found.index)} ${s.slice(found.index + found[0].length)}`;
  } else {
    // "tonight 9" means nine in the evening.
    const bare = / tonight(?: at)? (\d{1,2}) /.exec(s);
    if (bare && Number(bare[1]) >= 1 && Number(bare[1]) <= 11) {
      hour = Number(bare[1]) + 12;
      s = `${s.slice(0, bare.index)} tonight ${s.slice(bare.index + bare[0].length)}`;
    }
  }
  if (hour === null) return { error: 'say what time it starts, like 8pm or 20:00' };
  if (hour > 23 || minute > 59) return { error: 'that is not a time of day' };

  let rest = s.replace(/\b(at|on|the|of|this)\b/g, ' ').replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ').trim();
  // "friday oct 2": the weekday is decoration once there is a date.
  const lead = /^([a-z]+)\.? (.*\d.*)$/.exec(rest);
  if (lead && weekdayOf(lead[1]) >= 0) rest = lead[2];

  const today = partsIn(new Date(now), zone);
  let { year: y, month: m, day: d } = today;
  let yearGiven = false;
  let dateGiven = false;
  let weekday = -1;
  let next = false;
  let mm;
  if (rest === '' || rest === 'today' || rest === 'tonight') {
    // today, as is
  } else if (['tomorrow', 'tmrw', 'tmr'].includes(rest)) {
    ({ y, m, d } = plusDays(y, m, d, 1));
  } else if ((mm = /^(next )?([a-z]+)$/.exec(rest)) && weekdayOf(mm[2]) >= 0) {
    weekday = weekdayOf(mm[2]);
    next = !!mm[1];
  } else if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(rest))) {
    [y, m, d] = [+mm[1], +mm[2], +mm[3]];
    yearGiven = dateGiven = true;
  } else if ((mm = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(rest))) {
    [m, d] = [+mm[1], +mm[2]];
    if (mm[3]) {
      y = mm[3].length === 2 ? 2000 + +mm[3] : +mm[3];
      yearGiven = true;
    }
    dateGiven = true;
  } else if ((mm = /^([a-z]+)\.? (\d{1,2})(?: (\d{4}))?$/.exec(rest)) && monthOf(mm[1])) {
    [m, d] = [monthOf(mm[1]), +mm[2]];
    if (mm[3]) [y, yearGiven] = [+mm[3], true];
    dateGiven = true;
  } else if ((mm = /^(\d{1,2}) ([a-z]+)\.?(?: (\d{4}))?$/.exec(rest)) && monthOf(mm[2])) {
    [m, d] = [monthOf(mm[2]), +mm[1]];
    if (mm[3]) [y, yearGiven] = [+mm[3], true];
    dateGiven = true;
  } else {
    return { error: `I can't read "${raw}" as a time. Try "Friday 8pm", "Dec 11 1pm PT" or "2026-12-11 13:00"` };
  }

  const at = (yy, mo, dd) => zonedInstant(yy, mo, dd, hour, minute, zone);

  if (weekday >= 0) {
    let ahead = (weekday - today.weekday + 7) % 7;
    if (ahead === 0 && next) ahead = 7;
    let day = plusDays(y, m, d, ahead);
    if (at(day.y, day.m, day.d) < now) day = plusDays(day.y, day.m, day.d, 7);
    return inRange(new Date(at(day.y, day.m, day.d)), now);
  }

  let when = at(y, m, d);
  if (when === null) return { error: `${m}/${d} is not a date` };
  // A date with no year that has already gone this year means next year's.
  if (dateGiven && !yearGiven && when < now - HOUR_MS) when = at(y + 1, m, d);
  if (when === null) return { error: `${m}/${d} is not a date` };
  if (!dateGiven && when < now - 5 * MINUTE_MS) {
    return { error: `<t:${unix(when)}:t> has already gone today — say which day` };
  }
  return inRange(new Date(when), now);
}

// --- What is on the calendar -------------------------------------------------

function stateOf(guildId) {
  const saved = getGuildState(guildId).calendar || {};
  return { events: saved.events || {}, reminded: saved.reminded || {} };
}

/** Read, change and write the calendar in one synchronous pass. `change` must not await. */
function mutate(guildId, change) {
  const record = stateOf(guildId);
  const result = change(record);
  const cutoff = Date.now() - FORGET_DAYS * DAY_MS;
  for (const [id, at] of Object.entries(record.reminded)) if (at < cutoff) delete record.reminded[id];
  for (const [key, rec] of Object.entries(record.events)) {
    if (!rec.removed && Date.parse(rec.start) < cutoff) delete record.events[key];
  }
  setGuildState(guildId, { calendar: record });
  return result;
}

/** A stored record in the shape the sync works with, laid over the config event it replaces. */
function fromRecord(rec, base) {
  const start = new Date(rec.start);
  if (Number.isNaN(start.getTime()) || !rec.name) return null;
  const hours = Number(rec.hours) > 0 ? Number(rec.hours) : DEFAULT_HOURS;
  return {
    key: rec.key,
    name: String(rec.name).slice(0, 100),
    description: rec.description ?? base?.description ?? null,
    start,
    end: new Date(start.getTime() + hours * HOUR_MS),
    hours,
    location: rec.voiceChannel ? null : (rec.location || 'Online'),
    voiceChannel: rec.voiceChannel || null,
    appId: rec.appId ?? base?.appId ?? null,
    image: rec.image ?? base?.image ?? null,
    by: rec.by || null,
    fromConfig: !!base?.fromConfig,
  };
}

/**
 * Every event on the calendar, soonest first: config's list, with anything
 * stored laid over it — an override replaces its config event, a removal hides
 * it, and events added in Discord join them.
 */
function eventsFor(guildId) {
  const out = new Map();
  for (const ev of getGuildConfig(guildId)?.gameNews?.events || []) {
    out.set(ev.key, {
      ...ev,
      hours: (ev.end.getTime() - ev.start.getTime()) / HOUR_MS,
      by: null,
      fromConfig: true,
    });
  }
  for (const rec of Object.values(stateOf(guildId).events)) {
    if (rec.removed) {
      out.delete(rec.key);
      continue;
    }
    const ev = fromRecord(rec, out.get(rec.key));
    if (ev) out.set(rec.key, ev);
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

/**
 * An upcoming event by key, or by name as people say it: exactly, then as the
 * only one whose name contains what was said. Null when that is none or several.
 */
function findEvent(guildId, query, now = Date.now()) {
  const upcoming = eventsFor(guildId).filter((e) => e.start.getTime() > now);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const exact = upcoming.find((e) => e.key === query || e.name.toLowerCase() === q);
  if (exact) return exact;
  const near = upcoming.filter((e) => e.name.toLowerCase().includes(q));
  return near.length === 1 ? near[0] : null;
}

/** Whether `member` may move or remove `ev`: whoever added it, or an Owner. */
const canManage = (member, ev) => isAdmin(member) || (!!ev.by && ev.by === member?.id);

// --- Keeping Discord in step ----------------------------------------------------

/**
 * An event's cover, as a Buffer, or null: its own `image` if it has one (a game
 * not on Steam), otherwise its Steam game's header art. The Steam address comes
 * from the store API because newer games keep their art under a hashed path that
 * cannot be guessed from the app id.
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
    console.warn(`[Events] ${guildId}: no cover art for "${ev.name}": ${err?.message || err}`);
    return null;
  }
}

/** What Discord is told. The entity type travels too, so an event can move into voice and back. */
function eventFields(ev) {
  const base = { name: ev.name, description: ev.description || undefined, scheduledStartTime: ev.start };
  if (ev.voiceChannel) return { ...base, entityType: GuildScheduledEventEntityType.Voice, channel: ev.voiceChannel };
  return {
    ...base,
    entityType: GuildScheduledEventEntityType.External,
    channel: null,
    scheduledEndTime: ev.end,
    entityMetadata: { location: ev.location || 'Online' },
  };
}

/**
 * Create or update the Discord event for one calendar event, before it starts.
 *
 * @returns {Promise<import('discord.js').GuildScheduledEvent|null>} the event,
 *   or null when it has been deleted by hand, has started, or cannot be made.
 */
async function syncEvent(client, guild, cfg, ev) {
  const guildId = guild.id;
  if (ev.start.getTime() <= Date.now()) return null;
  const links = getGuildState(guildId).gameEvents || {};
  const fields = eventFields(ev);

  if (links[ev.key]) {
    const existing = await guild.scheduledEvents.fetch(links[ev.key].eventId).catch(() => null);
    if (!existing) return null;   // deleted by hand; leave it deleted
    const changed = existing.name !== fields.name
      || (existing.description || '') !== (fields.description || '')
      || existing.scheduledStartTimestamp !== fields.scheduledStartTime.getTime()
      || existing.entityType !== fields.entityType
      || (fields.channel ? existing.channelId !== fields.channel
        : existing.scheduledEndTimestamp !== fields.scheduledEndTime.getTime()
          || existing.entityMetadata?.location !== fields.entityMetadata.location);
    // A missing cover is looked for again on every sync until one turns up.
    const image = existing.image ? null : await coverArt(ev, guildId);
    if (!changed && !image) return existing;
    const edited = await existing.edit(image ? { ...fields, image } : fields);
    console.log(`[Events] ${guildId}: updated "${ev.name}"${image ? ' with its cover' : ''}.`);
    return edited;
  }

  const image = await coverArt(ev, guildId);
  const created = await guild.scheduledEvents.create({
    ...fields,
    ...(image ? { image } : {}),
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
  });
  // Forget links a month gone, so the record never grows.
  const cutoff = Date.now() - FORGET_DAYS * DAY_MS;
  const kept = Object.fromEntries(Object.entries(getGuildState(guildId).gameEvents || {}).filter(([, v]) => v.start > cutoff));
  kept[ev.key] = { eventId: created.id, start: ev.start.getTime() };
  setGuildState(guildId, { gameEvents: kept });
  console.log(`[Events] ${guildId}: created "${ev.name}".`);

  const channel = await client.channels.fetch(cfg.eventsChannel).catch(() => null);
  if (channel) {
    await channel.send({
      content: ev.by ? `${created.url}\n-# Put on the calendar by <@${ev.by}>` : created.url,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  } else {
    console.warn(`[Events] ${guildId}: events channel ${cfg.eventsChannel} is unreachable.`);
  }
  return created;
}

/** Every upcoming event, kept in step. Called from the game news poll. */
async function syncEvents(client, guild, cfg) {
  const due = eventsFor(guild.id).filter((ev) => ev.start.getTime() > Date.now());
  if (!due.length) return;
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageEvents)) {
    console.warn(`[Events] ${guild.id}: missing Manage Events — cannot schedule ${due.length} event(s).`);
    return;
  }
  for (const ev of due) {
    await syncEvent(client, guild, cfg, ev).catch((err) =>
      console.warn(`[Events] ${guild.id}: "${ev.name}" failed: ${err?.message || err}`));
  }
}

// --- Adding, moving and removing -------------------------------------------------

/** A voice channel in this guild by id, mention or name, or null. */
function voiceChannelIn(guild, ref) {
  const want = String(ref || '').trim().replace(/^<#(\d+)>$/, '$1').replace(/^#/, '').toLowerCase();
  if (!want) return null;
  const voice = (c) => c?.type === ChannelType.GuildVoice;
  const byId = guild.channels.cache.get(want);
  if (voice(byId)) return byId;
  return guild.channels.cache.find((c) => voice(c) && c.name.toLowerCase() === want) || null;
}

/** The calendar changed: his view of it is stale. */
function forget(guildId) {
  calendarCache.delete(guildId);
}

function gameNewsOf(guild) {
  const cfg = getGuildConfig(guild.id)?.gameNews;
  if (!cfg?.eventsChannel) throw new Error('this server has no events channel set up');
  return cfg;
}

/**
 * Put an event on the calendar and on Discord.
 *
 * @param {object} input { name, when, hours?, voice?, where?, appId?, about? }
 * @param {import('discord.js').GuildMember} member who is adding it
 * @returns {Promise<{ ev: object, discordEvent: object|null }>}
 * @throws {Error} with a message fit to show the person who asked
 */
async function addEvent(client, guild, input, member) {
  const cfg = gameNewsOf(guild);
  const name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!name) throw new Error('an event needs a name');
  const when = parseWhen(input.when, timeZoneOf(guild.id));
  if (when.error) throw new Error(when.error);
  if (findEvent(guild.id, name)?.name.toLowerCase() === name.toLowerCase()) {
    throw new Error(`"${name}" is already on the calendar — change that one instead`);
  }
  // `where` naming a voice channel means the event is held there.
  const voice = input.voice ? voiceChannelIn(guild, input.voice) : voiceChannelIn(guild, input.where);
  if (input.voice && !voice) throw new Error(`there is no voice channel called "${input.voice}"`);

  const rec = {
    key: `ev-${Date.now().toString(36)}`,
    name,
    start: when.at.toISOString(),
    hours: Math.min(24, Math.max(0.5, Number(input.hours) || DEFAULT_HOURS)),
    location: voice ? null : (String(input.where || '').trim().slice(0, 100) || null),
    voiceChannel: voice?.id || null,
    appId: /^\d+$/.test(String(input.appId || '')) ? String(input.appId) : null,
    description: input.about ? String(input.about).trim().slice(0, 1000) : null,
    by: member.id,
    at: new Date().toISOString(),
  };
  mutate(guild.id, (record) => { record.events[rec.key] = rec; });
  forget(guild.id);
  const ev = eventsFor(guild.id).find((e) => e.key === rec.key);
  const discordEvent = await syncEvent(client, guild, cfg, ev);
  return { ev, discordEvent };
}

/**
 * Change an event that has not started. Only the fields given change.
 *
 * @param {object} changes { name?, when?, hours?, voice?, where?, about? }
 * @throws {Error} with a message fit to show the person who asked
 */
async function editEvent(client, guild, key, changes, member) {
  const cfg = gameNewsOf(guild);
  const ev = eventsFor(guild.id).find((e) => e.key === key);
  if (!ev) throw new Error('that event is not on the calendar');
  if (ev.start.getTime() <= Date.now()) throw new Error(`"${ev.name}" has already started, and Discord will not move an event under way`);
  if (!canManage(member, ev)) {
    throw new Error(ev.by
      ? `"${ev.name}" is <@${ev.by}>'s to change, or an Owner's`
      : `"${ev.name}" is one of the listed launches, which only an Owner can change`);
  }

  let start = ev.start;
  if (changes.when) {
    const when = parseWhen(changes.when, timeZoneOf(guild.id));
    if (when.error) throw new Error(when.error);
    start = when.at;
  }
  let { voiceChannel, location } = ev;
  if (changes.voice) {
    const voice = voiceChannelIn(guild, changes.voice);
    if (!voice) throw new Error(`there is no voice channel called "${changes.voice}"`);
    [voiceChannel, location] = [voice.id, null];
  } else if (changes.where) {
    const voice = voiceChannelIn(guild, changes.where);
    [voiceChannel, location] = voice ? [voice.id, null] : [null, String(changes.where).trim().slice(0, 100)];
  }

  const rec = {
    key: ev.key,
    name: changes.name ? String(changes.name).replace(/\s+/g, ' ').trim().slice(0, 100) : ev.name,
    start: start.toISOString(),
    hours: changes.hours ? Math.min(24, Math.max(0.5, Number(changes.hours))) : ev.hours,
    location,
    voiceChannel,
    appId: ev.appId,
    image: ev.image,
    description: changes.about !== undefined && changes.about !== null ? String(changes.about).trim().slice(0, 1000) : ev.description,
    by: ev.by,
    editedBy: member.id,
    at: new Date().toISOString(),
  };
  mutate(guild.id, (record) => { record.events[ev.key] = rec; });
  forget(guild.id);

  // An edit brings back an event somebody deleted by hand in Discord: this is
  // somebody deciding they want it after all.
  const link = (getGuildState(guild.id).gameEvents || {})[ev.key];
  if (link && !(await guild.scheduledEvents.fetch(link.eventId).catch(() => null))) {
    const links = { ...getGuildState(guild.id).gameEvents };
    delete links[ev.key];
    setGuildState(guild.id, { gameEvents: links });
  }

  const updated = eventsFor(guild.id).find((e) => e.key === ev.key);
  const discordEvent = await syncEvent(client, guild, cfg, updated);
  if (updated.start.getTime() !== ev.start.getTime()) {
    const channel = await client.channels.fetch(cfg.eventsChannel).catch(() => null);
    await channel?.send({
      content: `🗓️ **${updated.name}** now starts <t:${unix(updated.start.getTime())}:F> (<t:${unix(updated.start.getTime())}:R>)`
        + `\n-# Moved by <@${member.id}>`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  return { ev: updated, discordEvent };
}

/**
 * Take an event off the calendar and off Discord.
 * @throws {Error} with a message fit to show the person who asked
 */
async function removeEvent(client, guild, key, member) {
  const ev = eventsFor(guild.id).find((e) => e.key === key);
  if (!ev) throw new Error('that event is not on the calendar');
  if (!canManage(member, ev)) {
    throw new Error(ev.by
      ? `"${ev.name}" is <@${ev.by}>'s to remove, or an Owner's`
      : `"${ev.name}" is one of the listed launches, which only an Owner can remove`);
  }
  const links = { ...(getGuildState(guild.id).gameEvents || {}) };
  if (links[key]) {
    await guild.scheduledEvents.delete(links[key].eventId).catch(() => {});
    delete links[key];
    setGuildState(guild.id, { gameEvents: links });
  }
  mutate(guild.id, (record) => {
    if (ev.fromConfig) record.events[key] = { key, removed: true, by: member.id, at: new Date().toISOString() };
    else delete record.events[key];
  });
  forget(guild.id);
  return ev;
}

// --- What he knows, and what /event list shows ---------------------------------

/** guildId -> { at, events } */
const calendarCache = new Map();

async function scheduledEventsOf(guild, { fresh = false } = {}) {
  const hit = calendarCache.get(guild.id);
  if (!fresh && hit && Date.now() - hit.at < CALENDAR_TTL_MS) return hit.events;
  const events = await guild.scheduledEvents.fetch();
  calendarCache.set(guild.id, { at: Date.now(), events });
  return events;
}

const live = (e) => e.status === GuildScheduledEventStatus.Scheduled || e.status === GuildScheduledEventStatus.Active;

function upcomingOf(events, now, days = CALENDAR_DAYS) {
  return [...events.values()]
    .filter((e) => live(e) && e.scheduledStartTimestamp < now + days * DAY_MS)
    .sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp);
}

/**
 * The clock, and what is on the calendar, for his knowledge block.
 *
 * He was never told the date. Asked when something was, he could only guess, and
 * asked to put something on "Friday" he could not have known which Friday. Both
 * are measured here rather than remembered, like the rest of what he knows.
 */
async function calendarFacts(guild, now = Date.now()) {
  const tz = timeZoneOf(guild.id);
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(now));
  const lines = [`It is now ${clock} in ${tz} (${offsetLabel(now, tz)}), which is ${new Date(now).toISOString()}.`];

  const soon = upcomingOf(await scheduledEventsOf(guild), now).slice(0, CALENDAR_MAX);
  if (!soon.length) {
    lines.push('Nothing is on the server calendar.');
    return lines;
  }
  const at = (ms) => new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));
  lines.push('On the server calendar, soonest first (times in the server\'s zone, then UTC):');
  for (const e of soon) {
    const start = e.scheduledStartTimestamp;
    lines.push(`• ${e.name} — ${at(start)} (${new Date(start).toISOString().slice(0, 16)}Z)`
      + `${e.status === GuildScheduledEventStatus.Active ? ' · happening now' : ''}`
      + `${e.userCount ? ` · ${e.userCount} interested` : ''}`);
  }
  return lines;
}

/** The public list for /event list. */
async function listEmbed(guild, now = Date.now()) {
  const soon = upcomingOf(await scheduledEventsOf(guild, { fresh: true }), now, MAX_AHEAD_DAYS).slice(0, 15);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🗓️ Coming up');
  if (!soon.length) return embed.setDescription('Nothing is on the calendar. `/event add` puts something on it.');
  return embed.setDescription(soon.map((e) => {
    const start = unix(e.scheduledStartTimestamp);
    const where = e.channelId ? ` · <#${e.channelId}>` : '';
    const state = e.status === GuildScheduledEventStatus.Active ? ' · **on now**' : '';
    return `**[${e.name}](${e.url})** — <t:${start}:F> (<t:${start}:R>)${where}${state}`
      + `${e.userCount ? ` · ${e.userCount} interested` : ''}`;
  }).join('\n').slice(0, 4096));
}

// --- The nudge --------------------------------------------------------------------

const isUfcCard = (guildId, eventId) =>
  Object.values(getGuildState(guildId).ufcEvents || {}).some((v) => v.eventId === eventId);

/**
 * Ping the people who said they were interested, and open a thread for it.
 * Returns the message, or null when nobody had said so.
 */
async function remind(client, guild, event, channelId) {
  const subscribers = await event.fetchSubscribers({ limit: 100 });
  const people = [...subscribers.values()].map((s) => s.user).filter((u) => u && !u.bot);
  if (!people.length) return null;

  const channel = await client.channels.fetch(channelId);
  const pinged = people.slice(0, MAX_PINGS);
  const where = event.channelId ? ` · 🔊 <#${event.channelId}>`
    : event.entityMetadata?.location ? ` · 📍 ${event.entityMetadata.location}` : '';
  const message = await channel.send({
    content: `🔔 **${event.name}** starts <t:${unix(event.scheduledStartTimestamp)}:R>${where}\n`
      + `${pinged.map((u) => `<@${u.id}>`).join(' ')}${people.length > MAX_PINGS ? ` and ${people.length - MAX_PINGS} more` : ''}`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(event.url).setLabel('The event'),
    )],
    // The people who asked to hear about it, and nobody else.
    allowedMentions: { users: pinged.map((u) => u.id) },
  });
  if (!isUfcCard(guild.id, event.id)) {
    await message.startThread({ name: event.name.slice(0, 100), autoArchiveDuration: 1440 }).catch((err) =>
      console.warn(`[Events] ${guild.id}: no thread for "${event.name}": ${err.message}`));
  }
  console.log(`[Events] ${guild.id}: reminded ${people.length} about "${event.name}".`);
  return message;
}

let reminding = false;

/** Every event starting within the next fifteen minutes, reminded once. */
async function remindOnce(client, now = Date.now()) {
  if (reminding) return;
  reminding = true;
  try {
    for (const guildId of eventGuilds()) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      let events;
      try {
        events = await scheduledEventsOf(guild, { fresh: true });
      } catch (err) {
        console.warn(`[Events] ${guildId}: could not read the calendar: ${err?.message || err}`);
        continue;
      }
      for (const event of events.values()) {
        const start = event.scheduledStartTimestamp;
        if (!live(event) || now < start - REMIND_MINUTES * MINUTE_MS || now > start + 5 * MINUTE_MS) continue;
        if (stateOf(guildId).reminded[event.id]) continue;
        // Marked before it is sent: a reminder lost to an outage stays lost,
        // which beats the same ping twice.
        mutate(guildId, (record) => { record.reminded[event.id] = now; });
        await remind(client, guild, event, getGuildConfig(guildId).gameNews.eventsChannel).catch((err) =>
          console.warn(`[Events] ${guildId}: reminder for "${event.name}" failed: ${err?.message || err}`));
      }
    }
  } finally {
    reminding = false;
  }
}

function scheduleEvents(client) {
  const guilds = eventGuilds();
  if (!guilds.length) return;
  setInterval(() => { remindOnce(client).catch(() => {}); }, REMIND_TICK_MINUTES * MINUTE_MS);
  remindOnce(client).catch(() => {});
  console.log(`[Events] Reminding ${guilds.length} guild(s) ${REMIND_MINUTES} minutes before each event.`);
}

module.exports = {
  scheduleEvents,
  syncEvents,
  addEvent,
  editEvent,
  removeEvent,
  eventsFor,
  findEvent,
  canManage,
  calendarFacts,
  listEmbed,
  parseWhen,
  DEFAULT_HOURS,
  // For tests.
  syncEvent,
  remindOnce,
  eventFields,
  stateOf,
};
