'use strict';
/**
 * Reads events out of the Project Zomboid dedicated server's log directory.
 *
 * PZ writes one set of logs per server start, named `<date>_<time>_<kind>.txt`,
 * and rotates older sets into `logs_YYYY-MM-DD/` subdirectories. A 24-hour
 * window therefore spans several files across several directories, so we glob
 * both levels and filter on the parsed line timestamp rather than trusting
 * filenames or mtimes.
 *
 * Line formats were taken from the live server, not from documentation — PZ's
 * logging differs between builds.
 */
const fs = require('fs');
const path = require('path');

/** `[DD-MM-YY HH:MM:SS.mmm]` — day first, two-digit year. */
const STAMP = /^\[(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d+\]/;

// `user Johnny Getwell died at (10734,9757,0) (non pvp).`
const DIED = /^\[.+?\] user (.+?) died at \((-?\d+),(-?\d+),(-?\d+)\) \((.+?)\)\.?$/;
// `76561198316875401 "Phoenix" fully connected (2048,5689,0).`
const JOINED = /^\[.+?\] (\d+) "(.+?)" fully connected/;
// `[76561198021390957][Allisteras][x,y,z][Login][Hours Survived: 1100].`
const PERK_LOGIN = /^\[.+?\] \[(\d+)\]\[(.+?)\]\[.*?\]\[Login\]\[Hours Survived: (\d+)\]/;
// `76561198021390957 "Allisteras" removed IsoObject (fixtures_stairs_01_14) at 3775,12269,0.`
const MAP_CHANGE = /^\[.+?\] (\d+) "(.+?)" (added|removed) (.+?) at /;

/** @returns {number|null} epoch ms, or null when the line has no timestamp. */
function parseStamp(line) {
  const m = STAMP.exec(line);
  if (!m) return null;
  const [, dd, mm, yy, hh, mi, ss] = m;
  // These stamps are UTC. The compose file mounts America/Chicago over the
  // container's /etc/localtime, but PZ writes UTC regardless — verified against
  // the host clock, the logs run exactly UTC ahead of it. Reading them as local
  // time pushed every event into the future, which truncated the chronicle's
  // 24h window and let stale incidents past the raid watcher's watermark.
  // Two-digit year; PZ has no year-2100 problem worth worrying about.
  return Date.UTC(2000 + +yy, +mm - 1, +dd, +hh, +mi, +ss);
}

/**
 * Every log file of a given kind, newest directory first. Rotation moves whole
 * files, so a basename appears once — but dedupe anyway in case we read
 * mid-rotation.
 */
function logFiles(logDir, kind) {
  const seen = new Set();
  const out = [];

  const collect = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(`_${kind}.txt`) || seen.has(name)) continue;
      seen.add(name);
      out.push(path.join(dir, name));
    }
  };

  collect(logDir);
  let rotated = [];
  try {
    rotated = fs.readdirSync(logDir)
      .filter((n) => n.startsWith('logs_'))
      .sort()
      .reverse();
  } catch { /* no rotated dirs yet */ }
  // Two days back is plenty for a 24h window and keeps the read cheap.
  for (const dir of rotated.slice(0, 3)) collect(path.join(logDir, dir));

  return out;
}

function* linesSince(logDir, kind, sinceMs) {
  for (const file of logFiles(logDir, kind)) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      const at = parseStamp(line);
      if (at === null || at < sinceMs) continue;
      yield { at, line };
    }
  }
}

/**
 * Collect the last `windowMs` of server activity.
 *
 * @param {string} logDir
 * @param {number} [windowMs] defaults to 24 hours
 * @returns {{
 *   since: number, until: number,
 *   deaths: Array<{at:number, player:string, pvp:boolean}>,
 *   players: Map<string, {sessions:number, hoursSurvived:number|null}>,
 *   builders: Map<string, {added:number, removed:number}>,
 * }}
 */
function collectEvents(logDir, windowMs = 24 * 60 * 60 * 1000) {
  const until = Date.now();
  const since = until - windowMs;

  const deaths = [];
  const players = new Map();
  const builders = new Map();

  const player = (name) => {
    if (!players.has(name)) players.set(name, { sessions: 0, hoursSurvived: null });
    return players.get(name);
  };

  for (const { at, line } of linesSince(logDir, 'user', since)) {
    const died = DIED.exec(line);
    if (died) {
      deaths.push({ at, player: died[1], pvp: !/non\s*pvp/i.test(died[5]) });
      player(died[1]);
      continue;
    }
    const joined = JOINED.exec(line);
    if (joined) player(joined[2]).sessions++;
  }

  for (const { line } of linesSince(logDir, 'PerkLog', since)) {
    const login = PERK_LOGIN.exec(line);
    if (!login) continue;
    const rec = player(login[2]);
    const hours = Number(login[3]);
    // Keep the highest reading — it's a running total, so the last login of the
    // day is the truest, and taking the max survives out-of-order files.
    if (rec.hoursSurvived === null || hours > rec.hoursSurvived) rec.hoursSurvived = hours;
  }

  for (const { line } of linesSince(logDir, 'map', since)) {
    const change = MAP_CHANGE.exec(line);
    if (!change) continue;
    const name = change[2];
    if (!builders.has(name)) builders.set(name, { added: 0, removed: 0 });
    builders.get(name)[change[3] === 'added' ? 'added' : 'removed']++;
  }

  return { since, until, deaths, players, builders };
}

module.exports = { collectEvents, parseStamp, logFiles, linesSince };
