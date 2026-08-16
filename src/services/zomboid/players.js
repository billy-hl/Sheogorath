'use strict';
/**
 * Resolves a player's roleplay character name.
 *
 * Every PZ log identifies people by their **account username** — `Renny`,
 * `poop`, `Coolishpro`. The character they actually play — `Jess Owens`,
 * `Fawn Emerson`, `Walter Hartwell White` — exists only in the save database,
 * in `networkPlayers`. On a roleplay server the character name is the one worth
 * showing, so anything player-facing has to make this join.
 *
 * The database is opened **read-only**. The running server owns this file; the
 * rename tooling refuses to touch it while the container is up for exactly that
 * reason. Reading is safe (SQLite readers don't block a writer), writing is not.
 */
const { getGuildConfig } = require('../../config/guilds');

// networkPlayers is rewritten as people play, so the map is refreshed rather
// than held forever — but not on every call, since a burst of deaths would
// otherwise re-read the file once per eulogy.
const TTL_MS = 60 * 1000;
const cache = new Map(); // dbPath -> { at, bySteamId, byUsername }

function load(dbPath) {
  const hit = cache.get(dbPath);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;

  // Required lazily: node:sqlite is experimental and prints a warning on first
  // load, so a guild with no save path configured never pays for it.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  try {
    // steamid is stored as an INTEGER and every value exceeds 2^53, so reading
    // it as a JS number throws "Value is too large to be represented as a
    // JavaScript number" and takes the whole query down with it. Cast in SQL —
    // it is only ever compared as a string here anyway.
    // ORDER BY id is load-bearing, not tidiness. A Steam ID appears once per
    // character the account has made — 450 rows across 420 accounts here, e.g.
    // 76561198036131345 is both `Owz`/"Ow Z" (id 42) and `Ow Z`/"Cherry Hook"
    // (id 54). Later rows overwrite earlier ones below, so ascending id leaves
    // the newest character in the map, which is the one they are playing.
    rows = db
      .prepare(
        'SELECT CAST(steamid AS TEXT) AS steamid, username, name, isDead ' +
        'FROM networkPlayers ORDER BY id ASC'
      )
      .all();
  } finally {
    db.close();
  }

  const bySteamId = new Map();
  const byUsername = new Map();
  for (const r of rows) {
    // Character names are player-entered and come back with stray whitespace
    // ("EL DIABLO "), which shows up in a Discord bold run.
    const trim = (v) => (typeof v === 'string' ? v.trim() : v);
    const entry = {
      steamid: String(r.steamid ?? ''),
      username: trim(r.username) || null,
      name: trim(r.name) || null,
      isDead: !!r.isDead,
    };
    if (entry.steamid) bySteamId.set(entry.steamid, entry);
    if (entry.username) byUsername.set(entry.username, entry);
  }

  const loaded = { at: Date.now(), bySteamId, byUsername };
  cache.set(dbPath, loaded);
  return loaded;
}

/**
 * The character name for a player, falling back to the username when there
 * isn't one.
 *
 * Steam ID is tried first: it survives a rename and is unambiguous, whereas two
 * accounts can share a username across worlds. Any failure — no save path, an
 * unreadable file, a player who has never spawned — returns the username, so a
 * missing character name degrades to today's behaviour instead of an error.
 *
 * @param {string|null} dbPath path to players.db, or null to skip the lookup
 * @param {{steamid?: string, username?: string}} who
 * @returns {string|null}
 */
function characterName(dbPath, { steamid, username } = {}) {
  if (!dbPath) return username || null;
  let index;
  try {
    index = load(dbPath);
  } catch (err) {
    console.warn('[Zomboid] Could not read players.db:', err?.message || err);
    return username || null;
  }

  const entry =
    (steamid && index.bySteamId.get(String(steamid))) ||
    (username && index.byUsername.get(username)) ||
    null;

  return entry?.name || username || null;
}

/**
 * The whole `networkPlayers` row for a player, rather than just their character
 * name.
 *
 * Character sheets need more than the name: `isDead` decides whether a sheet is
 * still current, and the Steam ID is what a sheet is filed under, since it is
 * the only identifier that survives a rename.
 *
 * @param {string|null} dbPath
 * @param {{steamid?: string, username?: string}} who
 * @returns {{steamid: string, username: string|null, name: string|null, isDead: boolean}|null}
 */
function lookupPlayer(dbPath, { steamid, username } = {}) {
  if (!dbPath) return null;
  let index;
  try {
    index = load(dbPath);
  } catch (err) {
    console.warn('[Zomboid] Could not read players.db:', err?.message || err);
    return null;
  }

  return (
    (steamid && index.bySteamId.get(String(steamid))) ||
    (username && index.byUsername.get(username)) ||
    null
  );
}

/** Path to the save's players.db for a guild, or null when not configured. */
function playersDbPath(guildId) {
  return getGuildConfig(guildId)?.zomboid?.playersDb || null;
}

/** Drop the cache — used by tests and after a save is restored underneath us. */
function clearCache() {
  cache.clear();
}

module.exports = { characterName, lookupPlayer, playersDbPath, clearCache };
