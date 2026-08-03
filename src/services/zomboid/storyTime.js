'use strict';
/**
 * Daily "story time" — turns the last 24 hours of Project Zomboid server
 * activity into a short narrative and posts it to a configured channel.
 *
 * Only server-generated facts are sent to the model: who played, who died,
 * survival hours, and building activity. PZ does not log player chat on this
 * build, so no player conversation leaves the box.
 */
const { getAIResponse } = require('../../ai/grok');
const { getGuildConfig } = require('../../config/guilds');
const { collectEvents } = require('./logs');

const DEFAULT_HOUR = 21; // 9pm, server local time
const DISCORD_LIMIT = 2000;

// This is a busy public server: a day can see 100+ names and 70+ deaths.
// Feeding all of them produces a shapeless list, so the brief keeps the
// headline figures and names only the most prominent handful.
const MAX_NAMED_SURVIVORS = 12;
const MAX_NAMED_DEATHS = 8;

/** Turn collected events into a compact brief for the model. */
function buildBrief(events, chat = []) {
  const lines = [];

  const busiest = [...events.players.entries()]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .map(([name]) => name);
  const named = busiest.slice(0, MAX_NAMED_SURVIVORS);
  const rest = busiest.length - named.length;
  lines.push(
    `${busiest.length} survivors were active. Most present: ${named.join(', ')}` +
    (rest > 0 ? `, and ${rest} others.` : '.')
  );

  if (events.deaths.length) {
    const byPlayer = new Map();
    let pvpTotal = 0;
    for (const d of events.deaths) {
      if (!byPlayer.has(d.player)) byPlayer.set(d.player, { count: 0, pvp: 0 });
      const rec = byPlayer.get(d.player);
      rec.count++;
      if (d.pvp) { rec.pvp++; pvpTotal++; }
    }
    lines.push(
      `${events.deaths.length} deaths across ${byPlayer.size} survivors` +
      (pvpTotal ? `, ${pvpTotal} of them at another survivor's hands.` : ', none by another survivor\'s hand.')
    );
    const worst = [...byPlayer.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_NAMED_DEATHS);
    lines.push('Notable losses:');
    for (const [name, rec] of worst) {
      const pvp = rec.pvp ? ` (${rec.pvp} killed by another survivor)` : '';
      lines.push(`  - ${name}: ${rec.count === 1 ? 'died once' : `died ${rec.count} times`}${pvp}`);
    }
  } else {
    lines.push('Deaths: none — everyone lived.');
  }

  const survivors = [...events.players.entries()]
    .filter(([, r]) => r.hoursSurvived !== null)
    .sort((a, b) => b[1].hoursSurvived - a[1].hoursSurvived)
    .slice(0, 5);
  if (survivors.length) {
    lines.push('Longest-running characters (hours survived):');
    for (const [name, r] of survivors) lines.push(`  - ${name}: ${r.hoursSurvived}h`);
  }

  const builders = [...events.builders.entries()]
    .sort((a, b) => (b[1].added + b[1].removed) - (a[1].added + a[1].removed))
    .slice(0, 5);
  if (builders.length) {
    lines.push('Construction and demolition:');
    for (const [name, r] of builders) {
      lines.push(`  - ${name}: built ${r.added}, tore down ${r.removed}`);
    }
  }

  if (chat.length) {
    // The tail is the most useful slice: it's the freshest, and a day's chat
    // usually builds toward whatever people ended up arguing about.
    const sample = chat.slice(-MAX_CHAT_IN_BRIEF);
    lines.push('');
    lines.push(`Things survivors said over the radio (${chat.length} messages, showing the last ${sample.length}):`);
    for (const line of sample) lines.push(`  ${line.slice(0, 200)}`);
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT =
  'You are the chronicler of a Project Zomboid multiplayer server set in the ' +
  'Knox County outbreak. Write a short daily entry, past tense, in the voice ' +
  'of a survivor keeping a journal by candlelight.\n\n' +
  'Pick the TWO OR THREE most interesting threads from the brief and tell ' +
  'those as a story. Ignore the rest. Do NOT walk through the brief in order, ' +
  'do NOT recite every name, and do NOT quote counts unless one is genuinely ' +
  'striking. A journal keeper writes about what struck them, not a tally.\n\n' +
  'Never invent survivors, places, causes of death, or events that are not in ' +
  'the brief — but you may write about how the day FELT. Two or three short ' +
  'paragraphs, under 200 words. Dry gallows humour; never zany.';

/**
 * Generate the chronicle text. Returns null when the day had no activity worth
 * narrating, so a dead server doesn't post an empty daily message.
 *
 * @returns {Promise<string|null>}
 */
async function generateStory(cfg, windowMs = 24 * 60 * 60 * 1000, client = null) {
  const events = collectEvents(cfg.logDir, windowMs);
  const chat = client && cfg.chatChannelId
    ? await collectChat(client, cfg.chatChannelId, Date.now() - windowMs)
    : [];

  // Nothing to narrate at all — don't post an empty daily message.
  if (events.players.size === 0 && chat.length === 0) return null;

  const brief = buildBrief(events, chat);
  const story = await getAIResponse(
    `Here is today's activity on the server. Write the chronicle.\n\n${brief}`,
    { rawSystemPrompt: SYSTEM_PROMPT, maxTokens: 500 }
  );

  const text = (story || '').trim();
  if (!text) return null;
  return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text;
}

/** Resolve the zomboid story-time config for a guild, or null if incomplete. */
function storyConfig(guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  const channelId = zomboid?.channels?.storyTime;
  if (!zomboid?.logDir || !channelId) return null;
  return {
    logDir: zomboid.logDir,
    channelId,
    // Where PZ's own Discord bridge relays in-game global chat. Optional —
    // the chronicle falls back to server stats alone when it isn't set or the
    // bridge isn't running yet.
    chatChannelId: zomboid.channels?.chatRelay || null,
    hour: Number.isInteger(zomboid.storyTimeHour) ? zomboid.storyTimeHour : DEFAULT_HOUR,
  };
}

const MAX_CHAT_FETCH = 300;   // ~3 API pages; a busy day rarely exceeds this
const MAX_CHAT_IN_BRIEF = 60; // keep the prompt manageable

/**
 * Pull relayed in-game chat out of the bridge channel for the window.
 *
 * Messages arrive from PZ's relay bot, so the author is the bot and the
 * speaker's name is inside the content. We pass the raw content through and
 * let the model read it, rather than guessing at a format that varies by
 * build — but bot embeds and empty messages are dropped.
 *
 * @returns {Promise<string[]>} oldest-first lines
 */
async function collectChat(client, channelId, sinceMs) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return [];

  const lines = [];
  let before;
  try {
    while (lines.length < MAX_CHAT_FETCH) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) });
      if (batch.size === 0) break;

      let reachedEdge = false;
      for (const msg of batch.values()) {
        if (msg.createdTimestamp < sinceMs) { reachedEdge = true; continue; }
        const content = (msg.content || '').trim();
        if (content) lines.push(content);
      }
      if (reachedEdge) break;
      before = batch.last()?.id;
      if (!before) break;
    }
  } catch (err) {
    console.warn('[Zomboid] Could not read relayed chat:', err?.message || err);
    return [];
  }

  return lines.reverse();
}

