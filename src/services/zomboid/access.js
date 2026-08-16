'use strict';
/**
 * In-game access levels: which roles the server has, and moving a player
 * between them.
 *
 * This is a bigger job than the RCON one-liners in admin.js, for two reasons
 * that both fail silently.
 *
 * **`setaccesslevel` does not check the username.** Aimed at a name nobody owns
 * it answers `User <name> is now moderator` — and creates a whitelist row for
 * that name, pre-promoted, waiting for whoever registers it next. The reply is
 * indistinguishable from a real one, so the reply-text check in admin.js can't
 * catch this the way it catches a missing player. The name is therefore looked
 * up in the whitelist here, *before* the command goes out, and a miss is
 * refused.
 *
 * **The level names come from the server's own `role` table, matched
 * case-sensitively.** This server carries two custom roles beside the built-in
 * ones, so `"Sheriff"` is accepted where `"sheriff"` is rejected. The console's
 * `help` is actively misleading — it advertises "Admin, Moderator, Overseer, GM,
 * Observer", of which `Overseer` doesn't exist here, and it omits `banned`,
 * `user`, `priority`, `Wabbagang` and `Sheriff`, all of which work. So the
 * levels are read from the table rather than hardcoded, and whatever the caller
 * types is matched loosely and sent back in the table's exact casing.
 *
 * Between those two, the write is also read back: after the RCON call the
 * whitelist row is checked to confirm the level actually landed, because "the
 * server said OK" has already been established as worth nothing here.
 *
 * The database is opened **read-only**, for the same reason as players.js: the
 * running server owns the file. Every write goes out over RCON.
 */
const { getGuildConfig } = require('../../config/guilds');
const { rcon, sanitizeArg } = require('./rcon');

// The whitelist changes when someone registers and the role table only when an
// admin edits it in-game, so this is cached — autocomplete would otherwise open
// the database once per keystroke.
const TTL_MS = 30 * 1000;
const cache = new Map(); // dbPath -> { at, levels, byUsername }

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function load(dbPath) {
  const hit = cache.get(dbPath);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;

  // Required lazily: node:sqlite is experimental and warns on first load, so a
  // guild with no users database configured never pays for it.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let roleRows;
  let userRows;
  try {
    // `position` is the server's own ranking — 1000 for banned up to 7000 for
    // admin, with custom roles slotted between — and ordering by it makes the
    // picker read as a ladder instead of as creation order.
    roleRows = db
      .prepare('SELECT id, name, description, position FROM role ORDER BY position ASC')
      .all();
    userRows = db.prepare('SELECT username, role FROM whitelist WHERE username IS NOT NULL').all();
  } finally {
    db.close();
  }

  const roleById = new Map(roleRows.map((r) => [r.id, r]));
  const levels = roleRows.map((r) => ({
    name: String(r.name),
    description: (r.description || '').trim(),
    position: r.position,
  }));

  // Keyed lowercase: nobody types their staff's account names with the right
  // capitalisation, and the exact stored spelling is what gets sent to RCON.
  const byUsername = new Map();
  for (const row of userRows) {
    const username = String(row.username).trim();
    if (!username) continue;
    byUsername.set(username.toLowerCase(), {
      username,
      level: roleById.get(row.role)?.name || null,
    });
  }

  const loaded = { at: Date.now(), levels, byUsername };
  cache.set(dbPath, loaded);
  return loaded;
}

/** Path to the server's users database for a guild, or null when unconfigured. */
function usersDbPath(guildId) {
  return getGuildConfig(guildId)?.zomboid?.usersDb || null;
}

