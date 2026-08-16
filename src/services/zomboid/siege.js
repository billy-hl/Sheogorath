'use strict';
/**
 * Siege events — the Discord half of the WabbajackSiege server mod.
 *
 * The split exists because neither side can do the job alone. RCON cannot put
 * loot in a building (`additem` targets a *player*) and cannot touch an unloaded
 * chunk, so the placement has to happen inside the game. But the game has no way
 * to reach Discord, pick a house from map data, or be driven by a slash command.
 *
 * So: this writes a request file, the mod polls it once a minute and does the
 * work, and writes a status file back. A file rather than a socket because the
 * PZ Lua sandbox exposes getFileReader/getFileWriter relative to the Zomboid
 * folder and nothing else — no network, no IPC.
 *
 * Both files live in the Zomboid root (the same directory that holds Saves/ and
 * Logs/), which is what getFileReader resolves against.
 */
const fs = require('fs');
const path = require('path');
const { getGuildConfig } = require('../../config/guilds');
const raid = require('./raid');

/**
 * Keep-out radius around player claims, in tiles.
 *
 * This is the single most important number in this file. Players may claim ANY
 * building on this server, and the mod's cleanup strips every container and
 * every ground item in the target building — so arming a siege on a claimed
 * house would delete somebody's entire base and drop 200 zombies on it. The
 * radius is measured from the claim rectangle, and generous because the cost of
 * skipping a candidate house is nothing at all.
 */
const SAFEHOUSE_BUFFER = 150;

const REQUEST_FILE = 'wabbajack_siege.txt';
const STATUS_FILE = 'wabbajack_siege_status.txt';

/**
 * The Zomboid root for a guild's server.
 *
 * Derived from playersDb (…/Saves/Multiplayer/<server>/players.db) rather than
 * configured separately, so there is one path to get wrong instead of two.
 */
function zomboidRoot(guildId) {
  const db = getGuildConfig(guildId)?.zomboid?.playersDb;
  if (!db) return null;
  return path.resolve(path.dirname(db), '..', '..', '..');
}

function gameDir(guildId) {
  return getGuildConfig(guildId)?.zomboid?.gameDir || null;
}

/** map_meta.bin for a guild — where the safehouse claims live. */
function paths_mapMeta(guildId) {
  const p = raid.savePaths(guildId);
  if (!p) throw new Error('No Zomboid save is configured for this guild.');
  return p.mapMeta;
}

/**
 * Candidate houses, read from the map's own spawnpoints.
 *
 * These are the buildings the game itself starts players in, so every one is a
 * real, enterable house with furniture — which matters, because the mod stocks
 * containers and a shed with none would silently deliver nothing. Picking a
 * random point in a TownZone would give no such guarantee.
 */
function houses(guildId) {
  const dir = gameDir(guildId);
  if (!dir) return [];
  const maps = path.join(dir, 'media/maps');
  // Never throws: this feeds autocomplete, and an exception there leaves the
  // user staring at a broken picker with no error to explain it.
  let towns_ = [];
  try { towns_ = fs.readdirSync(maps); } catch { return []; }
  const out = [];
  for (const town of towns_) {
    const f = path.join(maps, town, 'spawnpoints.lua');
    if (!fs.existsSync(f)) continue;
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/posX\s*=\s*(\d+)\s*,\s*posY\s*=\s*(\d+)/g)) {
      out.push({ town, x: Number(m[1]), y: Number(m[2]) });
    }
  }
  return out;
}

/** Distinct town names that have candidate houses. */
function towns(guildId) {
  return [...new Set(houses(guildId).map((h) => h.town))].sort();
}

/**
 * Arms an event: picks a house and writes the request the mod is waiting for.
 *
 * The id is a timestamp and is what makes this idempotent — the mod records
 * every id it has run and refuses to repeat one, so a duplicated command or a
 * file left on disk after a restart cannot re-arm an event that already fired.
 */
function arm(guildId, { town = null, zombies = 200, loot = 'high' } = {}) {
  const root = zomboidRoot(guildId);
  if (!root) throw new Error('No Zomboid save is configured for this guild.');

  let pool = houses(guildId);
  if (!pool.length) throw new Error('No candidate houses found in the map files.');
  if (town) {
    const want = town.toLowerCase();
    pool = pool.filter((h) => h.town.toLowerCase().startsWith(want));
    if (!pool.length) throw new Error(`No houses found for "${town}".`);
  }

  // Never a claimed building, and never near one. The mod strips the target
  // house bare when the loot timer expires; on a claimed house that is somebody
  // losing everything they own to an event they did not opt into.
  //
  // Fails closed: if the safehouse list cannot be read we refuse to arm rather
  // than arm blind, because the failure mode here is not "the event is a bit
  // off", it is "a player's base is destroyed".
  let claims;
  try {
    claims = raid.readSafehouses(paths_mapMeta(guildId));
  } catch (err) {
    throw new Error(
      `Could not read the safehouse list, so no house can be confirmed unclaimed: ${err.message}`,
    );
  }
  const clear = pool.filter((h) =>
    !claims.some((s) => raid.distToSafehouse(h.x, h.y, s) < SAFEHOUSE_BUFFER));
  if (!clear.length) {
    throw new Error(
      `Every candidate house${town ? ` in ${town}` : ''} is within ${SAFEHOUSE_BUFFER} tiles ` +
      `of a player claim (${claims.length} claims). Try another town.`,
    );
  }
  pool = clear;

  const house = pool[Math.floor(Math.random() * pool.length)];
  const id = Date.now();
  const body =
    `id=${id}\n` +
    `x=${house.x}\n` +
    `y=${house.y}\n` +
    `z=0\n` +
    `zombies=${zombies}\n` +
    `loot=${loot}\n`;
  fs.writeFileSync(path.join(root, REQUEST_FILE), body);
  return { id, ...house, zombies, loot };
}

/**
 * Last status the mod wrote, or null if it has not reported yet.
 *
 * phase is one of: armed (waiting for the area to stream in), active (loot and
 * horde placed), broken (85% of the horde dead, cleanup pending), done.
 */
function status(guildId) {
  const root = zomboidRoot(guildId);
  if (!root) return null;
  const f = path.join(root, STATUS_FILE);
  if (!fs.existsSync(f)) return null;
  const out = {};
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return Object.keys(out).length ? out : null;
}

/** Whether the mod is installed and enabled — a siege does nothing without it. */
function modEnabled(guildId) {
  const ini = getGuildConfig(guildId)?.zomboid?.serverIni;
  if (!ini || !fs.existsSync(ini)) return false;
  const m = fs.readFileSync(ini, 'utf8').match(/^Mods=(.*)$/m);
  return !!m && m[1].split(';').some((s) => s.trim() === 'WabbajackSiege');
}

module.exports = { arm, status, houses, towns, modEnabled, zomboidRoot };
