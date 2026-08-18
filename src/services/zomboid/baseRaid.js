'use strict';
/**
 * Base raids — the Discord half of the WabbajackBaseRaid server module.
 *
 * WHY THIS IS NOT JUST `/pz raid` WITH DIFFERENT COORDINATES
 * `createhorde2` resolves its target through `getGridSquare` and answers
 * `invalid location` for a chunk that is not streamed. On a dedicated server the
 * only streamed chunks are those around online players — so aiming a horde at
 * somebody's base *while they are out looting*, which is the entire point of the
 * feature, targets an unloaded chunk and fails every single time. Retrying does
 * not help; there is nothing to retry into. RCON cannot do this at all.
 *
 * So the horde is armed rather than spawned, and the mod materialises it the
 * moment the area streams in — 60–95 tiles out, against the ~30 a player can
 * see. They drive home, the chunk loads while they are still short of it, and
 * the horde is standing at the walls when they arrive. Nobody watches zombies
 * appear, and unlike the spawn-around-the-player version it behaves identically
 * at road speed, where a position read is stale before the command lands.
 *
 * COORDINATES ARE DELIBERATELY NOT SENT
 * This writes only "how many, for how long". Claims are created and released
 * while the server runs, and the mod's `SafeHouse.getSafehouseList()` is live,
 * whereas anything this side parses out of `map_meta.bin` is as old as the last
 * save. One source of truth, and it is the one inside the game.
 */
const fs = require('fs');
const path = require('path');
const siege = require('./siege');
const { getGuildConfig } = require('../../config/guilds');

const REQUEST_FILE = 'wabbajack_raid.txt';
const STATUS_FILE = 'wabbajack_raid_status.txt';

const DEFAULTS = {
  perPlayer: 40,
  // Minutes an armed raid waits for somebody to go near the claim before it is
  // written off. Long enough to cover a play session, short enough that it does
  // not fire days later on a base whose owner has forgotten it was coming.
  expire: 180,
};

/**
 * Whether the server actually has the base-raid module on disk.
 *
 * `siege.modEnabled` only proves WabbajackSiege is in the ini's Mods list, and
 * the base-raid module shipped in a later version of that same mod — so a
 * server running the older build passes that check and then silently ignores
 * the request file, which is exactly the failure this codebase keeps getting
 * bitten by. Checking for the file itself is the only honest test.
 */
function moduleInstalled(guildId) {
  const dir = getGuildConfig(guildId)?.zomboid?.workshopDir;
  if (!dir) return false;
  let items = [];
  try { items = fs.readdirSync(dir); } catch { return false; }
  return items.some((id) => fs.existsSync(path.join(
    dir, id, 'mods/WabbajackSiege/common/media/lua/server/WabbajackBaseRaid.lua')));
}

/**
 * Arms a base raid.
 *
 * The id is a timestamp, and the mod records every id it has run, so a repeated
 * command or a request file left on disk across a restart cannot re-arm one.
 */
function arm(guildId, { perPlayer = DEFAULTS.perPlayer, expire = DEFAULTS.expire } = {}) {
  const root = siege.zomboidRoot(guildId);
  if (!root) throw new Error('No Zomboid save is configured for this guild.');

  // <Zomboid>/Lua, not the Zomboid root. getFileReader is rooted there, which
  // is why every raid armed before this landed in a directory the mod does not
  // read — silently, because a missing request is indistinguishable from idle.
  const dir = path.join(root, 'Lua');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
  const id = Date.now();
  const body = `id=${id}\nperPlayer=${perPlayer}\nexpire=${expire}\n`;
  fs.writeFileSync(path.join(dir, REQUEST_FILE), body);
  return { id, perPlayer, expire };
}

/**
 * Last status the mod wrote, or null.
 *
 * Lives under Lua/ for the same reason the siege status does: getFileWriter is
 * rooted at <Zomboid>/Lua while getFileReader is rooted at <Zomboid>.
 */
function status(guildId) {
  const root = siege.zomboidRoot(guildId);
  if (!root) return null;
  let f = path.join(root, 'Lua', STATUS_FILE);
  if (!fs.existsSync(f)) {
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

module.exports = { arm, status, moduleInstalled, DEFAULTS };