/** Something went wrong the caller should read verbatim rather than as a bug. */
function operatorError(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

function requireIndex(guildId) {
  const dbPath = usersDbPath(guildId);
  if (!dbPath) {
    throw operatorError(
      "No users database is configured for this server, so I can't tell which accounts " +
        'or access levels exist. Set `zomboid.usersDb` in config/guilds.json.',
    );
  }
  try {
    return { dbPath, index: load(dbPath) };
  } catch (err) {
    console.warn('[Zomboid] Could not read the users database:', err?.message || err);
    throw operatorError("I couldn't read the server's users database.");
  }
}

/**
 * Every access level this server has, lowest rank first.
 *
 * Never throws — an empty list degrades the picker to free text, which the
 * command validates anyway.
 *
 * @returns {Array<{name: string, description: string, position: number}>}
 */
function levels(guildId) {
  try {
    return requireIndex(guildId).index.levels;
  } catch {
    return [];
  }
}

/**
 * Every registered account, alphabetically, with the level each one holds.
 *
 * This is the whitelist rather than the online list: promoting someone the
 * moment they ask, without waiting for them to log in, is the normal case.
 *
 * @returns {Array<{username: string, level: string|null}>}
 */
function accounts(guildId) {
  let index;
  try {
    ({ index } = requireIndex(guildId));
  } catch {
    return [];
  }
  return [...index.byUsername.values()].sort((a, b) =>
    a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
  );
}

/**
 * The account and level for one username, matched case-insensitively.
 *
 * @returns {{username: string, level: string|null}|null} null when no such
 *   account is registered
 */
function lookup(guildId, username) {
  let index;
  try {
    ({ index } = requireIndex(guildId));
  } catch {
    return null;
  }
  return index.byUsername.get(String(username).trim().toLowerCase()) || null;
}

/**
 * Read the level back out of the whitelist until it matches, or we run out.
 *
 * The server writes the row as it answers, so the first read almost always
 * agrees. The retries exist so a write that lands a moment late reads as success
 * rather than as an alarming "the server says otherwise".
 *
 * @returns {Promise<{level: string|null}|{unreadable: true}>}
 */
async function readBack(dbPath, username, expected, attempts = 3) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await delay(200);
    cache.delete(dbPath); // The whole point is to not trust the cached copy.
    try {
      last = load(dbPath).byUsername.get(username.toLowerCase())?.level || null;
    } catch (err) {
      console.warn('[Zomboid] Could not verify access level:', err?.message || err);
      return { unreadable: true };
    }
    if (last === expected) return { level: last };
  }
  return { level: last };
}

/**
 * Move a player to an access level.
 *
 * @param {string} guildId
 * @param {string} username account name, any capitalisation
 * @param {string} level level name, any capitalisation
 * @returns {Promise<{username: string, from: string|null, to: string,
 *   changed: boolean, verified: boolean}>}
 * @throws {Error} with `userFacing` set when the account or level doesn't exist,
 *   or when the change didn't stick
 */
async function setLevel(guildId, username, level) {
  const { dbPath, index } = requireIndex(guildId);

  const account = index.byUsername.get(String(username).trim().toLowerCase());
  if (!account) {
    // Refusing is the whole point: letting this through would leave a promoted
    // account sitting on the whitelist under a name nobody has claimed yet.
    throw operatorError(
      `No account named **${username}** is registered on the server, so I won't set a level ` +
        'for it — the server would happily create one, pre-promoted, for whoever registers ' +
        'that name next. Check the spelling; they have to have logged in at least once.',
    );
  }

  const target = index.levels.find(
    (l) => l.name.toLowerCase() === String(level).trim().toLowerCase(),
  );
  if (!target) {
    const known = index.levels.map((l) => `\`${l.name}\``).join(', ');
    throw operatorError(`**${level}** isn't an access level on this server. Pick one of: ${known}.`);
  }

  if (account.level === target.name) {
    return {
      username: account.username,
      from: account.level,
      to: target.name,
      changed: false,
      verified: true,
    };
  }

  await rcon(
    guildId,
    `setaccesslevel "${sanitizeArg(account.username)}" "${sanitizeArg(target.name)}"`,
  );

  const confirmation = await readBack(dbPath, account.username, target.name);
  if (!confirmation.unreadable && confirmation.level !== target.name) {
    throw operatorError(
      `The server accepted the change but **${account.username}** is still ` +
        `**${confirmation.level || 'unset'}** in the whitelist, so it didn't take.`,
    );
  }

  return {
    username: account.username,
    from: account.level,
    to: target.name,
    changed: true,
    verified: !confirmation.unreadable,
  };
}

/** Drop the cache — used after a restore swaps the database underneath us. */
function clearCache() {
  cache.clear();
}

module.exports = { usersDbPath, levels, accounts, lookup, setLevel, clearCache };
