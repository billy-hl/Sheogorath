#!/usr/bin/env node
'use strict';
/**
 * One-shot seeding of modded vehicles into the world.
 *
 * WHY THIS EXISTS
 * Vehicles are placed when a chunk is first generated. The vehicle mods landed
 * on 2026-08-10 and later, but the world started 2026-07-29, so everywhere
 * explored before then is locked to the vanilla cars it generated with. The
 * result: 36 modded vehicles in a world of 6,201 (0.58%, ~1 in 170), and
 * players crossing the map without seeing one.
 *
 * WHY OFFLINE AND NOT RCON
 * `addvehicle` resolves the target with getGridSquare and fails with "I can not
 * spawn the vehicle. Invalid position." when the chunk is not streamed — which
 * means it only works next to an online player. Seeding the whole map that way
 * is impossible. vehicles.db is the single source of truth for placement (no
 * sampled chunkdata file references a vehicle script, and only 16 of 6,201 rows
 * are inMeta=1), so writing it directly while the server is stopped is the only
 * route that reaches the rest of the map.
 *
 * WHY IT ONLY ADDS, NEVER REPLACES
 * The brief was to leave player-owned vehicles alone — specifically hotwired
 * cars and ones whose keys a player carries. Neither is reliably detectable:
 * `hotwired` is a boolean byte with no string marker (0 of 6,201 blobs contain
 * the literal) and key ownership needs a numeric keyId matched across two
 * undocumented binary formats. A false positive deletes somebody's car for
 * good. Adding only makes the question moot: nothing owned can be lost if
 * nothing is removed. The cost is that the world's vehicle count grows.
 *
 * HOW A VEHICLE IS CREATED
 * Not built from scratch — the blob is ~8KB of parts, condition and skin data
 * that is not mapped. Instead an existing vehicle of the wanted type is cloned
 * and only its position patched: world x/y are big-endian floats at 0x0a/0x0e,
 * and the row's wx/wy are floor(x/8) (B42 chunks are 8 tiles). The row id is
 * not embedded in the blob, so a fresh id is safe. This means only types that
 * already exist somewhere can be seeded — see --templates.
 *
 * SAFETY
 * Refuses to run while the container is up, backs the database up first, is a
 * dry run unless --go, and writes a marker so it cannot run twice.
 *
 * Usage:
 *   node scripts/pz-seed-vehicles.js --templates
 *   node scripts/pz-seed-vehicles.js --count 450
 *   node scripts/pz-seed-vehicles.js --count 450 --go
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const raid = require(path.join(ROOT, 'src/services/zomboid/raid'));

const GUILD = process.env.PZ_GUILD_ID || '444601986160263189';
const GAME_DIR = process.env.PZ_GAME_DIR
  || '/home/allisteras/gameservers/zomboid/gamefiles';
const MARKER = process.env.PZ_SEED_MARKER
  || '/var/lib/leviathan/zomboid_vehicles_seeded';

// Keep-out radii. A safehouse is player territory; a last-known player position
// is where somebody is actually based. Both are generous on purpose — the cost
// of skipping a site is nothing, the cost of dropping a camper in somebody's
// driveway is a support ticket.
const SAFEHOUSE_BUFFER = 200;
const PLAYER_BUFFER = 120;
// Two vehicles in the same square is a broken world, so seeded vehicles keep
// clear of every existing one and of each other.
const MIN_SPACING = 6;
// A parking stall is only worth filling if nothing is parked there already.
const STALL_OCCUPIED = 4;

const X_OFF = 0x0a;   // big-endian float: world x
const Y_OFF = 0x0e;   // big-endian float: world y

// Where --spawn-missing records what it created, so a later --delete-templates
// removes exactly those and never a vehicle that was always in the world.
const TEMPLATE_STATE = process.env.PZ_SEED_TEMPLATES
  || '/home/allisteras/.local/state/zomboid_seed_templates.json';

function parseArgs(argv) {
  const o = {
    count: 450, go: false, templates: false, force: false, seed: 20260816,
    spawnMissing: null, deleteTemplates: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--count': o.count = Number(next()); break;
      case '--go': o.go = true; break;
      case '--templates': o.templates = true; break;
      case '--spawn-missing': o.spawnMissing = next(); break;
      case '--delete-templates': o.deleteTemplates = true; break;
      case '--force': o.force = true; break;      // ignore the run-once marker
      case '--seed': o.seed = Number(next()); break;
      default:
        if (a.startsWith('--')) { console.error(`unknown flag ${a}`); process.exit(2); }
    }
  }
  return o;
}

/** Deterministic RNG so a dry run and the real run choose the same sites. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Vehicle script names defined by SERVED mods but not by the base game.
 *
 * Restricting to WorkshopItems is not tidiness — the workshop folder holds
 * ~1.7GB of orphaned mods this server does not serve (722 vehicle scripts
 * against 41 that are actually live). Seeding a type from an unserved mod would
 * put a vehicle in the world that no connecting client has the files for.
 */
