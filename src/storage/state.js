'use strict';
const fs = require('fs');
const path = require('path');
const { primaryGuildId } = require('../config/guilds');
const { sanitizeObservation } = require('./sanitize');

const DATA_DIR = path.join(__dirname, '../../data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readRaw() {
  try {
    ensureDir();
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.warn('WARN: Failed to read state file:', e?.message || e);
    return {};
  }
}

function writeRaw(next) {
  try {
    ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) {
    console.warn('WARN: Failed to write state file:', e?.message || e);
  }
}

/**
 * Fold a pre-multi-guild state file (flat `userActivity` / `automod` at the
 * top level) into the guild-scoped shape, attributing everything to the
 * primary guild. Runs once; a backup is written first because this rewrites
 * accumulated user notes that exist nowhere else.
 */
let migrationChecked = false;
function migrateIfNeeded(raw) {
  if (migrationChecked || raw.guilds) return raw;
  migrationChecked = true;

  const legacy = {};
  if (raw.userActivity) legacy.userActivity = raw.userActivity;
  if (raw.automod) legacy.automod = raw.automod;

  if (Object.keys(legacy).length === 0) {
    return writeRaw({ ...raw, guilds: {} }) || { ...raw, guilds: {} };
  }

  const primary = primaryGuildId();
  if (!primary) {
    console.warn(
      'WARN: state.json needs migrating to the guild-scoped shape but no primary ' +
      'guild is resolvable (set GUILD_ID). Leaving it alone.'
    );
    return raw;
  }

  try {
    const backup = `${STATE_FILE}.bak-${Date.now()}`;
    fs.copyFileSync(STATE_FILE, backup);
    console.log(`[State] Backed up pre-migration state to ${path.basename(backup)}`);
  } catch (e) {
    console.warn('WARN: Could not back up state file, aborting migration:', e?.message || e);
    return raw;
  }

  const rest = { ...raw };
  delete rest.userActivity;
  delete rest.automod;

  const migrated = { ...rest, guilds: { [primary]: legacy } };
  writeRaw(migrated);
  console.log(
    `[State] Migrated ${Object.keys(legacy.userActivity || {}).length} user record(s) ` +
    `to guild ${primary}.`
  );
  return migrated;
}

/** The whole state file, guild-scoped shape guaranteed. */
function getState() {
  const raw = migrateIfNeeded(readRaw());
  if (!raw.guilds) raw.guilds = {};
  return raw;
}

/** Merge a patch into the top level of the state file. */
function setState(patch) {
  return writeRaw({ ...getState(), ...patch });
}

/** Everything stored for one guild. */
function getGuildState(guildId) {
  const state = getState();
  return state.guilds[guildId] || {};
}

/** Merge a patch into one guild's slice of state. */
function setGuildState(guildId, patch) {
  const state = getState();
  state.guilds[guildId] = { ...(state.guilds[guildId] || {}), ...patch };
  return writeRaw(state);
}

/**
 * Read-modify-write one guild's user record in a single pass, so callers don't
 * each re-implement the load/mutate/save dance.
 */
function updateUserRecord(guildId, userId, mutate) {
  if (!guildId || !userId) return undefined;
  try {
    const state = getState();
    const guild = state.guilds[guildId] || {};
    const users = guild.userActivity || {};
    const record = users[userId] || { lastChat: null, lastVoiceJoin: null, notes: [] };
    if (!Array.isArray(record.notes)) record.notes = [];

    const result = mutate(record);

    users[userId] = record;
    guild.userActivity = users;
    state.guilds[guildId] = guild;
    writeRaw(state);
    return result === undefined ? record : result;
  } catch (e) {
    console.warn('WARN: Failed to update user record:', e?.message || e);
  }
}

/**
 * Returns the activity record for a single user in a guild.
 * Shape: { lastChat: ISO string | null, lastVoiceJoin: ISO string | null }
 */
function getUserActivity(guildId, userId) {
  const users = getGuildState(guildId).userActivity || {};
  return users[userId] || { lastChat: null, lastVoiceJoin: null };
}

