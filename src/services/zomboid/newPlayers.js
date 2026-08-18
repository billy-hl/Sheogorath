'use strict';
/**
 * Announces a player's **first ever** arrival on the game server.
 *
 * Not their first this session, and not every login — the same distinction
 * `services/welcome.js` makes for Discord joins, for the same reason: greeting
 * a regular as if they were new is worse than saying nothing at all.
 *
 * WHY NOT JUST "USERNAME WE HAVE NOT SEEN"
 * Because the bot has no memory of the eight hundred accounts that existed
 * before this file did. A roster built from scratch would call every single
 * regular new on the day it ships, which is exactly the failure mode worth
 * designing against.
 *
 * The server already keeps the roster we need. `whitelist` in the users DB has
 * an `INTEGER PRIMARY KEY AUTOINCREMENT`, so account age is an integer
 * comparison: everything at or below the id present when this feature was first
 * armed is pre-existing, and anything above it is an account that did not exist
 * before. That is one number in state rather than a copy of the roster, and it
 * cannot drift out of sync with the server because the server is the one
 * assigning the ids.
 *
 * WHY THE LOG AND NOT THE DATABASE FOR THE TRIGGER
 * The whitelist row is written when the account is created, which is not the
 * moment worth announcing — somebody who registers and then sits at the loading
 * screen has not arrived. `fully connected` in the user log is the arrival, and
 * it is the same line the rest of the integration already keys on.
 *
 * ANNOUNCED ONCE, EVER
 * A new account stays above the seed id forever, so the id test alone would
 * re-announce them on every login for the rest of the wipe. The names already
 * announced are kept alongside the seed — a short list, because it only ever
 * holds genuinely new players.
 */
const { getGuildConfig, guildIds, hasFeature } = require('../../config/guilds');
const { getGuildState, setGuildState } = require('../../storage/state');
const { linesSince } = require('./logs');
const { serverMessage, players } = require('./rcon');

const STATE_KEY = 'zomboidNewPlayers';

// `[18-08-26 07:12:03.123] 76561198316875401 "Phoenix" fully connected (2048,5689,0).`
// Same line `logs.js` counts sessions from; the username is the account name,
// never the RP character name, which lives only in players.db.
const JOINED = /^\[.+?\] (\d+) "(.+?)" fully connected/;

const DEFAULTS = {
  pollSeconds: 60,
  // In-game as well as Discord, per the standing rule for player-facing
  // announcements. Skipped when nobody else is on to read it.
  announceInGame: true,
  // No emoji, by standing instruction.
  message: '{name} just joined for the first time. Say hello.',
};

function newPlayersConfig(guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  if (!zomboid) return null;
  const channelId = zomboid.channels?.announcements;
  // Inert without both a channel to speak in and a roster to check against,
  // rather than guessing at either.
  if (!channelId || !zomboid.usersDb) return null;
  return {
    ...DEFAULTS,
    ...(zomboid.newPlayers || {}),
    channelId,
    usersDb: zomboid.usersDb,
    logDir: zomboid.logDir,
  };
}

/** This feature's slice of guild state, shape guaranteed. */
function readStore(guildId) {
  const raw = getGuildState(guildId)[STATE_KEY] || {};
  return {
    seedMaxId: typeof raw.seedMaxId === 'number' ? raw.seedMaxId : null,
    announced: Array.isArray(raw.announced) ? raw.announced : [],
  };
}

function writeStore(guildId, store) {
  const all = getGuildState(guildId);
  all[STATE_KEY] = store;
  setGuildState(guildId, all);
}

/**
 * Open the users DB read-only.
 *
 * Required lazily and read-only for the same reasons `players.js` does it:
 * `node:sqlite` is experimental and warns on first require, and this file has
 * no business being able to write to the server's account table.
 */
function openDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** Highest account id currently issued, or null if the DB cannot be read. */
function currentMaxId(dbPath) {
  let db;
  try {
    db = openDb(dbPath);
    const row = db.prepare('SELECT MAX(id) AS maxId FROM whitelist').get();
    return typeof row?.maxId === 'number' ? row.maxId : null;
  } catch (err) {
    console.warn('[Zomboid] Could not read whitelist:', err?.message || err);
    return null;
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

/** Account id for one username, or null if the account is unknown. */
function accountId(dbPath, username) {
  let db;
  try {
    db = openDb(dbPath);
    const row = db.prepare('SELECT id FROM whitelist WHERE username = ?').get(username);
    return typeof row?.id === 'number' ? row.id : null;
  } catch (err) {
    console.warn('[Zomboid] Could not look up account:', err?.message || err);
    return null;
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

/**
 * Record the roster as it stands, announcing nobody.
 *
 * Runs once, the first time this feature is armed. Everyone who already has an
 * account is pre-existing by definition — including anyone who registered but
 * has never actually connected. That errs toward silence, which is the right
 * direction: a missed greeting for one person beats eight hundred false ones.
 */
function seed(guildId, cfg) {
  const maxId = currentMaxId(cfg.usersDb);
  if (maxId === null) return null;
  const store = readStore(guildId);
  store.seedMaxId = maxId;
  writeStore(guildId, store);
  console.log(`[Zomboid] New-player announcements seeded at account id ${maxId}; ` +
    'existing accounts will not be announced.');
  return maxId;
}

/** Arrivals in the log window that are genuinely first-time. */
function firstTimeArrivals(cfg, store, sinceMs) {
  const seen = new Set();
  const out = [];

  for (const { line } of linesSince(cfg.logDir, 'user', sinceMs)) {
    const m = JOINED.exec(line);
    if (!m) continue;
    const username = m[2];

    // Cheap rejections first: the same player can appear several times in one
    // window, and an already-greeted player never needs a DB round trip.
    if (seen.has(username)) continue;
    seen.add(username);
    if (store.announced.includes(username)) continue;

    const id = accountId(cfg.usersDb, username);
    // Unknown account: say nothing. Either the DB is unreadable or the name
    // does not match a row, and neither is grounds for calling somebody new.
    if (id === null || id <= store.seedMaxId) continue;

    out.push({ username, steamid: m[1] });
  }

  return out;
}

// Only ever look forward from startup: a join that happened while the bot was
// down belongs to a session nobody is waiting on.
const watermark = new Map();

async function checkOnce(client, guildId) {
  const cfg = newPlayersConfig(guildId);
  if (!cfg) return [];

  let store = readStore(guildId);
  if (store.seedMaxId === null) {
    if (seed(guildId, cfg) === null) return [];
    store = readStore(guildId);
  }

  const since = watermark.get(guildId) ?? Date.now();
  const arrivals = firstTimeArrivals(cfg, store, since);
  watermark.set(guildId, Date.now());
  if (arrivals.length === 0) return [];

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);

  for (const { username } of arrivals) {
    const text = cfg.message.replace('{name}', username);

    if (channel) {
      await channel.send(text).catch((err) =>
        console.warn('[Zomboid] New-player announce failed:', err?.message || err));
    }

    // In-game too, but only if somebody is there to see it. servermsg is
    // instantaneous rather than persistent, so broadcasting to an empty server
    // reaches nobody — and the new arrival themselves counts as one player, so
    // it takes a second person to be worth sending.
    if (cfg.announceInGame) {
      try {
        const online = await players(guildId);
        if ((online?.count || 0) > 1) await serverMessage(guildId, text);
      } catch (err) {
        console.warn('[Zomboid] In-game welcome failed:', err?.message || err);
      }
    }

    // Recorded after the attempt, not before: a send that throws should still
    // not repeat forever, and a duplicate greeting is a worse outcome than a
    // missed one.
    store.announced.push(username);
    writeStore(guildId, store);
    console.log(`[Zomboid] Announced first-time arrival: ${username}`);
  }

  return arrivals;
}

/** Start polling for every guild with a Zomboid server configured. */
function scheduleNewPlayers(client) {
  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'zomboid')) continue;
    const cfg = newPlayersConfig(guildId);
    if (!cfg) continue;

    watermark.set(guildId, Date.now());

    setInterval(() => {
      checkOnce(client, guildId).catch((err) =>
        console.error('[Zomboid] New-player watch failed:', err?.message || err));
    }, cfg.pollSeconds * 1000);

    console.log(`[Zomboid] New-player announcements armed for ${guildId} every ${cfg.pollSeconds}s.`);
  }
}

module.exports = {
  newPlayersConfig,
  firstTimeArrivals,
  checkOnce,
  scheduleNewPlayers,
  seed,
  DEFAULTS,
};
