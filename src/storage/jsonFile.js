'use strict';
/**
 * A JSON file on disk that a crash cannot tear and a bad read cannot empty.
 *
 * Everything the bot keeps between restarts lives in files like this:
 * data/state.json (the pick'em season, notes and titles, the calendar's
 * overrides, what the UFC feeds have already posted), data/memories.json,
 * data/ai-spend.json and data/ledger.json. Each used to be read with a
 * try/catch that answered `{}` when the file would not parse, and written in
 * place. For state.json that made one bad read, whether from a typo in a hand
 * edit or a file cut short mid-write, look exactly like "nothing stored yet".
 * State is written on every chat message, so seconds later the whole file was
 * replaced with an empty one.
 *
 * So, here:
 *
 *   - A write goes to a temp file that is flushed to disk and then renamed over
 *     the real one. A crash leaves the old file or the new one, never half of
 *     either.
 *   - A file that will not parse is moved aside as `<name>.corrupt-<time>` and
 *     nothing ever writes over it. Reading falls back to the last good copy this
 *     process saw, then to the newest daily backup, and that copy is written
 *     back in its place. The owner is told by DM either way.
 *   - The first write of each day saves the last good copy into data/backups
 *     first. Two weeks of those are kept.
 *
 * A missing file is still just an empty one: that is a fresh install, or
 * somebody starting over on purpose.
 */
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days of backups are kept for each file. */
const KEEP_DAYS = 14;

/**
 * Write a file so that a crash leaves either the old contents or the new ones.
 *
 * The temp file is flushed before the rename, so the rename cannot reach the
 * disk ahead of the data it points at.
 */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows refuses to rename over a file another program holds open. A copy
    // is not atomic, but this is only ever the fallback, and only on a dev box.
    try {
      fs.copyFileSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

/** Parse, insisting on an object: `null`, `[]` or a bare number is damage, not data. */
function parseObject(text) {
  if (!String(text).trim()) throw new Error('the file is empty');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the file does not hold an object');
  }
  return parsed;
}

/** Tell the owner, by DM when the bot is up. Required late: this file loads first. */
function defaultNotify(message) {
  console.error(`[Storage] ${message}`);
  try {
    require('../utils/errorNotify').notifyError(message);
  } catch { /* the console line above is the record */ }
}

/**
 * @param {string} file absolute path to the JSON file
 * @param {object} [opts]
 * @param {() => object} [opts.empty] what a missing file reads as
 * @param {number} [opts.keepDays] days of backups to keep
 * @param {(message: string) => void} [opts.notify] who hears about a damaged file
 * @returns {{ file: string, read: () => object, write: (obj: object) => void,
 *   update: (change: (obj: object) => any) => any }}
 */
function jsonFile(file, { empty = () => ({}), keepDays = KEEP_DAYS, notify = defaultNotify } = {}) {
  const name = path.basename(file);
  const base = path.basename(file, '.json');
  const backupDir = path.join(path.dirname(file), 'backups');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const backupName = new RegExp(`^${escaped}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);

  /** Text of the last copy known to parse, from a read or a write. */
  let lastGood = null;
  /** The day a backup was last made, so each day makes one. */
  let backedUpOn = null;

  /** This file's backups, newest first, as [date, filename]. */
  function backups() {
    let names = [];
    try {
      names = fs.readdirSync(backupDir);
    } catch {
      return [];
    }
    return names
      .map((n) => [backupName.exec(n)?.[1], n])
      .filter(([day]) => day)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }

  /** The newest backup that parses, or null. */
  function newestBackup() {
    for (const [day, n] of backups()) {
      try {
        const text = fs.readFileSync(path.join(backupDir, n), 'utf8');
        parseObject(text);
        return { text, from: `the backup from ${day}` };
      } catch { /* try the one before it */ }
    }
    return null;
  }

  /**
   * The file would not parse. Keep it, find the best good copy, and put that
   * back in its place.
   */
  function quarantine(err) {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      try { fs.copyFileSync(file, aside); } catch { /* reported below either way */ }
    }

    const good = lastGood !== null ? { text: lastGood, from: 'the last good copy in memory' } : newestBackup();
    if (!good) {
      notify(`${name} would not parse (${err.message}). It was moved to ${path.basename(aside)}, `
        + 'where nothing will write over it, but there was no good copy to restore, so it starts empty.');
      return empty();
    }
    try {
      writeFileAtomic(file, good.text);
    } catch (writeErr) {
      console.error(`[Storage] Could not put ${name} back: ${writeErr.message}`);
    }
    lastGood = good.text;
    notify(`${name} would not parse (${err.message}). It was moved to ${path.basename(aside)} `
      + `and replaced with ${good.from}.`);
    return JSON.parse(good.text);
  }

  /** The stored object, freshly parsed every call so callers may change it. */
  function read() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return empty();
      // Unreadable, not damaged: permissions, a lock. The file is left alone.
      if (lastGood !== null) {
        console.warn(`[Storage] ${name} could not be read (${err.message}); using the last good copy.`);
        return JSON.parse(lastGood);
      }
      throw new Error(`${name} could not be read: ${err.message}`);
    }
    try {
      const parsed = parseObject(text);
      lastGood = text;
      return parsed;
    } catch (err) {
      return quarantine(err);
    }
  }

  /** Today's backup, made from the last good copy before the first write of the day. */
  function backupOnce() {
    const today = new Date().toISOString().slice(0, 10);
    if (backedUpOn === today || lastGood === null) return;
    backedUpOn = today;
    try {
      const target = path.join(backupDir, `${base}-${today}.json`);
      if (!fs.existsSync(target)) writeFileAtomic(target, lastGood);
      const cutoff = new Date(Date.now() - keepDays * DAY_MS).toISOString().slice(0, 10);
      for (const [day, n] of backups()) {
        if (day < cutoff) fs.rmSync(path.join(backupDir, n), { force: true });
      }
    } catch (err) {
      console.warn(`[Storage] Could not back up ${name}: ${err.message}`);
    }
  }

  /** Replace the stored object. Throws if it could not be written. */
  function write(obj) {
    const text = JSON.stringify(obj, null, 2);
    backupOnce();
    writeFileAtomic(file, text);
    lastGood = text;
  }

  /** Read, change and write in one synchronous pass. `change` must not await. */
  function update(change) {
    const obj = read();
    const result = change(obj);
    write(obj);
    return result;
  }

  return { file, read, write, update };
}

module.exports = { jsonFile, writeFileAtomic, KEEP_DAYS };
