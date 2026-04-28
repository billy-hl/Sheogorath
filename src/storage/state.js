'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getState() {
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

function setState(patch) {
  try {
    ensureDir();
    const current = getState();
    const next = { ...current, ...patch };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) {
    console.warn('WARN: Failed to write state file:', e?.message || e);
  }
}

/**
 * Returns the activity record for a single user.
 * Shape: { lastChat: ISO string | null, lastVoiceJoin: ISO string | null }
 */
function getUserActivity(userId) {
  const state = getState();
  const users = state.userActivity || {};
  return users[userId] || { lastChat: null, lastVoiceJoin: null };
}

/**
 * Returns all notes for a user as an array of strings.
 */
function getUserNotes(userId) {
  const state = getState();
  const users = state.userActivity || {};
  return (users[userId] || {}).notes || [];
}

/**
 * Appends a note string to a user's notes list and persists.
 */
function addUserNote(userId, note) {
  try {
    ensureDir();
    const current = getState();
    const users = current.userActivity || {};
    const record = users[userId] || { lastChat: null, lastVoiceJoin: null, notes: [] };
    if (!Array.isArray(record.notes)) record.notes = [];
    record.notes.push({ text: note, addedAt: new Date().toISOString() });
    users[userId] = record;
    const next = { ...current, userActivity: users };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
    return record.notes;
  } catch (e) {
    console.warn('WARN: Failed to add user note:', e?.message || e);
  }
}

/**
 * Clears all notes for a user and persists.
 */
function clearUserNotes(userId) {
  try {
    ensureDir();
    const current = getState();
    const users = current.userActivity || {};
    if (users[userId]) users[userId].notes = [];
    const next = { ...current, userActivity: users };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.warn('WARN: Failed to clear user notes:', e?.message || e);
  }
}

/**
 * Merges `patch` into the activity record for `userId` and persists.
 * @param {string} userId
 * @param {{ lastChat?: string, lastVoiceJoin?: string }} patch
 */
function setUserActivity(userId, patch) {
  try {
    ensureDir();
    const current = getState();
    const users = current.userActivity || {};
    users[userId] = { ...(users[userId] || { lastChat: null, lastVoiceJoin: null }), ...patch };
    const next = { ...current, userActivity: users };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
    return users[userId];
  } catch (e) {
    console.warn('WARN: Failed to write user activity:', e?.message || e);
  }
}

module.exports = { 
  getState, 
  setState,
  getUserActivity,
  setUserActivity,
  getUserNotes,
  addUserNote,
  clearUserNotes,
};
