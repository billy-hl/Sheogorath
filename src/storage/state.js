'use strict';
const fs = require('fs');
const path = require('path');
const { primaryGuildId } = require('../config/guilds');

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

/** Returns all notes for a user in a guild. */
function getUserNotes(guildId, userId) {
  const users = getGuildState(guildId).userActivity || {};
  return (users[userId] || {}).notes || [];
}

/** Appends a note to a user's notes list and persists. */
function addUserNote(guildId, userId, note) {
  return updateUserRecord(guildId, userId, (record) => {
    record.notes.push({ text: note, addedAt: new Date().toISOString() });
    return record.notes;
  });
}

/** Clears all notes for a user and persists. */
function clearUserNotes(guildId, userId) {
  updateUserRecord(guildId, userId, (record) => {
    record.notes = [];
  });
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
