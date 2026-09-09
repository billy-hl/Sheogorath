'use strict';
/**
 * Works out what a character lost across a wipe, so it can be handed back.
 *
 * WHY THIS CAN WORK AT ALL
 * A `world` wipe renames the whole save aside and copies the character files
 * into a fresh one, so the pre-wipe `players.db` survives intact inside
 * `data/backups/wipe-<timestamp>/`. That backup is immutable — nothing writes to it ever
 * again — which makes it a permanent, trustworthy baseline for "what did this
 * person have before?". The live database, by contrast, is rewritten every time
 * somebody saves.
 *
 * HOW THE DIFF WORKS, AND WHAT IT IS NOT
 * PZ stores a character's inventory as a serialised binary blob in
 * `networkPlayers.data`. There is no schema here to query, so this scans the
 * blob for item-shaped tokens (`Base.Axe`, `MarzGuns.M1911`) and compares the
 * multiset before against the multiset now. That is a **heuristic**, not a
 * parse: it cannot see condition, ammo loaded, container nesting, or how many
 * of something is inside a bag versus worn.
 *
 * Two consequences follow, and both shape the API below:
 *
 *  1. It compares against what the player holds *now*, not against zero. So a
 *     restore tops somebody up rather than doubling what they still carry.
 *  2. It can be wrong. `preview()` exists so a human sees the list before
 *     anything is granted, because a bad regex match that hands out a free
 *     rifle is worse than a restore that has to be asked for twice.
 *
 * WHY IT NEVER WRITES TO THE DATABASE
 * Restoring by editing `players.db` would be exact, but that file holds every
 * character on the server and the running game owns it. Granting over RCON is
 * slower and loses item condition, and is still the right trade: the failure
 * mode is "somebody gets a clean rifle instead of a scratched one" rather than
 * "the save is corrupt".
 */
const fs = require('node:fs');
const path = require('node:path');
const { playersDbPath } = require('./players');

/**
 * Item ids look like `Module.ItemName`. The 3-character floor on the second
 * half keeps this off things like `a.b` that fall out of binary noise.
 */
const ITEM_TOKEN = /[A-Za-z0-9_]+\.[A-Za-z0-9_]{3,40}/g;

/**
 * Tokens that match the shape above but are not spawnable items. The blob also
 * carries texture names, weapon part states and animation markers, and
 * `additem` rejects them — harmlessly, but a refusal list in the output reads
 * like a bug, so they are dropped before anyone sees them.
 */
const NOT_AN_ITEM = /TEXTURE|TINT$|Slide_|Hammer_|Cylinder_|_Close$|_Open$|_Lock$|_Down$|_Folded$|_Up$/;

/** Java class names serialised alongside the inventory. */
const CLASS_PREFIX = /^(java|javax|sun|com|org|zombie|fmod)\./;

/**
 * A single restore is capped. The largest genuine loss seen was 56 items; an
 * order of magnitude above that means the diff has gone wrong, and refusing is
 * better than quietly flooding somebody's inventory.
 */
const MAX_ITEMS = 400;

/**
 * The newest wipe backup for a guild, or null.
 *
 * Directories are named `wipe-YYYYMMDD-HHMMSS-<mode>`, so a lexical sort is
 * chronological. Only backups that actually contain a `players.db` count — a
 * `full` wipe keeps no characters, so its backup is not a baseline for this.
 */
function backupDbPath(guildId) {
  const live = playersDbPath(guildId);
  if (!live) return null;
  // .../data/Saves/Multiplayer/<world>/players.db  ->  .../data/backups
  const backups = path.resolve(path.dirname(live), '..', '..', '..', 'backups');
  let entries;
  try {
    entries = fs.readdirSync(backups);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((n) => n.startsWith('wipe-'))
    .sort()
    .reverse()
    .map((n) => path.join(backups, n, 'players.db'))
    .filter((p) => {
      try {
        return fs.statSync(p).size > 0;
      } catch {
        return false;
      }
    });
  return candidates[0] || null;
}

/** Read one character's inventory blob, or null when there is no such row. */
function readBlob(dbPath, username) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT data FROM networkPlayers WHERE username = ? ORDER BY id DESC LIMIT 1')
      .get(username);
    if (!row || !row.data) return null;
    return Buffer.from(row.data);
  } finally {
    db.close();
  }
}

/** Multiset of item ids found in a blob. */
function itemCounts(blob) {
  const counts = new Map();
  if (!blob || !blob.length) return counts;
  // latin1 keeps every byte a single character, so offsets and matches line up
  // with the raw buffer and no byte is lost to UTF-8 replacement.
  const text = blob.toString('latin1');
  for (const match of text.matchAll(ITEM_TOKEN)) {
    const id = match[0];
    if (CLASS_PREFIX.test(id) || NOT_AN_ITEM.test(id)) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

/**
 * What `username` had before the most recent wipe and does not have now.
 *
 * Returns `{ ok:false, reason }` when it cannot answer, rather than throwing —
 * every caller here is a Discord interaction that wants to explain itself.
 */
function preview(guildId, username) {
  const live = playersDbPath(guildId);
  if (!live) return { ok: false, reason: 'No players.db is configured for this guild.' };

  const backup = backupDbPath(guildId);
  if (!backup) {
    return {
      ok: false,
      reason: 'No wipe backup with a players.db was found — there is nothing to compare against.',
    };
  }

  let before;
  let now;
  try {
    before = readBlob(backup, username);
    now = readBlob(live, username);
  } catch (err) {
    return { ok: false, reason: `Could not read the save: ${err.message}` };
  }

  if (!before) {
    return { ok: false, reason: `**${username}** has no character in the pre-wipe backup.` };
  }
  if (!now) {
    return {
      ok: false,
      reason:
        `**${username}** has no character in the live save. They may not have ` +
        'logged in since the wipe — their record is still exactly as preserved.',
    };
  }

  const had = itemCounts(before);
  const has = itemCounts(now);
  const missing = [];
  for (const [id, count] of had) {
    const short = count - (has.get(id) || 0);
    if (short > 0) missing.push({ id, count: short });
  }
  missing.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const total = missing.reduce((n, m) => n + m.count, 0);
  return {
    ok: true,
    backup: path.basename(path.dirname(backup)),
    // Byte sizes are the honest signal for whether anything was actually lost:
    // a record that GREW is somebody who looted, not somebody who was truncated.
    beforeBytes: before.length,
    nowBytes: now.length,
    beforeTokens: [...had.values()].reduce((a, b) => a + b, 0),
    nowTokens: [...has.values()].reduce((a, b) => a + b, 0),
    missing,
    total,
    // Surfaced so the caller can say "this looks like ordinary play" instead of
    // presenting a swapped pair of trousers as a loss.
    grew: now.length > before.length,
    overCap: total > MAX_ITEMS,
    maxItems: MAX_ITEMS,
  };
}

module.exports = { preview, backupDbPath, itemCounts, MAX_ITEMS };
