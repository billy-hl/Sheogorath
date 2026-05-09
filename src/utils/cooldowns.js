'use strict';

// Per-user command cooldowns (5 seconds)
const cooldowns = new Map();
const COOLDOWN_MS = 5000;

/**
 * Check if a user is on cooldown for a command.
 * @param {string} userId - Discord user ID
 * @param {string} commandName - Command name
 * @returns {number|null} Remaining cooldown in seconds, or null if not on cooldown
 */
function checkCooldown(userId, commandName) {
  const key = `${userId}:${commandName}`;
  const lastUsed = cooldowns.get(key);
  
  if (!lastUsed) return null;
  
  const elapsed = Date.now() - lastUsed;
  if (elapsed < COOLDOWN_MS) {
    return Math.ceil((COOLDOWN_MS - elapsed) / 1000);
  }
  
  return null;
}

/**
 * Set cooldown for a user-command pair.
 * @param {string} userId - Discord user ID
 * @param {string} commandName - Command name
 */
function setCooldown(userId, commandName) {
  const key = `${userId}:${commandName}`;
  cooldowns.set(key, Date.now());
}

module.exports = { checkCooldown, setCooldown };
