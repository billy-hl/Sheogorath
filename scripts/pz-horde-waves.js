#!/usr/bin/env node
'use strict';
/**
 * Horde events from the command line — the rehearsal tool for `/pz raid`.
 *
 * All the logic lives in services/zomboid/raid.js, which is what the Discord
 * command runs too. This file is only argument parsing and printing, so the
 * thing you test here is exactly the thing that fires in production.
 *
 * The value over the slash command is the dry run: `--preview` walks every wave
 * and prints the commands it *would* send without touching the server, which is
 * the only safe way to check a distance band before committing. Spawns cannot
 * be undone — this server runs ZombieRespawn=None and PZ has no RCON command
 * that removes zombies — so rehearse first.
 *
 * Usage:
 *   node scripts/pz-horde-waves.js --list
 *   node scripts/pz-horde-waves.js --preview
 *   node scripts/pz-horde-waves.js --only Allisteras --per-player 20 --go
 *   node scripts/pz-horde-waves.js --per-player 40 --minutes 5 --go
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const raid = require(path.join(ROOT, 'src/services/zomboid/raid'));

const GUILD = process.env.PZ_GUILD_ID || '444601986160263189';

function parseArgs(argv) {
  const o = {
    list: false, go: false, only: null,
    perPlayer: raid.DEFAULTS.perPlayer, minutes: 5,
    near: raid.DEFAULTS.near, far: raid.DEFAULTS.far,
    waves: raid.DEFAULTS.waves, maxTotal: raid.DEFAULTS.maxTotal,
    safeBuffer: raid.DEFAULTS.safeBuffer,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--list': o.list = true; break;
      case '--go': o.go = true; break;
      case '--preview': o.go = false; break;
      case '--only': o.only = next(); break;
      case '--per-player': o.perPlayer = Number(next()); break;
      case '--minutes': o.minutes = Number(next()); break;
      case '--near': o.near = Number(next()); break;
      case '--far': o.far = Number(next()); break;
      case '--waves': o.waves = Number(next()); break;
      case '--max-total': o.maxTotal = Number(next()); break;
      case '--safe-buffer': o.safeBuffer = Number(next()); break;
      default:
        if (a.startsWith('--')) { console.error(`unknown flag ${a}`); process.exit(2); }
    }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv);
  const paths = raid.savePaths(GUILD);
  if (!paths) { console.error(`no Zomboid save configured for guild ${GUILD}`); process.exit(2); }

  if (o.list) {
    const houses = raid.readSafehouses(paths.mapMeta);
    console.log(`${houses.length} safehouses (avoided by every spawn):\n`);
    for (const s of [...houses].sort((a, b) => b.members.length - a.members.length)) {
      console.log(
        `  ${String(s.title).padEnd(30)} ${String(s.owner).padEnd(20)} ` +
        `${String(s.x).padStart(6)},${String(s.y).padEnd(6)} ${s.w}x${s.h} ` +
        `members=${s.members.length}`,
      );
    }
    return;
  }

  if (o.far <= o.near) { console.error('--far must be greater than --near'); process.exit(2); }

  console.log(
    `${o.go ? 'RAID' : 'preview'}: ${o.perPlayer}/player over ${o.minutes} min, ` +
    `${o.waves} waves, band ${o.near}-${o.far}` + (o.only ? `, only ${o.only}` : ''),
  );
  if (!o.go) console.log('(nothing will be sent — add --go to spawn)\n');

  const summary = await raid.runRaid(
    GUILD,
    {
      perPlayer: o.perPlayer, duration: o.minutes * 60, waves: o.waves,
      near: o.near, far: o.far, maxTotal: o.maxTotal, safeBuffer: o.safeBuffer,
      only: o.only, dryRun: !o.go,
    },
    (e) => {
      if (e.kind === 'budget') return console.log(`  budget ${e.maxTotal} reached — stopping`);
      if (e.kind === 'skip') return console.log(`  ${e.player}: skipped — ${e.reason}`);
      const tag = e.kind === 'dry' ? '[dry]' : e.kind === 'ok' ? 'ok  ' : 'MISS';
      console.log(`  ${tag} ${e.player.padEnd(18)} ${e.x},${e.y} (${e.d} tiles) n=${e.count}`);
    },
  );

  console.log(
    `\nspawned=${summary.spawned} landed=${summary.ok} ` +
    `missed=${summary.miss} skipped=${summary.skipped}` + (o.go ? '' : '  (preview)'),
  );
  if (summary.miss) {
    console.log(
      'Misses are `invalid location`: that player\'s client was not streaming the\n' +
      'square. Lower --far to improve coverage.',
    );
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