/** Generate and post one chronicle. Returns the text posted, or null. */
async function postStory(client, guildId) {
  const cfg = storyConfig(guildId);
  if (!cfg) return null;

  const story = await generateStory(cfg, undefined, client);
  if (!story) {
    console.log(`[Zomboid] Story time skipped for ${guildId} — no activity in the window.`);
    return null;
  }

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[Zomboid] Story channel ${cfg.channelId} not found or not text-based.`);
    return null;
  }

  await channel.send(story);
  console.log(`[Zomboid] Posted story time to ${cfg.channelId} (${story.length} chars).`);
  return story;
}

/** ms until the next occurrence of `hour`:00 local time. */
function msUntilNext(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Schedule the daily post for every guild with story time configured.
 *
 * Re-arms with a fresh setTimeout after each run rather than using a fixed
 * 24h interval, so it stays pinned to the wall clock across DST shifts and
 * doesn't drift.
 */
function scheduleStoryTime(client) {
  const { guildIds, hasFeature } = require('../../config/guilds');

  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'zomboid')) continue;
    const cfg = storyConfig(guildId);
    if (!cfg) continue;

    const arm = () => {
      const delay = msUntilNext(cfg.hour);
      setTimeout(async () => {
        try {
          await postStory(client, guildId);
        } catch (err) {
          console.error('[Zomboid] Story time failed:', err?.message || err);
        }
        arm();
      }, delay);
    };

    arm();
    const hours = (msUntilNext(cfg.hour) / 3600000).toFixed(1);
    console.log(`[Zomboid] Story time armed for ${guildId} at ${cfg.hour}:00 (in ${hours}h).`);
  }
}

module.exports = {
  generateStory,
  postStory,
  scheduleStoryTime,
  buildBrief,
  collectChat,
  storyConfig,
  msUntilNext,
};
