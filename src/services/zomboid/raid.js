'use strict';
/**
 * Horde events: staged zombie spawns around the players themselves.
 *
 * Lives here rather than in the script so `/pz raid` and
 * `scripts/pz-horde-waves.js` share one implementation. The script is the
 * rehearsal tool (dry runs, distance probing); this is the same engine.
 *
 * WHY THE DISTANCE BAND IS NARROW
 * `CreateHorde2Command` resolves the square via `getGridSquare(x,y,z)` and
 * prints `invalid location` — spawning nothing, exiting 0 — when it comes back
 * null. On a dedicated server the only loaded chunks are those streamed around
 * online players, and the radius is per-client (`LoadedAreas` reads
 * `onlineChunkGridWidth` off each `UdpConnection`), so it varies by player.
 * Measured on this server: ~18% of spawns at 60-80 tiles came back `invalid
 * location`. Closer is more reliable; too close and the player watches them
 * appear. Hence 45-70 by default.
 *
 * WHY THEY WALK TOWARDS THE PLAYER
 * Not sight — this world runs Sight=Random-Normal-to-Poor. It is hearing:
 * Hearing=Pinpoint, Memory=Long, and `FollowSoundDistance` (100 here) is the
 * range over which a zombie will walk towards the last noise it heard. Spawn
 * inside that and ordinary player noise pulls them in; spawn outside it and
 * they mill about where they landed. That ceiling, not the load radius, is why
 * `far` should stay well under 100.
 *
 * WHAT MAKES THIS IRREVERSIBLE
 * `ZombieRespawn=None` on this server and there is no RCON command that removes
 * zombies. Every spawn that lands is permanent until a player kills it, which
 * is why `maxTotal` exists and why every attempt is logged as it happens rather
 * than buffered — a crash mid-event must not lose the record of what was let
 * loose. RCON spawns appear in none of the server's own logs.
 */
const fs = require('fs');
const path = require('path');
const { rcon } = require('./rcon');
const { getGuildConfig } = require('../../config/guilds');

/** Engine clamp inside CreateHorde2Command; it truncates silently past this. */
const MAX_PER_COMMAND = 500;

const DEFAULTS = {
  perPlayer: 40,
  duration: 300,
  waves: 5,
  near: 45,
  far: 70,
  spread: 6,
  maxTotal: 900,
  safeBuffer: 10,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Distance from a point to a safehouse rectangle; 0 when inside it. */
function distToSafehouse(x, y, s) {
  const dx = Math.max(s.x - x, 0, x - (s.x + s.w));
  const dy = Math.max(s.y - y, 0, y - (s.y + s.h));
  return Math.hypot(dx, dy);
}

/**
 * Reads the safehouse table out of map_meta.bin.
 *
 * No RCON command lists safehouses, and the `Safehouse added (x;y)` line in
 * SafeHouse.java sits behind the Multiplayer debug channel, which is off — so
 * the save file is the only source.
 *
 * IsoMetaGrid writes `nSafehouse` followed by that many records, but at no
 * fixed offset: the blocks ahead of it grow as the world is explored. Rather
 * than seek to a constant, this walks candidate offsets from the tail and keeps
 * the first that parses cleanly to the end — a wrong offset desyncs almost
 * immediately, because the UTF length prefixes stop landing on plausible
 * strings.
 */
function readSafehouses(file) {
  const d = fs.readFileSync(file);
  const plausible = (r) =>
    r.x > 0 && r.x < 30000 && r.y > 0 && r.y < 30000 &&
    r.w > 0 && r.w < 1000 && r.h > 0 && r.h < 1000 && r.owner.length > 0;

  const tryAt = (start) => {
    let p = start;
    const i32 = () => { const v = d.readInt32BE(p); p += 4; return v; };
    const i64 = () => { const v = d.readBigInt64BE(p); p += 8; return Number(v); };
    const utf = () => {
      const n = d.readUInt16BE(p); p += 2;
      if (n > 512 || p + n > d.length) throw new Error('bad utf');
      const s = d.subarray(p, p + n).toString('utf8'); p += n; return s;
    };
    const n = i32();
    if (n < 1 || n > 5000) throw new Error('bad count');
    const out = [];
    for (let k = 0; k < n; k++) {
      const x = i32(), y = i32(), w = i32(), h = i32();
      const owner = utf();
      i32();
      const np = i32();
      if (np < 0 || np > 500) throw new Error('bad members');
      const members = [];
      for (let j = 0; j < np; j++) members.push(utf());
      const lastVisited = i64();
      const title = utf();
      const created = i64();
      // Stored region is the OWNER'S SPAWN TOWN, not where the building is —
      // do not use it to locate anything.
      const region = utf();
      const nb = i32();
      if (nb < 0 || nb > 5000) throw new Error('bad list');
      for (let j = 0; j < nb; j++) utf();
      const rec = { x, y, w, h, owner, title, members, lastVisited, created, region };
      if (!plausible(rec)) throw new Error('implausible');
      out.push(rec);
    }
    return out;
  };

  for (let off = d.length - 16; off > Math.max(0, d.length - 400000); off -= 1) {
    try {
      const r = tryAt(off);
      if (r.length >= 1) return r;
    } catch { /* wrong offset */ }
  }
  throw new Error('could not locate the safehouse block in map_meta.bin');
}

/** Current player positions, keyed by account username. Read-only. */
function readPositions(playersDb) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(playersDb, { readOnly: true });
  try {
    // Ascending id so the newest character for an account wins, matching
    // services/zomboid/players.js.
    const rows = db.prepare(
      'SELECT username, x, y, z FROM networkPlayers ORDER BY id ASC'
    ).all();
    const m = new Map();
    for (const r of rows) if (r.username) m.set(r.username, r);
    return m;
  } finally { db.close(); }
}

