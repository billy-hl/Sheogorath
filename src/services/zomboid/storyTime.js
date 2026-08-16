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

const DEFAULT_HOUR = 22; // 10pm, server local time
const DISCORD_LIMIT = 2000;

// This is a busy public server: a day can see 100+ names and 70+ deaths.
// Feeding all of them still produces a shapeless list, but the chronicle is
// meant to name the room rather than a headline cast, so the brief carries a
// generous slice and lets the model choose from it.
const MAX_NAMED_SURVIVORS = 20;
// Repeat deaths are what the running joke is built from, so carry a few more
// than the entry will use and let the model pick the funniest.
const MAX_NAMED_DEATHS = 18;
// Leaderboards worth a sentence each — deep enough that quiet regulars and
// one-day arrivals both surface.
const MAX_NAMED_VETERANS = 8;
const MAX_NAMED_BUILDERS = 8;

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
    .slice(0, MAX_NAMED_VETERANS);
  if (survivors.length) {
    lines.push('Longest-running characters (hours survived):');
    for (const [name, r] of survivors) lines.push(`  - ${name}: ${r.hoursSurvived}h`);
  }

  const builders = [...events.builders.entries()]
    .sort((a, b) => (b[1].added + b[1].removed) - (a[1].added + a[1].removed))
    .slice(0, MAX_NAMED_BUILDERS);
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

// NOT the prompt used for the nightly chronicle. That moved out of the bot to a
// Claude Code scheduled task, whose prompt lives in
// `~/.claude/scheduled-tasks/zomboid-story-time/SKILL.md` — edit that one to
// change what gets posted. This is kept in step with it so the in-bot path
// (`generateStory`, currently uncalled) still produces something comparable if
// it is ever revived. See the note in src/index.js.
const SYSTEM_PROMPT =
  'You are the chronicler of a Project Zomboid multiplayer server set in the ' +
  'Knox County outbreak. Write the daily entry, past tense, in the voice of a ' +
  'survivor keeping a journal by candlelight.\n\n' +
  'FORMAT. The first line must be exactly "TITLE: <title>" — a wry title for ' +
  'the day, eight words at most. Then one blank line, then the entry itself: ' +
  'seven to nine paragraphs, 700 to 900 words. Vary their length — follow a ' +
  'long paragraph with a two-sentence one. Land paragraphs on the short ' +
  'sentence rather than the explanation.\n\n' +
  'WHO TO WRITE ABOUT. Name as many survivors as the brief will carry — aim ' +
  'for twelve or more. The busiest, the unluckiest and the longest-lived each ' +
  'deserve their own line. Someone who died five times, someone who tore down ' +
  'half a house, someone a thousand hours in and someone on their first ' +
  'afternoon all belong in the same entry. Do not shrink the day down to two ' +
  'or three people, and do not simply walk the brief in order — cut between ' +
  'them the way a good anecdote does.\n\n' +
  'USE THE RADIO CHATTER. The brief ends with things survivors actually said. ' +
  'This is your best material and most entries waste it. Quote them verbatim, ' +
  'in quotation marks, attributed by name, at least four or five times across ' +
  'the entry. Trim a long line if you must, but never rewrite one to be ' +
  'funnier — they are funnier than you are. Let people incriminate themselves ' +
  'in their own words, and set what someone said against what the facts say ' +
  'actually happened to them.\n\n' +
  'TONE. Funny. Dry, deadpan gallows humour — the comedy of people making ' +
  'terrible decisions in a collapsing world and recording them as though ' +
  'nothing were unusual. Understatement lands harder than jokes. Treat ' +
  'catastrophe as paperwork and minor inconvenience as tragedy. Specific ' +
  'detail beats summary: not "several deaths", but the man who died three ' +
  'times to the same fence. When a name keeps recurring, let it become a ' +
  'running joke and pay it off in the closing paragraph. Be genuinely ' +
  'amusing; never zany, no memes, no emoji, no exclamation marks.\n\n' +
  'TRUTH. Never invent survivors, places, causes of death, or events absent ' +
  'from the brief. Counts are facts — do not change them, though you need not ' +
  'recite them all. Quotes must be real. You may invent how the day FELT: the ' +
  'weather, the smell of the kitchen, what the chronicler privately thinks of ' +
  'these people.';

/**
 * Split the model's `TITLE:` line off the body and render it as a Discord
 * heading.
 *
 * The marker is asked for explicitly rather than inferred from the shape of
 * the first line, so a model that ignores the instruction degrades to an
 * untitled entry instead of losing its opening sentence to a bad guess.
 */
function formatTitle(text) {
  const m = /^\s*TITLE:\s*(.+?)\s*(?:\n|$)([\s\S]*)$/.exec(text);
  if (!m) return text.trim();
  const title = m[1].replace(/^["'*#\s]+|["'*\s]+$/g, '');
  const body = m[2].trim();
  if (!title) return body;
  return body ? `## ${title}\n\n${body}` : `## ${title}`;
}

/**
 * Break the chronicle into Discord-sized messages on paragraph boundaries.
 *
 * The entry is long enough now that a busy day can run past the 2000-char
 * limit, and a second message reads better than a sentence cut in half.
 */
function splitForDiscord(text, limit = DISCORD_LIMIT) {
  const chunks = [];
  let current = '';

  for (const para of text.split('\n\n')) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // A single paragraph over the limit is pathological, but hard-split it
    // rather than dropping it on the floor.
    let rest = para;
    while (rest.length > limit) {
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    current = rest;
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Generate the chronicle text. Returns null when the day had no activity worth
 * narrating, so a dead server doesn't post an empty daily message.
 *
 * The text may exceed Discord's per-message limit — `postStory` splits it.
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
    // ~900 words of prose plus the title needs well over 1200 tokens; the
    // ceiling is deliberately loose because a truncated chronicle reads as a
    // bug, while an under-run costs nothing.
    { rawSystemPrompt: SYSTEM_PROMPT, maxTokens: 2000 }
  );

  const text = (story || '').trim();
  if (!text) return null;
  return formatTitle(text);
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

const MAX_CHAT_FETCH = 300;    // ~3 API pages; a busy day rarely exceeds this
// The chronicle now quotes survivors directly, so this sample is the material
// the entry is built from rather than background colour — a thin one forces the
// model back onto the same handful of lines every night.
const MAX_CHAT_IN_BRIEF = 120;

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

  const parts = splitForDiscord(story);
  for (const part of parts) await channel.send(part);
  console.log(
    `[Zomboid] Posted story time to ${cfg.channelId} ` +
    `(${story.length} chars in ${parts.length} message${parts.length === 1 ? '' : 's'}).`
  );
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
  formatTitle,
  splitForDiscord,
};
