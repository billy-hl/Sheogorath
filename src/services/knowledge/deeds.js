'use strict';
/**
 * What he has actually done lately, and what the server's roles are called.
 *
 * Two blind spots that produced the same shape of failure — a confident answer
 * about something he had no way to see.
 *
 * "Did you message fisher___?" He had no idea. Every action he takes is written
 * to the audit log the moment it happens, and none of it ever came back to him,
 * so his own deeds were the one subject he had to guess about. A bot that
 * cannot remember whether it did the thing you asked for a minute ago is not
 * trustworthy about anything else either.
 *
 * "What do you think of @Court Jesters and @Gibbys?" He cannot see roles at
 * all. Both roles were in the message, both meant something to everyone else
 * in the room, and to him they were two opaque IDs.
 */
const fs = require('fs');
const readline = require('readline');
const { LOG_FILE } = require('../../utils/aiAudit');

/** How many of his own recent deeds he is reminded of. */
const DEEDS = 12;

/** How far back a deed still counts as "lately". */
const DEEDS_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Roles listed before he is cut off — a server with 80 of them does not need all 80. */
const ROLE_LIMIT = 40;

/**
 * The tail of the audit log for one guild.
 *
 * Read backwards from the end of the file rather than parsed whole: this runs
 * on every reply, and the log grows forever.
 */
async function recentDeeds(guildId, { limit = DEEDS, windowMs = DEEDS_WINDOW_MS } = {}) {
  let lines = [];
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    // The file is small enough to stream and cheap to filter; the alternative
    // is a seek-backwards reader, which is a lot of machinery for a log that
    // rotates on its own.
    const rl = readline.createInterface({ input: fs.createReadStream(LOG_FILE), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) lines.push(line);
  } catch {
    return [];
  }

  const cutoff = Date.now() - windowMs;
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let record;
    try { record = JSON.parse(lines[i]); } catch { continue; }
    if (record.guildId !== guildId) continue;
    if (new Date(record.at).getTime() < cutoff) break;
    out.push(record);
  }
  return out.reverse();
}

/** One deed, in the past tense, with the verdict that actually applied. */
function deedLine(record) {
  const when = new Date(record.at);
  const clock = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  const what = record.summary || `${record.action?.type || 'something'}`;
  const asked = record.authorId ? ` (asked by <@${record.authorId}>)` : '';

  // The verdict matters more than the deed. "You asked to kick him and it was
  // refused" and "you kicked him" are different answers to the same question,
  // and he has confidently given the wrong one before.
  const verdict = {
    execute: 'DID',
    propose: 'ASKED PERMISSION FOR (not done)',
    deny: 'WAS REFUSED',
    shadow: 'WOULD HAVE DONE (nothing happened)',
  }[record.verdict] || record.verdict;

  return `[${clock}] ${verdict}: ${what}${asked}`;
}

/** The server's roles, as the people in it see them. */
function roleLines(guild) {
  if (!guild?.roles?.cache) return [];
  return [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .slice(0, ROLE_LIMIT)
    .map((r) => {
      const held = r.members?.size;
      return `${r.name} (<@&${r.id}>)${typeof held === 'number' ? ` — ${held} member(s)` : ''}`;
    });
}

module.exports = { recentDeeds, deedLine, roleLines, DEEDS, DEEDS_WINDOW_MS, ROLE_LIMIT };