/** Paths for a guild's save, derived from playersDb so no new config is needed. */
function savePaths(guildId) {
  const z = getGuildConfig(guildId)?.zomboid;
  if (!z?.playersDb) return null;
  return {
    playersDb: z.playersDb,
    mapMeta: z.mapMeta || path.join(path.dirname(z.playersDb), 'map_meta.bin'),
  };
}

/**
 * Picks a spawn point in the band around a player that is clear of every
 * safehouse. Returns null when nothing qualifies — which happens when the
 * player is deep inside a large claim, and is reported rather than nudged,
 * since silently spawning inside somebody's walls is the worst outcome.
 */
function pickPoint(p, safehouses, { near, far, safeBuffer }) {
  const mid = (near + far) / 2;
  const jitter = (far - near) / (near + far);
  for (let i = 0; i < 24; i++) {
    // Golden-angle stride scatters the arc instead of marching around it.
    const ang = i * 2.399963 + Math.random() * jitter;
    const rr = mid * (1 + (Math.random() * 2 - 1) * jitter);
    const x = Math.round(p.x + Math.cos(ang) * rr);
    const y = Math.round(p.y + Math.sin(ang) * rr);
    if (x < 1 || y < 1 || x > 23000 || y > 18000) continue;
    const d0 = dist(x, y, p.x, p.y);
    if (d0 < near || d0 > far) continue;
    if (safehouses.some((s) => distToSafehouse(x, y, s) < safeBuffer)) continue;
    return { x, y, d: Math.round(d0) };
  }
  return null;
}

/**
 * Runs a horde event.
 *
 * Positions are re-read every wave: over five minutes people walk, drive and
 * die, and aiming wave five at where somebody stood in wave one drops a horde
 * in an empty field. Anyone who has moved more than `driveThreshold` since the
 * last wave is skipped as "in a vehicle" — at road speed the read is already
 * stale by more than the whole band is wide.
 *
 * @param {string} guildId
 * @param {object} opts
 * @param {(e: object) => void} [onEvent] progress callback, called per spawn
 * @returns {Promise<{spawned:number,ok:number,miss:number,skipped:number,perPlayer:object}>}
 */
async function runRaid(guildId, opts = {}, onEvent = () => {}) {
  const o = { ...DEFAULTS, ...opts };
  const paths = savePaths(guildId);
  if (!paths) throw new Error('No Zomboid save is configured for this guild.');

  const safehouses = readSafehouses(paths.mapMeta);
  const waves = Math.max(1, o.waves);
  const perWave = Math.min(Math.ceil(o.perPlayer / waves), MAX_PER_COMMAND);
  const gap = Math.round((o.duration / waves) * 1000);
  const driveThreshold = o.far * 1.5;

  const tally = { spawned: 0, ok: 0, miss: 0, skipped: 0, perPlayer: {} };
  let previous = new Map();

  for (let w = 0; w < waves; w++) {
    const { names } = await require('./rcon').players(guildId);
    const positions = readPositions(paths.playersDb);
    let live = names.map((n) => positions.get(n)).filter((p) => p && Number.isFinite(p.x));
    if (o.only) {
      live = live.filter((p) => p.username.toLowerCase() === String(o.only).toLowerCase());
    }

    for (const p of live) {
      if (tally.spawned + perWave > o.maxTotal) {
        onEvent({ kind: 'budget', maxTotal: o.maxTotal });
        w = waves;
        break;
      }

      const prev = previous.get(p.username);
      if (prev && dist(p.x, p.y, prev.x, prev.y) > driveThreshold) {
        tally.skipped++;
        onEvent({ kind: 'skip', player: p.username, reason: 'moving too fast (vehicle)' });
        continue;
      }

      const pt = pickPoint(p, safehouses, o);
      if (!pt) {
        tally.skipped++;
        onEvent({ kind: 'skip', player: p.username, reason: 'no clear point outside a claim' });
        continue;
      }

      if (o.dryRun) {
        tally.spawned += perWave;
        onEvent({ kind: 'dry', player: p.username, ...pt, count: perWave });
        continue;
      }

      let reply = '';
      try {
        reply = await rcon(guildId,
          `createhorde2 -x ${pt.x} -y ${pt.y} -z 0 -count ${perWave} -radius ${o.spread}`);
      } catch (err) {
        reply = `ERROR ${err?.message || err}`;
      }
      // `invalid location` means the square was not streamed: nothing spawned,
      // and the command still exits cleanly, so the text is the only signal.
      const ok = !/invalid location/i.test(reply);
      if (ok) { tally.ok++; tally.spawned += perWave; } else { tally.miss++; }
      tally.perPlayer[p.username] = (tally.perPlayer[p.username] || 0) + (ok ? perWave : 0);
      onEvent({ kind: ok ? 'ok' : 'miss', player: p.username, ...pt, count: perWave, reply });

      await sleep(400);                       // don't burst the RCON queue
    }

    previous = new Map(live.map((p) => [p.username, p]));
    if (w < waves - 1) await sleep(o.dryRun ? 0 : gap);
  }

  return tally;
}

module.exports = {
  runRaid,
  readSafehouses,
  readPositions,
  savePaths,
  pickPoint,
  distToSafehouse,
  DEFAULTS,
  MAX_PER_COMMAND,
};
