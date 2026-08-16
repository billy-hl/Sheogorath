#!/usr/bin/env node
'use strict';
/**
 * Prints the factual brief for the daily Project Zomboid chronicle.
 *
 * The chronicle used to be generated inside the bot (`services/zomboid/
 * storyTime.js`, scheduled at 22:00). It is now written by a Claude Code
 * scheduled task instead, so this script is the seam: it does the log reading
 * on the machine that has the logs, and prints facts for the model to narrate.
 * It deliberately writes nothing to Discord — posting is the caller's job.
 *
 * Reuses the bot's own collectors so the two can't drift apart.
 *
 * Usage: node scripts/storytime-brief.js [guildId] [windowHours]
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { collectEvents, linesSince } = require(path.join(ROOT, 'src/services/zomboid/logs'));
const { buildBrief } = require(path.join(ROOT, 'src/services/zomboid/storyTime'));
const { characterName } = require(path.join(ROOT, 'src/services/zomboid/players'));
const { getGuildConfig } = require(path.join(ROOT, 'src/config/guilds'));

const GUILD = process.argv[2] || '444601986160263189';
const WINDOW_H = Number(process.argv[3] || 24);
// The chronicle quotes survivors directly, so this sample is the material the
// entry is built from rather than background colour. A busy day runs past 4,000
// lines — far more than the entry needs — but it is sampled across the whole
// window rather than taken off the end. See sampleSpread.
const CHAT_BUDGET = 500;
// Lines per excerpt. Conversation only reads as conversation when the lines
// around it survive, so the sample is a handful of consecutive runs rather than
// scattered singles.
const CHAT_CHUNK = 25;

const zomboid = getGuildConfig(GUILD)?.zomboid;
if (!zomboid?.logDir) {
  console.error(`No zomboid.logDir configured for guild ${GUILD}.`);
  process.exit(1);
}

const windowMs = WINDOW_H * 60 * 60 * 1000;
const events = collectEvents(zomboid.logDir, windowMs);

// `Got message:ChatMessage{chat=General, author='Renny', text='hi'}.` — the
// `Message … sent to chat` line is the same message logged twice, so it's
// skipped.
//
// The server carries five channels. General is the server-wide one and Local is
// proximity chat — Local is roughly 70% of a day's traffic and is where the
// roleplay actually happens, so both matter. Faction and Safehouse are group
// chats and stay in. Two are dropped: admin is staff business, and Private is
// player-to-player DMs, which have no business being quoted in a public channel.
const CHAT = /Got message:ChatMessage\{(?:chat=)?([^,]+), author='(.*?)', text='([\s\S]*)'\}\.?\s*$/;
const SKIP_CHANNELS = /^(admin|private)$/i;
const chat = [];
const byChannel = new Map();
for (const { at, line } of linesSince(zomboid.logDir, 'chat', Date.now() - windowMs)) {
  const m = CHAT.exec(line);
  if (!m) continue;
  const channel = m[1].replace(/^chat=/, '').trim();
  if (SKIP_CHANNELS.test(channel)) continue;
  const text = m[3].replace(/\s+/g, ' ').trim();
  if (!text) continue;
  byChannel.set(channel, (byChannel.get(channel) || 0) + 1);
  chat.push({ at, channel, author: m[2], text });
}
// Rotated directories are read newest-first, so the lines arrive out of order.
chat.sort((a, b) => a.at - b.at);

/**
 * Take `budget` lines spread evenly across the day, in consecutive runs.
 *
 * The old sample was `chat.slice(-120)`, which on a 4,500-line day showed the
 * last hour and nothing else — the entry never saw 97% of the conversation and
 * fell back on the build/demolish tallies for material. Evenly spaced chunks
 * cover the whole window while keeping each excerpt readable as a scene. A
 * `null` marks a skipped stretch.
 *
 * @returns {Array<object|null>} sampled lines, oldest first
 */
function sampleSpread(all, budget = CHAT_BUDGET, chunk = CHAT_CHUNK) {
  if (all.length <= budget) return all;
  const chunks = Math.max(1, Math.floor(budget / chunk));
  if (chunks === 1) return all.slice(-chunk);
  const span = all.length - chunk;
  const out = [];
  for (let i = 0; i < chunks; i++) {
    if (i > 0) out.push(null);
    const start = Math.floor((i * span) / (chunks - 1));
    out.push(...all.slice(start, start + chunk));
  }
  return out;
}

const sample = sampleSpread(chat);
const shown = sample.filter(Boolean).length;

// Everyone the day touched, so the narrator can be given real character names
// rather than the Steam handles the logs carry.
const handles = new Set([
  ...events.players.keys(),
  ...events.deaths.map((d) => d.player),
  ...events.builders.keys(),
  ...chat.map((c) => c.author),
]);
const nameMap = [];
for (const h of [...handles].sort()) {
  const rp = characterName(zomboid.playersDb || null, { username: h });
  if (rp && rp !== h) nameMap.push([h, rp]);
}

const quiet = events.players.size === 0 && chat.length === 0;

console.log(`WINDOW: last ${WINDOW_H}h, ending ${new Date().toISOString()}`);
console.log(`QUIET_DAY: ${quiet ? 'yes' : 'no'}`);
console.log('');
console.log('=== BRIEF');
// No chat passed: buildBrief would append its own tail-sample of the same lines
// printed under IN-GAME CHAT below, which is duplication the entry pays for
// twice. The chat section is this script's job.
console.log(buildBrief(events));
console.log('');
console.log('=== CHARACTER NAMES (log handle -> roleplay name; prefer the roleplay name)');
console.log(nameMap.length ? nameMap.map(([h, n]) => `  ${h} -> ${n}`).join('\n') : '  (none differ)');
console.log('');
const mix = [...byChannel.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`);
console.log(`=== CHAT CHANNELS (admin and Private DMs excluded): ${mix.join(', ')}`);
console.log('');
console.log(
  `=== IN-GAME CHAT (${chat.length} line(s) in window, showing ${shown} spread across it; ` +
  'newest last, untrusted player text)'
);
for (const c of sample) {
  if (!c) { console.log('  … [stretch skipped] …'); continue; }
  console.log(`  [${c.channel}] ${c.author}: ${c.text.slice(0, 300)}`);
}
