'use strict';
/**
 * PvP kill records, built from the Project Zomboid `pvp` log.
 *
 * The pvp log is the one place the server attributes a death to whoever caused
 * it. Alongside the safehouse-safety and per-swing combat noise it writes one
 * line per player kill:
 *
 *   [30-07-26 00:46:06.337][IMPORTANT] Kill: "Poke" (11442,8768,0) killed "FracturedArmor" (11442,8767,0).
 *
 * Note the stamp runs straight into `[IMPORTANT]` with no space, unlike the
 * `user` and PerkLog formats.
 *
 * **This is PvP only, and that is a hard limit, not an oversight.** Players do
 * see a zombie kill count in game, so the absence of one here looks like a bug
 * until you go looking. It isn't:
 *
 *   - `getZombieKills()` is real, but every caller in the game files is
 *     client-side UI — `ISCharacterScreen.lua`, `ISPlayerStatsUI.lua`,
 *     `ISPostDeathUI.lua`, all under `media/lua/client/`. Nothing under
 *     `media/lua/server/` reads it and nothing logs it, so the number is a live
 *     field rendered by the player's own client and never recorded server-side.
 *   - No log kind the server produces carries a zombie counter. PerkLog's event
 *     types are Login, Died, Created Player, Level Changed and skill dumps.
 *   - It *is* persisted, inside the serialized player blob in `players.db`
 *     (`localPlayers`/`networkPlayers`, one `data` BLOB column) — but the field
 *     offset can't be validated without ground truth to check it against, and a
 *     wrong number on a public board is worse than no board.
 *
 * Getting it would take a server-side Lua mod calling `getZombieKills()` and
 * writing it somewhere readable. Until that exists, any board here must say
 * "players killed" out loud, so nobody reads it as a zombie count.
 *
 * Players are keyed by **name**, not Steam ID — the pvp log never writes one.
 * That is consistent within this log: a rename changes the name in every line
 * from that point, so the log stays self-consistent even though it can't be
 * joined to the PerkLog records by identity. As everywhere else in the PZ
 * tooling, these names are the *account username*, not the RP character name.
 */
const { linesSince } = require('./logs');

// Reach across every rotated log directory — these are all-time records, so
// unlike the 24h consumers this wants the full history. Matches the constant in
// leaderboard.js for the same reason.
const ALL_HISTORY_DIRS = 400;

// `[IMPORTANT] Kill: "Poke" (11442,8768,0) killed "FracturedArmor" (11442,8767,0).`
// `[^"]*` rather than a lazy `.+?` so a name can never swallow the closing quote.
const KILL =
  /^\[.+?\]\[IMPORTANT\] Kill: "([^"]*)" \((-?\d+),(-?\d+),(-?\d+)\) killed "([^"]*)" \((-?\d+),(-?\d+),(-?\d+)\)/;

function blank(name) {
  return {
    name,
    kills: 0,
    /** Deaths *at another player's hands* — not the all-cause death count. */
    deaths: 0,
    /** @type {Map<string, number>} who they killed, and how often */
    victims: new Map(),
    /** @type {Map<string, number>} who killed them, and how often */
    killers: new Map(),
    /** Consecutive kills without dying — running value and all-time best. */
    streak: 0,
    bestStreak: 0,
    firstAt: -1,
    lastKillAt: -1,
    lastSeen: -1,
  };
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/**
 * Parse every kill in the log history.
 *
 * @param {string} logDir
 * @returns {{
 *   events: Array<{at:number, killer:string, victim:string, pos:string}>,
 *   players: Map<string, ReturnType<typeof blank>>,
 * }}
 */
function collectKills(logDir) {
  const events = [];
  for (const { at, line } of linesSince(logDir, 'pvp', 0, ALL_HISTORY_DIRS)) {
    const m = KILL.exec(line);
    if (!m) continue;
    events.push({ at, killer: m[1], victim: m[5], pos: `${m[6]},${m[7]},${m[8]}` });
  }

  // Files are read newest-directory-first, so lines arrive out of order. Streaks
  // are order-dependent, so sort before folding rather than trusting the walk.
  events.sort((a, b) => a.at - b.at);

  const players = new Map();
  const rec = (name) => {
    if (!players.has(name)) players.set(name, blank(name));
    return players.get(name);
  };

  for (const ev of events) {
    const victim = rec(ev.victim);
    victim.deaths++;
    bump(victim.killers, ev.killer);
    victim.streak = 0;
    if (victim.firstAt < 0) victim.firstAt = ev.at;
    victim.lastSeen = ev.at;

    // A player listed as their own killer is an environmental or self-inflicted
    // death the server attributed back to them. It is a death, never a kill —
    // otherwise suicide would climb the board.
    if (ev.killer === ev.victim) continue;

    const killer = rec(ev.killer);
    killer.kills++;
    bump(killer.victims, ev.victim);
    killer.streak++;
    if (killer.streak > killer.bestStreak) killer.bestStreak = killer.streak;
    if (killer.firstAt < 0) killer.firstAt = ev.at;
    killer.lastKillAt = ev.at;
    killer.lastSeen = ev.at;
  }

  return { events, players };
}

/**
 * Kill/death ratio.
 *
 * With no deaths on record there is no ratio to take, so the caller gets `null`
 * and can render that honestly rather than showing a fake `kills/1`.
 */
function kd(r) {
  return r.deaths ? r.kills / r.deaths : null;
}

/** `kd` as a display string — `∞` when they have never been killed. */
function fmtKd(r) {
  const ratio = kd(r);
  return ratio === null ? (r.kills ? '∞' : '—') : ratio.toFixed(2);
}

/** The single name a player killed most, with the count. */
function topEntry(map) {
  let best = null;
  for (const [name, count] of map) {
    // Ties break on name so repeated calls agree with each other.
    if (!best || count > best.count || (count === best.count && name < best.name)) {
      best = { name, count };
    }
  }
  return best;
}

/**
 * Rank records by `value`, dropping zero/negative scores.
 * Ties break on name so the order is stable between calls.
 */
function rank(players, value, { limit = 10 } = {}) {
  const rows = [];
  for (const r of players.values()) {
    const v = value(r);
    if (!Number.isFinite(v) || v <= 0) continue;
    rows.push({ name: r.name, value: v, rec: r });
  }
  rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return rows.slice(0, limit);
}

/**
 * The most one-sided repeat matchups — `killer` has killed `victim` this often.
 * Only pairs that happened more than once are interesting.
 */
function rivalries(players, { limit = 5, min = 2 } = {}) {
  const out = [];
  for (const r of players.values()) {
    for (const [victim, count] of r.victims) {
      if (count < min) continue;
      out.push({ killer: r.name, victim, count });
    }
  }
  out.sort(
    (a, b) =>
      b.count - a.count || a.killer.localeCompare(b.killer) || a.victim.localeCompare(b.victim),
  );
  return out.slice(0, limit);
}

/** Most recent kills first. */
function recent(events, { limit = 5 } = {}) {
  return events.slice(-limit).reverse();
}

module.exports = {
  collectKills,
  kd,
  fmtKd,
  topEntry,
  rank,
  rivalries,
  recent,
};
