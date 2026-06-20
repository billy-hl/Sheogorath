'use strict';
const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', '..', 'data', 'memories.json');

/**
 * Get all memories from storage
 * @returns {Object} - Memory object with userId keys
 */
function getMemories() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return {};
    const data = fs.readFileSync(MEMORY_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading memories:', err);
    return {};
  }
}

/**
 * Save memories to storage
 * @param {Object} memories - Memory object
 */
function saveMemories(memories) {
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
 * Get memories for a specific user
 * @param {string} userId - Discord user ID
 * @returns {Array<Object>} - Array of memory objects
 */
function getUserMemories(userId) {
  const memories = getMemories();
  return memories[userId] || [];
}

/**
 * Add a memory for a user
 * @param {string} userId - Discord user ID
 * @param {string} memory - Memory text
 * @param {string} category - Optional category (e.g., 'fact', 'preference', 'event')
 */
function addMemory(userId, memory, category = 'general') {
  const memories = getMemories();
  if (!memories[userId]) {
    memories[userId] = [];
  }
  
  memories[userId].push({
    text: memory,
    category,
    timestamp: new Date().toISOString()
  });
  
  // Keep only last 50 memories per user
  if (memories[userId].length > 50) {
    memories[userId] = memories[userId].slice(-50);
  }
  
  saveMemories(memories);
  console.log(`[Memory] Added for ${userId}: ${memory}`);
}

/**
 * Clear all memories for a user
 * @param {string} userId - Discord user ID
 */
function clearUserMemories(userId) {
  const memories = getMemories();
  delete memories[userId];
  saveMemories(memories);
}

/**
 * Format memories for AI context
 * @param {string} userId - Discord user ID
 * @returns {string} - Formatted memory string
 */
function formatMemoriesForContext(userId) {
  const memories = getUserMemories(userId);
  if (memories.length === 0) return '';
  
  const recent = memories.slice(-10); // Last 10 memories
  return '\n\nWhat I remember about this mortal:\n' + fdsf
    recent.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
}

module.exports = {
  getUserMemories,
  addMemory,
  clearUserMemories,
  formatMemoriesForContext
};
