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
 * BOTH ENDS OF THE FILE API ARE ROOTED AT <Zomboid>/Lua, NOT THE ZOMBOID ROOT.
 *
 *   getFileReader("x")  reads  <Zomboid>/Lua/x
 *   getFileWriter("x")  writes <Zomboid>/Lua/x
 *
 * An earlier note here claimed the reader used the Zomboid root and only the
 * writer used Lua/ — a genuine-sounding asymmetry that was simply wrong, and it
 * cost every Discord-armed siege. Requests were written to the root, the mod
 * read Lua/, found nothing, and logged "idle, this is normal" once a minute
 * while a real request sat unread a directory away.
 *
 * Established by probe, not by reading: a cancel request placed in Lua/ was
 * picked up within seconds, while one in the root had been ignored for hours.
 * Getting this wrong is silent on both sides, which is exactly how it survived.
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

/**
 * Where the mod reads and writes: <Zomboid>/Lua.
 *
 * One helper so the request and status paths cannot drift apart again. Creates
 * the directory rather than assuming it — it exists on any server that has run
 * a Lua mod, but a fresh save would not have it and the failure would be silent.
 */
function luaDir(guildId) {
  const root = zomboidRoot(guildId);
  if (!root) return null;
  const dir = path.join(root, 'Lua');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
  return dir;
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
function arm(guildId, { town = null, zombies = 200, loot = 'high', silent = false } = {}) {
  const root = zomboidRoot(guildId);
  if (!root) throw new Error('No Zomboid save is configured for this guild.');

  // Refuse to arm over a siege that is genuinely under way. One event exists at
  // a time — one request file, one status file, one ModData slot — so a second
  // one supersedes the first, and superseding an active siege pulls the loot
  // and the horde out from under whoever is currently fighting it.
  //
  // Deliberately NOT refused for phase=armed: an armed event that never fires
  // (nobody has been near it) is exactly the case that needs replacing, and
  // blocking that would leave no way out of it from Discord.
  const running = status(guildId);
  if (running && (running.phase === 'active' || running.phase === 'broken')) {
    throw new Error(
      `Siege \`${running.id}\` is still running at ${running.x},${running.y} ` +
      `(${running.phase}, ${running.alive || 0} zombies alive). Wait for it to finish, ` +
      'or cancel it in-game with the staff right-click menu.',
    );
  }

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
    `loot=${loot}\n` +
    `silent=${silent ? 1 : 0}\n`;
  fs.writeFileSync(path.join(luaDir(guildId), REQUEST_FILE), body);
  return { id, ...house, zombies, loot, silent };
}

/**
 * Cancels the running siege.
 *
 * Exists because the in-game menu can only cancel the siege you are standing
 * next to, and a SILENT siege is by definition one whose location was never
 * announced — so without this there is no way to call one off short of finding
 * it. Writes a request carrying an id and the cancel flag and nothing else;
 * there is no location to cancel at, only whatever is currently running.
 *
 * The mod strips the site as part of retiring it, so this removes the loot and
 * the horde together rather than leaving a stocked house with nothing guarding
 * it.
 */
function cancel(guildId) {
  const root = zomboidRoot(guildId);
  if (!root) throw new Error('No Zomboid save is configured for this guild.');
  const id = Date.now();
  fs.writeFileSync(path.join(luaDir(guildId), REQUEST_FILE), `id=${id}\ncancel=1\n`);
  return { id };
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
  // Lua/ — see the note at the top: getFileWriter is rooted there, not at the
  // Zomboid root that getFileReader uses.
  let f = path.join(root, 'Lua', STATUS_FILE);
  if (!fs.existsSync(f)) {
    // Tolerate the root too, in case a future build changes the base dir.
    f = path.join(root, STATUS_FILE);
    if (!fs.existsSync(f)) return null;
  }
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

/** When the mod last wrote a status, or null. Used to show staleness. */
function statusTime(guildId) {
  const root = zomboidRoot(guildId);
  if (!root) return null;
  for (const f of [path.join(root, 'Lua', STATUS_FILE), path.join(root, STATUS_FILE)]) {
    try { return fs.statSync(f).mtime; } catch { /* try the next */ }
  }
  return null;
}

module.exports = { arm, cancel, status, statusTime, houses, towns, modEnabled, zomboidRoot };
