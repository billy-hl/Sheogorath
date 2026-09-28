'use strict';
/**
 * On this day: the best thing said in the hall on this date, in years gone by.
 *
 * The hall is nine years old, and nothing else the bot does reaches that far
 * back. Each morning this looks at today's date in every earlier year, finds the
 * message the room made the most of, and posts it again with a jump link and a
 * line from Sheogorath — along with anyone whose anniversary in the hall falls
 * today.
 *
 * Reaching a date is cheap because a Discord message id is a timestamp. The id
 * for midnight on a given day can be computed, and "the messages after it" is
 * one request per channel, paged forward only on a busy day. There is no search
 * API for bots; there does not need to be.
 *
 * What it will not dig up:
 *
 *   Anything from a channel the whole server cannot see. A staff room or a
 *   private channel is somewhere people spoke expecting only those people to
 *   hear, however funny it was.
 *
 *   Anything by somebody who has opted out with /onthisday opt-out, or who has
 *   since left. Somebody who walked out did not agree to be quoted back.
 *
 *   Bots, this one included.
 *
 *   The same message twice. What the daily post has shown is remembered, so the
 *   best 15 November does not win every 15 November for ever.
 *
 * "Best" is reactions, plus replies from other people that same day, and it has
 * to clear a floor. A date where nothing did is left alone rather than filled
 * with something nobody cared about the first time.
 */
const axios = require('axios');
const {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits,
} = require('discord.js');
const { getGuildConfig, guildIds, hasFeature } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');
const { getAIResponse } = require('../ai/grok');
const { conversationalPersona } = require('../ai/persona');
const { scrub } = require('../ai/actions');
const { partsIn, midnight } = require('../utils/time');

const PARCHMENT = 0xd4b483;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DISCORD_EPOCH = 1420070400000n;

/** How often the clock is checked. The post goes out on the first check inside its window. */
const TICK_MINUTES = 10;

/**
 * How long after the configured hour the day's post may still go out. A bot
 * that was down all morning posts late rather than never; one restarted at
 * eleven at night leaves it for tomorrow instead of posting a memory at bedtime.
 */
const WINDOW_HOURS = 3;

/** Pages of a hundred read per channel per day. A thousand messages is a very busy day. */
const MAX_PAGES = 10;

/** How long a date's candidates are kept, so /onthisday show does not re-read them. */
const CACHE_MS = 6 * HOUR_MS;

/** How many candidates' authors are checked for still being here before giving up. */
const MEMBER_CHECKS = 25;

/** How many shown messages are remembered: years of daily posts. */
const REMEMBER = 3000;

/** Images larger than this are left on the original rather than uploaded again. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const configFor = (guildId) => getGuildConfig(guildId)?.onThisDay || null;
const activeGuilds = () => guildIds().filter((id) => hasFeature(id, 'onthisday') && configFor(id)?.channel);
const pad = (n) => String(n).padStart(2, '0');
const dateName = (month, day, year) => `${day} ${MONTHS[month - 1]}${year ? ` ${year}` : ''}`;

// --- Time -------------------------------------------------------------------

/** The start and end of a date in `timeZone`, or null if that year does not have it. */
function dayBounds(year, month, day, timeZone) {
  const start = midnight(year, month, day, timeZone);
  if (start === null) return null;
  const next = new Date(Date.UTC(year, month - 1, day + 1, 12));
  return { start, end: midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone) };
}

