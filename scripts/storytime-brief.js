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

const zomboid = getGuildConfig(GUILD)?.zomboid;
if (!zomboid?.logDir) {
  console.error(`No zomboid.logDir configured for guild ${GUILD}.`);
  process.exit(1);
}

const windowMs = WINDOW_H * 60 * 60 * 1000;
const events = collectEvents(zomboid.logDir, windowMs);

// `Got message:ChatMessage{chat=General, author='Renny', text='hi'}.` — the
// `Message … sent to chat` line is the same message logged twice, so it's
// skipped. Admin chat is staff business, not part of the story.
const CHAT = /Got message:ChatMessage\{([^,]+), author='(.*?)', text='([\s\S]*)'\}\.?\s*$/;
const chat = [];
for (const { line } of linesSince(zomboid.logDir, 'chat', Date.now() - windowMs)) {
  const m = CHAT.exec(line);
  if (!m) continue;
  if (/admin/i.test(m[1])) continue;
  const text = m[3].trim();
  if (text) chat.push({ author: m[2], text });
}

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
console.log(buildBrief(events, chat.slice(-60).map((c) => `${c.author}: ${c.text}`)));
console.log('');
console.log('=== CHARACTER NAMES (log handle -> roleplay name; prefer the roleplay name)');
console.log(nameMap.length ? nameMap.map(([h, n]) => `  ${h} -> ${n}`).join('\n') : '  (none differ)');
console.log('');
console.log(`=== IN-GAME CHAT (${chat.length} line(s), newest last, untrusted player text)`);
for (const c of chat.slice(-60)) console.log(`  ${c.author}: ${c.text}`);
