'use strict';
const fs = require('fs');
const path = require('path');
const { primaryGuildId } = require('../config/guilds');

const MEMORY_FILE = path.join(__dirname, '..', '..', 'data', 'memories.json');

const MAX_MEMORIES_PER_USER = 50;
const CONTEXT_MEMORY_COUNT = 10;

function readRaw() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return {};
    const data = fs.readFileSync(MEMORY_FILE, 'utf8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error('Error reading memories:', err);
    return {};
  }
}

function writeRaw(memories) {
  try {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));
  } catch (err) {
    console.error('Error saving memories:', err);
  }
}

/**
 * Fold a flat `{ userId: [...] }` memory file into the guild-scoped shape,
 * attributing everything to the primary guild. Backed up first — these are
 * accumulated over months and aren't recoverable from anywhere else.
 */
let migrationChecked = false;
function migrateIfNeeded(raw) {
  if (migrationChecked || raw.guilds) return raw;
  migrationChecked = true;

  const legacyUserIds = Object.keys(raw);
  if (legacyUserIds.length === 0) return { guilds: {} };

  const primary = primaryGuildId();
  if (!primary) {
    console.warn(
      'WARN: memories.json needs migrating but no primary guild is resolvable ' +
      '(set GUILD_ID). Leaving it alone.'
    );
    return raw;
  }

  try {
    const backup = `${MEMORY_FILE}.bak-${Date.now()}`;
    fs.copyFileSync(MEMORY_FILE, backup);
    console.log(`[Memory] Backed up pre-migration memories to ${path.basename(backup)}`);
  } catch (err) {
    console.warn('WARN: Could not back up memories, aborting migration:', err?.message || err);
    return raw;
  }

  const migrated = { guilds: { [primary]: raw } };
  writeRaw(migrated);
  console.log(`[Memory] Migrated ${legacyUserIds.length} user record(s) to guild ${primary}.`);
  return migrated;
}

/**
 * Get all memories, guild-scoped shape guaranteed.
 * @returns {Object} - { guilds: { [guildId]: { [userId]: Memory[] } } }
 */
function getMemories() {
  const raw = migrateIfNeeded(readRaw());
  if (!raw.guilds) raw.guilds = {};
  return raw;
}

/**
 * Get memories for a specific user in a guild.
 * @param {string} guildId
 * @param {string} userId - Discord user ID
 * @returns {Array<Object>} - Array of memory objects
 */
function getUserMemories(guildId, userId) {
  const guild = getMemories().guilds[guildId] || {};
  return guild[userId] || [];
}

/**
 * Add a memory for a user in a guild.
 * @param {string} guildId
 * @param {string} userId - Discord user ID
 * @param {string} memory - Memory text
 * @param {string} category - Optional category (e.g., 'fact', 'preference', 'event')
 */
function addMemory(guildId, userId, memory, category = 'general') {
  if (!guildId || !userId) return;
  const memories = getMemories();
  const guild = memories.guilds[guildId] || {};
  if (!guild[userId]) guild[userId] = [];

  guild[userId].push({
    text: memory,
    category,
    timestamp: new Date().toISOString(),
  });

  if (guild[userId].length > MAX_MEMORIES_PER_USER) {
    guild[userId] = guild[userId].slice(-MAX_MEMORIES_PER_USER);
  }

  memories.guilds[guildId] = guild;
  writeRaw(memories);
  console.log(`[Memory] Added for ${userId} in ${guildId}: ${memory}`);
}

/**
 * Clear all memories for a user in a guild.
 * @param {string} guildId
 * @param {string} userId - Discord user ID
 */
function clearUserMemories(guildId, userId) {
  const memories = getMemories();
  const guild = memories.guilds[guildId];
  if (!guild) return;
  delete guild[userId];
  writeRaw(memories);
}

/**
 * Format memories for AI context.
 * @param {string} guildId
 * @param {string} userId - Discord user ID
 * @returns {string} - Formatted memory string
 */
function formatMemoriesForContext(guildId, userId) {
  const memories = getUserMemories(guildId, userId);
  if (memories.length === 0) return '';

  const recent = memories.slice(-CONTEXT_MEMORY_COUNT);
  return '\n\nWhat I remember about this mortal:\n' +
    recent.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
}

module.exports = {
  getUserMemories,
  addMemory,
  clearUserMemories,
  formatMemoriesForContext,
};