/**
 * How long an automatically-generated note stays readable, and how many of
 * them are kept.
 *
 * The auto-summariser is told to be crude, and in a room that enjoys that it
 * produces exactly what it is asked for. The problem was never the tone — it
 * was that a joke from Tuesday was still being read back into his context on
 * Saturday, so he would raise it cold, days after the room had moved on, and
 * every raising fed the summariser another copy of the same joke. Six notes
 * about one mishearing is not a memory of a person, it is a loop.
 *
 * So what he writes about someone on his own has a short life and a low
 * ceiling. Notes a human deliberately gave him are a different thing and keep
 * the old behaviour, capped only so the file cannot grow without end.
 */
const AUTO_NOTE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_AUTO_NOTES = 4;
const MAX_MANUAL_NOTES = 20;

/** Whether an auto note is still within its window. Legacy notes have no kind. */
function isLive(note, now) {
  if (note.kind !== 'auto') return true;
  const at = Date.parse(note.addedAt || '');
  if (!Number.isFinite(at)) return false;
  return now - at < AUTO_NOTE_TTL_MS;
}

/**
 * Drop expired auto notes, collapse duplicates, and hold each kind to its cap.
 *
 * Deduplication is on the note text alone: the summariser restates the same
 * observation in slightly different words run after run, and near-copies are
 * what let one running joke crowd out everything else he knows about a person.
 */
function prune(notes, now = Date.now()) {
  const live = (notes || []).filter((n) => n && n.text && isLive(n, now));

  const seen = new Set();
  const unique = [];
  for (const note of live) {
    const key = String(note.text).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(note);
  }

  const auto = unique.filter((n) => n.kind === 'auto').slice(-MAX_AUTO_NOTES);
  const manual = unique.filter((n) => n.kind !== 'auto').slice(-MAX_MANUAL_NOTES);

  // Back into one list in the order they were recorded, so the reader still
  // sees a person's history rather than two segregated piles.
  return [...auto, ...manual].sort(
    (a, b) => Date.parse(a.addedAt || 0) - Date.parse(b.addedAt || 0),
  );
}

/**
 * Returns the notes for a user that are still live.
 *
 * Pruning happens on read as well as on write, so a note goes quiet the moment
 * it expires rather than whenever that user next happens to be written to.
 */
function getUserNotes(guildId, userId) {
  const users = getGuildState(guildId).userActivity || {};
  return prune((users[userId] || {}).notes);
}

/**
 * Appends a note to a user's notes list and persists.
 *
 * @param {object} [opts]
 * @param {'auto'|'manual'} [opts.kind] `auto` for the summariser's own
 *   jottings, which expire; `manual` for one a human asked him to keep.
 */
function addUserNote(guildId, userId, note, { kind = 'manual' } = {}) {
  // Everything written here is replayed into the model's context on every
  // future turn with this person, so it is the one place user-derived text
  // becomes durable. Filtered at the choke point rather than at each caller,
  // so a new writer is covered without anyone remembering to cover it.
  const clean = sanitizeObservation(note, { kind: 'note', userId });
  if (!clean) return null;

  return updateUserRecord(guildId, userId, (record) => {
    record.notes.push({ text: clean, addedAt: new Date().toISOString(), kind });
    record.notes = prune(record.notes);
    return record.notes;
  });
}

/**
 * Clears all notes for a user and persists.
 *
 * Returns how many were actually removed. The caller reports that number
 * rather than announcing success, because the failure worth catching is a
 * clear that found nothing — someone asking to be forgotten and being told
 * they were, while the file kept every line.
 *
 * @returns {number}
 */
function clearUserNotes(guildId, userId) {
  const cleared = updateUserRecord(guildId, userId, (record) => {
    const count = (record.notes || []).length;
    record.notes = [];
    return count;
  });
  return typeof cleared === 'number' ? cleared : 0;
}

/**
 * Merges `patch` into the activity record for a user and persists.
 * @param {string} guildId
 * @param {string} userId
 * @param {{ lastChat?: string, lastVoiceJoin?: string, lastNoteSummary?: string }} patch
 */
function setUserActivity(guildId, userId, patch) {
  return updateUserRecord(guildId, userId, (record) => {
    Object.assign(record, patch);
    return record;
  });
}

module.exports = {
  getState,
  setState,
  getGuildState,
  setGuildState,
  getUserActivity,
  setUserActivity,
  getUserNotes,
  addUserNote,
  clearUserNotes,
};