function modOnlyScripts(servedIds) {
  const grab = (dir) => {
    let out = '';
    try {
      out = execFileSync('grep', ['-rhoE', '^\\s*vehicle\\s+[A-Za-z0-9_]+', dir,
        '--include=*.txt'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    } catch { /* grep exits 1 when nothing matches */ }
    return new Set(out.split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean));
  };
  const vanilla = grab(path.join(GAME_DIR, 'media/scripts'));
  const root = path.join(GAME_DIR, 'steamapps/workshop/content/108600');
  const served = new Set();
  for (const id of servedIds) {
    const dir = path.join(root, id);
    if (!fs.existsSync(dir)) continue;
    for (const n of grab(dir)) served.add(n);
  }
  return [...served].filter((n) => !vanilla.has(n));
}

/**
 * Parking zones from the map's own objects.lua.
 *
 * This is the data the game itself uses to decide where a car belongs, which is
 * the only way to make seeded vehicles look native. The earlier approach —
 * offsetting a few tiles from an existing vehicle — produced cars in ditches,
 * gardens and farm fields, because a roadside wreck's neighbouring tiles are
 * not parkable.
 *
 * ParkingStall carries a name for the special cases ("trafficjamn" and friends
 * are queues of abandoned traffic, not car parks); an empty name is an ordinary
 * stall. TrailerPark is where the campers and trailers belong, matching the
 * zones the mods' own SpawnList targets.
 */
function parkingZones() {
  const file = path.join(GAME_DIR, 'media/maps/Muldraugh, KY/objects.lua');
  const src = fs.readFileSync(file, 'utf8');
  const re = /\{\s*name\s*=\s*"([^"]*)",\s*type\s*=\s*"(ParkingStall|TrailerPark)",\s*x\s*=\s*(\d+),\s*y\s*=\s*(\d+),\s*z\s*=\s*(\d+),\s*width\s*=\s*(\d+),\s*height\s*=\s*(\d+)/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const [, name, type, x, y, z, w, h] = m;
    if (Number(z) !== 0) continue;              // ground floor only
    out.push({ name, type, x: +x, y: +y, w: +w, h: +h });
  }
  return out;
}

/** Workshop item ids the server actually loads, from the generated ini. */
function servedWorkshopIds() {
  const ini = require(path.join(ROOT, 'src/config/guilds'))
    .getGuildConfig(GUILD)?.zomboid?.serverIni;
  if (!ini) throw new Error('no serverIni configured for this guild');
  const m = fs.readFileSync(ini, 'utf8').match(/^WorkshopItems=(.*)$/m);
  return (m ? m[1] : '').split(';').map((s) => s.trim()).filter(Boolean);
}

function openDb(file, readOnly) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly });
}

function containerRunning() {
  try {
    const s = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'zomboid'],
      { encoding: 'utf8' }).trim();
    return s === 'true';
  } catch { return false; }   // no docker / no such container = not running
}