/** The lowest message id Discord could have given out at `ms`. */
const snowflakeAt = (ms) => String((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n);

/**
 * A month and day from what people type: 11-15, 11/15, Nov 15, 15 November.
 * Month first when it is all numbers.
 */
function parseMonthDay(text) {
  const s = String(text || '').trim().toLowerCase().replace(/,/g, '');
  const monthOf = (word) => MONTHS.findIndex((m) => m.toLowerCase().startsWith(word.slice(0, 3))) + 1;
  let month = 0;
  let day = 0;
  let m;
  if ((m = /^(\d{1,2})\s*[-/.]\s*(\d{1,2})$/.exec(s))) [month, day] = [+m[1], +m[2]];
  else if ((m = /^([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(s))) [month, day] = [monthOf(m[1]), +m[2]];
  else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\.?$/.exec(s))) [month, day] = [monthOf(m[2]), +m[1]];
  if (month < 1 || month > 12 || day < 1) return null;
  // 2024 was a leap year, so 29 February is a date that can be asked about.
  if (day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return null;
  return { month, day };
}

// --- The stored record ------------------------------------------------------

function stateOf(guildId) {
  const saved = getGuildState(guildId).onThisDay || {};
  return { lastRun: saved.lastRun || null, shown: saved.shown || [], optedOut: saved.optedOut || [] };
}

function mutate(guildId, change) {
  const record = stateOf(guildId);
  const result = change(record);
  setGuildState(guildId, { onThisDay: record });
  return result;
}

/** Opt somebody out, or back in. Returns whether that changed anything. */
function setOptOut(guildId, userId, out) {
  return mutate(guildId, (record) => {
    const was = record.optedOut.includes(userId);
    record.optedOut = out
      ? [...new Set([...record.optedOut, userId])]
      : record.optedOut.filter((id) => id !== userId);
    return was !== out;
  });
}

// --- Reading the past -------------------------------------------------------

/**
 * The rooms worth digging in: text channels the whole server can read.
 *
 * "The whole server" is @everyone, or the member role where a guild keeps its
 * channels behind one. `onThisDay.sources` replaces the search outright, for a
 * guild that would rather name its rooms.
 */
async function sourceChannels(guild, cfg) {
  const all = await guild.channels.fetch();
  const readable = (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
  if (cfg.sources?.length) return cfg.sources.map((id) => all.get(id)).filter(readable);

  const memberRole = getGuildConfig(guild.id)?.roles?.member;
  const audiences = [guild.roles.everyone, memberRole && guild.roles.cache.get(memberRole)].filter(Boolean);
  return [...all.values()].filter((c) => readable(c)
    && !c.nsfw
    && !cfg.exclude.includes(c.id)
    && audiences.some((role) => c.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel)));
}

/** Every message in `channel` from `start` up to `end`, oldest first. */
async function messagesBetween(channel, start, end) {
  const out = [];
  let after = snowflakeAt(start - 1);
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await channel.messages.fetch({ after, limit: 100, cache: false });
    if (!batch.size) break;
    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    out.push(...sorted.filter((m) => m.createdTimestamp >= start && m.createdTimestamp < end));
    const last = sorted[sorted.length - 1];
    if (batch.size < 100 || last.createdTimestamp >= end) break;
    after = last.id;
  }
  return out;
}

const imageOf = (m) => m.attachments.find((a) => a.contentType?.startsWith('image/') && !a.spoiler);
const nameOf = (m) => m.member?.displayName || m.author?.globalName || m.author?.username || 'someone';

/** Somebody saying or showing something. System notices, bots and bare stickers are not. */
function showable(m) {
  if (!m.author || m.author.bot || m.system) return false;
  return !!m.content?.trim() || m.attachments.size > 0 || m.embeds.some((e) => e.image || e.thumbnail);
}

/** One day of one room, scored: reactions, plus replies from other people that day. */
function scoreDay(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const replies = new Map();
  for (const m of messages) {
    const target = byId.get(m.reference?.messageId);
    if (target && target.author?.id !== m.author?.id) replies.set(target.id, (replies.get(target.id) || 0) + 1);
  }
  return messages.filter(showable).map((m) => {
    // His own reaction is not the room's.
    const reactions = [...m.reactions.cache.values()].reduce((n, r) => n + r.count - (r.me ? 1 : 0), 0);
    const answered = replies.get(m.id) || 0;
    return { message: m, reactions, replies: answered, score: reactions + answered, replyTo: byId.get(m.reference?.messageId) || null };
  });
}

/** Most made-of first; then a picture over words alone; then the older, which has further to travel. */
const byMerit = (a, b) => b.score - a.score
  || Number(!!imageOf(b.message)) - Number(!!imageOf(a.message))
  || a.message.createdTimestamp - b.message.createdTimestamp;

/** guildId:month-day:latestYear -> { at, candidates } */
const dayCache = new Map();

/**
 * Everything that cleared the floor on this date, from `latestYear` back to the
 * year the guild was made, best first. Held for a few hours: a date's history
 * does not change, and reading it is the only expensive part of any of this.
 */
async function candidatesOn(guild, cfg, month, day, latestYear) {
  const key = `${guild.id}:${month}-${day}:${latestYear}`;
  const hit = dayCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.candidates;

  const channels = await sourceChannels(guild, cfg);
  const firstYear = partsIn(new Date(guild.createdTimestamp), cfg.timeZone).year;
  const candidates = [];
  for (let year = latestYear; year >= firstYear; year--) {
    const bounds = dayBounds(year, month, day, cfg.timeZone);
    if (!bounds) continue;
    for (const channel of channels) {
      if (channel.createdTimestamp >= bounds.end) continue;
      try {
        for (const c of scoreDay(await messagesBetween(channel, bounds.start, bounds.end))) {
          if (c.score >= cfg.minScore) candidates.push({ ...c, year, channel });
        }
      } catch (err) {
        // No access is the usual reason, and it is not worth a warning every morning.
        if (err?.code !== 50001 && err?.code !== 50013) {
          console.warn(`[OnThisDay] ${guild.id}: could not read #${channel.name} for ${year}: ${err?.message || err}`);
        }
      }
    }
  }
  candidates.sort(byMerit);

  dayCache.set(key, { at: Date.now(), candidates });
  if (dayCache.size > 20) dayCache.delete(dayCache.keys().next().value);
  return candidates;
}

/**
 * The best candidate that may be shown: not opted out, not shown before (for
 * the daily post), and — unless the guild says otherwise — by somebody still
 * here. Null when nothing qualifies.
 */
async function pickFor(guild, { month, day, latestYear, skipShown }) {
  const cfg = configFor(guild.id);
  const { optedOut, shown } = stateOf(guild.id);
  let checked = 0;
  for (const c of await candidatesOn(guild, cfg, month, day, latestYear)) {
    const authorId = c.message.author.id;
    if (optedOut.includes(authorId) || (skipShown && shown.includes(c.message.id))) continue;
    if (checked++ >= MEMBER_CHECKS) break;
    const member = await guild.members.fetch(authorId).catch(() => null);
    if (member || cfg.includeLeft) return { ...c, member };
  }
  return null;
}

/** Members whose anniversary in the hall is this date, longest-standing first. */
async function anniversariesOn(guild, { month, day, year }, timeZone, optedOut) {
  const members = await guild.members.list({ limit: 1000 }).catch(() => null);
  if (!members) return [];
  return [...members.values()]
    .filter((m) => !m.user.bot && m.joinedTimestamp && !optedOut.includes(m.id))
    .map((m) => ({ member: m, joined: partsIn(new Date(m.joinedTimestamp), timeZone) }))
    .filter(({ joined }) => joined.month === month && joined.day === day && joined.year < year)
    .map(({ member, joined }) => ({ member, years: year - joined.year }))
    .sort((a, b) => b.years - a.years);
}

// --- Saying it --------------------------------------------------------------

/** His line on the memory. The one model call, and the one part that can go missing. */
async function lineFor(pick, when) {
  const m = pick.message;
  const said = m.content?.trim() ? `"${m.content.trim().slice(0, 500)}"` : 'nothing in words';
  const extras = [imageOf(m) && 'with a picture', m.attachments.some((a) => a.contentType?.startsWith('video/')) && 'with a clip']
    .filter(Boolean).join(' and ');
  const answering = pick.replyTo?.content ? `, answering ${nameOf(pick.replyTo)}'s "${pick.replyTo.content.slice(0, 200)}"` : '';
  const prompt = `${when}, in #${pick.channel.name}, ${pick.member?.displayName || nameOf(m)} said ${said}${extras ? ` ${extras}` : ''}`
    + `${answering}. The room made a fuss of it: ${pick.reactions} reaction(s) and ${pick.replies} repl${pick.replies === 1 ? 'y' : 'ies'}. `
    + 'In one short sentence, in character, react as if you remember the day it was said. '
    + 'Do not repeat the message. No @ mentions, no action tags.';
  const text = await getAIResponse(prompt, { rawSystemPrompt: conversationalPersona(), maxTokens: 90 });
  return scrub(text || '').replace(/[ \t]{2,}/g, ' ').trim() || null;
}

/** The reactions as the room left them, minus his own. */
function reactionLine(pick) {
  const parts = [...pick.message.reactions.cache.values()]
    .map((r) => ({ emoji: r.emoji.toString(), count: r.count - (r.me ? 1 : 0) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((r) => `${r.emoji} ${r.count}`);
  if (pick.replies) parts.push(`💬 ${pick.replies} repl${pick.replies === 1 ? 'y' : 'ies'}`);
  return parts.join(' · ');
}

/**
 * The original picture, uploaded again. Attachment links Discord hands out
 * expire within a day, and an embed pointing at one would go blank by tomorrow.
 */
async function reupload(attachment) {
  if (attachment.size > MAX_IMAGE_BYTES) return null;
  try {
    const res = await axios.get(attachment.url, { responseType: 'arraybuffer', timeout: 20000 });
    const ext = (/\.[a-z0-9]{1,5}$/i.exec(attachment.name || '')?.[0] || '.png').toLowerCase();
    return new AttachmentBuilder(Buffer.from(res.data), { name: `memory${ext}` });
  } catch {
    return null;
  }
}

/**
 * The post: his line, the memory, and the anniversaries. Everything in it is
 * shown, and none of it pings — a memory is not a summons.
 */
async function render(pick, { heading, line = null, anniversaries = [], hallYears = 0 }) {
  const embeds = [];
  const files = [];
  const components = [];

  if (pick) {
    const m = pick.message;
    const quote = pick.replyTo
      ? `> **${nameOf(pick.replyTo)}:** ${(pick.replyTo.content || '…').replace(/\s+/g, ' ').slice(0, 200)}\n`
      : '';
    const notes = [];
    let image = null;
    const picture = imageOf(m);
    if (picture) {
      const file = await reupload(picture);
      if (file) {
        files.push(file);
        image = `attachment://${file.name}`;
      } else notes.push('🖼️ It came with a picture — jump to it to see.');
    } else {
      // A link that unfurled into a picture (a gif, mostly) keeps its picture.
      image = m.embeds.map((e) => e.image?.url || e.thumbnail?.url).find(Boolean) || null;
    }
    if (m.attachments.some((a) => a.contentType?.startsWith('video/'))) notes.push('🎞️ It came with a clip — jump to it to watch.');
    else if (m.attachments.some((a) => a !== picture && !a.contentType?.startsWith('image/'))) notes.push('📎 It came with a file.');

    const body = [quote + (m.content?.trim() || '').slice(0, 1800), notes.length ? `*${notes.join(' ')}*` : '']
      .filter(Boolean).join('\n\n');
    const embed = new EmbedBuilder()
      .setColor(PARCHMENT)
      .setAuthor({
        name: pick.member?.displayName || nameOf(m),
        iconURL: (pick.member || m.author).displayAvatarURL({ size: 64 }),
        url: m.url,
      })
      .setTitle(heading)
      .setDescription(body || '*…*')
      .setFooter({ text: `#${pick.channel.name}` })
      .setTimestamp(m.createdAt);
    if (image) embed.setImage(image);
    const room = reactionLine(pick);
    if (room) embed.addFields({ name: 'The room', value: room.slice(0, 1024) });
    embeds.push(embed);
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(m.url).setLabel('Jump to it'),
    ));
  }

  if (anniversaries.length || hallYears) {
    const lines = [];
    if (hallYears) lines.push(`🎉 The hall itself turns **${hallYears}** today.`);
    for (const { member, years } of anniversaries) {
      lines.push(`<@${member.id}> · **${years}** year${years === 1 ? '' : 's'} in the hall`);
    }
    embeds.push(new EmbedBuilder().setColor(PARCHMENT).setTitle('🎂 Anniversaries').setDescription(lines.join('\n').slice(0, 4096)));
  }

  return { content: line || undefined, embeds, files, components, allowedMentions: { parse: [] } };
}

// --- The day's post, and asking for a date ----------------------------------

/**
 * Post today's memory and anniversaries to the configured channel. Returns the
 * message, or null when there was nothing to say — which is said by saying
 * nothing.
 */
async function postToday(client, guildId, now = new Date()) {
  const cfg = configFor(guildId);
  const guild = await client.guilds.fetch(guildId);
  const channel = await client.channels.fetch(cfg.channel);
  const today = partsIn(now, cfg.timeZone);
  const { optedOut } = stateOf(guildId);

  const pick = await pickFor(guild, { month: today.month, day: today.day, latestYear: today.year - 1, skipShown: true });
  const anniversaries = await anniversariesOn(guild, today, cfg.timeZone, optedOut);
  const born = partsIn(new Date(guild.createdTimestamp), cfg.timeZone);
  const hallYears = born.month === today.month && born.day === today.day ? today.year - born.year : 0;
  if (!pick && !anniversaries.length && !hallYears) {
    console.log(`[OnThisDay] ${guildId}: nothing for ${dateName(today.month, today.day)}.`);
    return null;
  }

  const years = pick ? today.year - pick.year : 0;
  const ago = years === 1 ? 'A year ago today' : `${years} years ago today`;
  const line = pick ? await lineFor(pick, ago).catch((err) => {
    console.warn(`[OnThisDay] ${guildId}: no line today: ${err?.message || err}`);
    return null;
  }) : null;
  const sent = await channel.send(await render(pick, { heading: `📜 ${ago}`, line, anniversaries, hallYears }));
  if (pick) mutate(guildId, (record) => { record.shown = [...record.shown, pick.message.id].slice(-REMEMBER); });
  console.log(`[OnThisDay] ${guildId}: posted ${pick ? `a ${pick.year} memory (score ${pick.score})` : 'no memory'}`
    + ` and ${anniversaries.length} anniversar${anniversaries.length === 1 ? 'y' : 'ies'}.`);
  return sent;
}

/**
 * The best of any date, for /onthisday show. Counts this year too when the date
 * has already been and gone. Returns a message payload, or null.
 */
async function showDate(guild, { month, day }, now = new Date()) {
  const cfg = configFor(guild.id);
  const today = partsIn(now, cfg.timeZone);
  const passed = month < today.month || (month === today.month && day < today.day);
  const pick = await pickFor(guild, { month, day, latestYear: passed ? today.year : today.year - 1, skipShown: false });
  if (!pick) return null;
  const when = `On ${dateName(month, day, pick.year)}`;
  const line = await lineFor(pick, when).catch(() => null);
  return render(pick, { heading: `📜 ${dateName(month, day, pick.year)}`, line });
}

/** Post today's now, whatever the clock says, and count it as today's. */
async function postNow(client, guildId, now = new Date()) {
  const cfg = configFor(guildId);
  const t = partsIn(now, cfg.timeZone);
  const sent = await postToday(client, guildId, now);
  mutate(guildId, (record) => { record.lastRun = `${t.year}-${pad(t.month)}-${pad(t.day)}`; });
  return sent;
}

// --- The clock --------------------------------------------------------------

const running = new Set();

async function tick(client, now = new Date()) {
  for (const guildId of activeGuilds()) {
    const cfg = configFor(guildId);
    const t = partsIn(now, cfg.timeZone);
    const today = `${t.year}-${pad(t.month)}-${pad(t.day)}`;
    if (t.hour < cfg.hour || t.hour >= cfg.hour + WINDOW_HOURS) continue;
    if (stateOf(guildId).lastRun === today || running.has(guildId)) continue;
    running.add(guildId);
    try {
      await postToday(client, guildId, now);
      // Marked only once it is done. A failure is tried again on the next tick
      // while the window is open, and the date's candidates are cached by then.
      mutate(guildId, (record) => { record.lastRun = today; });
    } catch (err) {
      console.warn(`[OnThisDay] ${guildId}: today's post failed: ${err?.message || err}`);
    } finally {
      running.delete(guildId);
    }
  }
}

function scheduleOnThisDay(client) {
  const guilds = activeGuilds();
  if (!guilds.length) return;
  setInterval(() => { tick(client).catch(() => {}); }, TICK_MINUTES * MINUTE_MS);
  tick(client).catch(() => {});
  const cfg = configFor(guilds[0]);
  console.log(`[OnThisDay] Running for ${guilds.length} guild(s), posting from ${cfg.hour}:00 ${cfg.timeZone}.`);
}

module.exports = {
  scheduleOnThisDay,
  postNow,
  showDate,
  setOptOut,
  parseMonthDay,
  dateName,
  // For tests and scripts.
  partsIn,
  midnight,
  dayBounds,
  snowflakeAt,
  scoreDay,
  candidatesOn,
  pickFor,
  anniversariesOn,
  sourceChannels,
  render,
  tick,
  stateOf,
};
