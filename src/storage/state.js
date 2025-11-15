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

// OSRS tracking functions
function getOSRSStats(username) {
  const state = getState();
  if (!state.osrs) return null;
  return state.osrs[username] || null;
}

function setOSRSStats(username, stats) {
  const state = getState();
  if (!state.osrs) state.osrs = {};
  state.osrs[username] = {
    stats,
    lastChecked: Date.now()
  };
  setState({ osrs: state.osrs });
}

function getOSRSConfig() {
  const state = getState();
  return state.osrsConfig || {
    trackedPlayers: [],
    notificationChannelId: null,
    checkInterval: 3600000 // 1 hour in ms
  };
}

function setOSRSConfig(config) {
  setState({ osrsConfig: config });
}

module.exports = { 
  getState, 
  setState,
  getOSRSStats,
  setOSRSStats,
  getOSRSConfig,
  setOSRSConfig
};
