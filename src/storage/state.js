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

module.exports = { getState, setState };