function main() {
  const o = parseArgs(process.argv);
  const paths = raid.savePaths(GUILD);
  if (!paths) { console.error('no Zomboid save configured'); process.exit(2); }
  const vehiclesDb = path.join(path.dirname(paths.playersDb), 'vehicles.db');

  const served = servedWorkshopIds();
  const modScripts = new Set(modOnlyScripts(served));
  const db = openDb(vehiclesDb, true);
  const rows = db.prepare('SELECT id, x, y, worldversion, data FROM vehicles').all();
  // node:sqlite hands BLOBs back as Uint8Array, whose .includes() tests for a
  // single byte value rather than a subsequence — so it silently never matches.
  // Wrap once here rather than per comparison.
  for (const r of rows) if (r.data) r.data = Buffer.from(r.data);

  // Group existing vehicles of modded types — these are the clone templates.
  //
  // Match the length-prefixed "Base.<script>" exactly as the blob stores it
  // (uint16 length, then the string). A plain substring search misfiles every
  // name that is a prefix of another — 99fordCVPI inside 99fordCVPIunmarked,
  // 89defender110 inside 89defender110utility, and so on — which silently
  // skews the type distribution and loses types entirely.
  const needle = (n) => {
    const s = Buffer.from(`Base.${n}`);
    const b = Buffer.alloc(2 + s.length);
    b.writeUInt16BE(s.length, 0);
    s.copy(b, 2);
    return b;
  };
  const names = [...modScripts].map((n) => [n, needle(n)]);
  const templates = new Map();
  for (const r of rows) {
    if (!r.data) continue;
    for (const [name, pattern] of names) {
      if (r.data.includes(pattern)) {
        if (!templates.has(name)) templates.set(name, []);
        templates.get(name).push(r);
        break;
      }
    }
  }

  if (o.templates) {
    console.log(`${modScripts.size} mod-only vehicle scripts; ${templates.size} have an instance to clone:\n`);
    for (const [n, v] of [...templates].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(v.length).padStart(3)}  ${n}`);
    }
    const missing = [...modScripts].filter((n) => !templates.has(n)).sort();
    console.log(`\n${missing.length} types have NO instance and cannot be cloned:`);
    console.log('  ' + missing.join(', '));
    console.log('\nSpawn one of each near yourself with /addvehicle to unlock them, then re-run.');
    db.close();
    return;
  }

  /**
   * Creates one of each un-clonable type next to a player, so the seeder has a
   * template for all 41 rather than the 15 that happen to exist in the world.
   *
   * These are worth more than found vehicles: the game builds them fresh, so
   * their parts and containers are in a new-vehicle state rather than some
   * looted world car's. Clones inherit that.
   *
   * Runs against a LIVE server — addvehicle needs a streamed chunk, which only
   * exists around an online player. That is the opposite of every other mode
   * here, which needs the server stopped.
   */
  if (o.spawnMissing) {
    const missing = [...modScripts].filter((n) => !templates.has(n)).sort();
    const pdb2 = openDb(paths.playersDb, true);
    const me = pdb2.prepare(
      'SELECT username,x,y,z FROM networkPlayers WHERE lower(username)=lower(?) ORDER BY id DESC LIMIT 1'
    ).get(o.spawnMissing);
    pdb2.close();
    db.close();
    if (!me || !Number.isFinite(me.x)) {
      console.error(`no known position for ${o.spawnMissing}`); process.exit(1);
    }
    console.log(`${missing.length} types to create near ${me.username} @ ${me.x.toFixed(0)},${me.y.toFixed(0)}`);
    if (!o.go) {
      missing.forEach((n, i) => console.log(`  [dry] ${n}`));
      console.log('\ndry run — add --go to spawn (server must be UP and the player online).');
      return;
    }

    const { rcon } = require(path.join(ROOT, 'src/services/zomboid/rcon'));
    // Target the PLAYER, not coordinates. addvehicle's documented "x,y,z" form
    // returns "Invalid location" even for squares 10 tiles from an online
    // player that createhorde2 spawns into happily — so that path does not work
    // the way its help text claims. The username form does, and it lets the
    // game choose a parkable square itself, which is better placement than a
    // grid we impose.
    const made = [];
    (async () => {
      for (const type of missing) {
        let reply = '';
        try {
          reply = (await rcon(GUILD, `addvehicle "Base.${type}" "${me.username}"`)).trim();
        } catch (e) { reply = `ERROR ${e.message}`; }
        const ok = /spawned/i.test(reply);
        // Position is not in the reply, so record the player's location as the
        // origin; every template lands within a few tiles of it, which is what
        // --delete-templates matches against later.
        if (ok) made.push({ type, x: me.x, y: me.y });
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${type.padEnd(28)}` +
          (ok ? '' : `  <- ${reply.slice(0, 70)}`));
        await new Promise((r) => setTimeout(r, 400));
      }
      try {
        fs.mkdirSync(path.dirname(TEMPLATE_STATE), { recursive: true });
        fs.writeFileSync(TEMPLATE_STATE, JSON.stringify(made, null, 1));
        console.log(`\ncreated ${made.length}/${missing.length}; recorded to ${TEMPLATE_STATE}`);
      } catch (e) {
        console.error(`\ncreated ${made.length}/${missing.length}, but could NOT record state: ${e.message}`);
        console.error('Run the seeder without --delete-templates, or re-run this with a writable PZ_SEED_TEMPLATES.');
      }
      console.log('Let the server save (or wait for the restart), then run the seeder.');
    })();
    return;
  }

  if (fs.existsSync(MARKER) && !o.force) {
    console.log(`already seeded (${MARKER}) — nothing to do. Use --force to override.`);
    db.close();
    return;
  }
  if (o.go && containerRunning()) {
    console.error('REFUSING: the zomboid container is running. The server owns this database.');
    process.exit(1);
  }
  if (!templates.size) { console.error('no modded vehicles exist to clone from'); process.exit(1); }

  const houses = raid.readSafehouses(paths.mapMeta);
  const pdb = openDb(paths.playersDb, true);
  const players = pdb.prepare('SELECT x, y FROM networkPlayers WHERE x IS NOT NULL').all();
  pdb.close();

  // Spatial index so the spacing check is not 6k x 450 comparisons.
  const CELL = 32;
  const grid = new Map();
  const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  const addPoint = (x, y) => {
    const k = key(x, y);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([x, y]);
  };
  for (const r of rows) addPoint(r.x, r.y);
  const tooClose = (x, y, min) => {
    for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
      const list = grid.get(`${Math.floor(x / CELL) + gx},${Math.floor(y / CELL) + gy}`);
      if (!list) continue;
      for (const [px, py] of list) if (Math.hypot(x - px, y - py) < min) return true;
    }
    return false;
  };
  const nearSafehouse = (x, y) => houses.some((s) => {
    const dx = Math.max(s.x - x, 0, x - (s.x + s.w));
    const dy = Math.max(s.y - y, 0, y - (s.y + s.h));
    return Math.hypot(dx, dy) < SAFEHOUSE_BUFFER;
  });
  const nearPlayer = (x, y) =>
    players.some((p) => Math.hypot(x - p.x, y - p.y) < PLAYER_BUFFER);

  // Candidate sites are EMPTY parking stalls, not offsets from other cars.
  // "Empty" matters twice: it is where a car realistically belongs, and it
  // avoids double-parking on a stall the game already filled.
  const zones = parkingZones();
  const anchors = zones.filter((z) => {
    const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
    if (nearSafehouse(cx, cy) || nearPlayer(cx, cy)) return false;
    return !tooClose(cx, cy, STALL_OCCUPIED);   // skip stalls already occupied
  });
  console.log(`${zones.length} ground-floor parking zones on the map`);
  console.log(`${anchors.length} are empty and clear of safehouses (${SAFEHOUSE_BUFFER}) and players (${PLAYER_BUFFER})`);
  console.log(`${templates.size} modded types available\n`);

  // Even spread across types, so no single vehicle becomes the new normal.
  const types = [...templates.keys()].sort();
  const rand = rng(o.seed);
  const shuffled = anchors.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  let nextId = Math.max(...rows.map((r) => r.id)) + 1;
  const planned = [];
  const perType = new Map();
  for (const anchor of shuffled) {
    if (planned.length >= o.count) break;
    const type = types[planned.length % types.length];
    const src = templates.get(type)[Math.floor(rand() * templates.get(type).length)];

    // No zone-type gate: the mods' own SpawnList lists trailers under
    // parkingstall as well as trailerpark, so a camper in a car park is exactly
    // as native as one in a trailer park. Gating on it only starved the run —
    // there are 48 TrailerPark zones against ~9,700 ParkingStall.
    let placed = null;
    for (let t = 0; t < 6; t++) {
      const x = anchor.x + rand() * Math.max(anchor.w - 1, 0.5);
      const y = anchor.y + rand() * Math.max(anchor.h - 1, 0.5);
      if (x < 1 || y < 1 || x > 23000 || y > 18000) continue;
      if (tooClose(x, y, MIN_SPACING)) continue;
      if (nearSafehouse(x, y) || nearPlayer(x, y)) continue;
      placed = { x, y };
      break;
    }
    if (!placed) continue;

    const data = Buffer.from(src.data);          // copy, never mutate the source
    data.writeFloatBE(placed.x, X_OFF);
    data.writeFloatBE(placed.y, Y_OFF);
    planned.push({
      id: nextId++, type,
      wx: Math.floor(placed.x / 8), wy: Math.floor(placed.y / 8),
      x: placed.x, y: placed.y,
      inMeta: 0, worldversion: src.worldversion ?? 249, data,
    });
    addPoint(placed.x, placed.y);                // so later picks avoid this one
    perType.set(type, (perType.get(type) || 0) + 1);
  }

  console.log(`planned ${planned.length} new vehicles:`);
  for (const [t, n] of [...perType].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${t}`);
  }
  db.close();

  if (!o.go) {
    console.log('\ndry run — nothing written. Add --go (with the server stopped) to apply.');
    return;
  }

  const backup = `${vehiclesDb}.bak.preseed.${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
  fs.copyFileSync(vehiclesDb, backup);
  console.log(`\nbacked up -> ${backup}`);

  // Templates created by --spawn-missing, to be removed once cloned. Matched by
  // recorded coordinate, never by type alone: deleting "every vehicle of this
  // type" would take out the ones that were always in the world.
  let toDelete = [];
  if (o.deleteTemplates) {
    let recorded = [];
    try { recorded = JSON.parse(fs.readFileSync(TEMPLATE_STATE, 'utf8')); }
    catch { console.log('no template state file — nothing to delete'); }
    for (const t of recorded) {
      const hit = rows.find((r) => Math.hypot(r.x - t.x, r.y - t.y) < 40
        && r.data && r.data.includes(needle(t.type)));
      if (hit) toDelete.push(hit.id);
    }
    console.log(`\nwill delete ${toDelete.length} of ${recorded.length} recorded templates`);
  }

  const w = openDb(vehiclesDb, false);
  let written = 0;
  let removed = 0;
  try {
    w.exec('BEGIN');
    const ins = w.prepare(
      'INSERT INTO vehicles (id, wx, wy, x, y, inMeta, worldversion, data) VALUES (?,?,?,?,?,?,?,?)'
    );
    for (const p of planned) {
      ins.run(p.id, p.wx, p.wy, p.x, p.y, p.inMeta, p.worldversion, p.data);
      written++;
    }
    // Deleted only after every clone is in, so a failure mid-insert rolls back
    // with the templates still present and the run is simply repeatable.
    const del = w.prepare('DELETE FROM vehicles WHERE id = ?');
    for (const id of toDelete) { del.run(id); removed++; }
    w.exec('COMMIT');
  } catch (e) {
    w.exec('ROLLBACK');
    console.error(`FAILED after ${written} inserts / ${removed} deletes, rolled back: ${e.message}`);
    console.error(`database is unchanged; backup at ${backup}`);
    process.exit(1);
  } finally { w.close(); }

  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, `${new Date().toISOString()} seeded ${written} vehicles\n`);
  console.log(`inserted ${written} vehicles${removed ? `, removed ${removed} templates` : ''}; marker written to ${MARKER}`);
}

main();
