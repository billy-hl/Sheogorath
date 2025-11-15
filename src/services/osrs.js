const https = require('https');

// Skill names in the order they appear in the hiscores API
const SKILLS = [
  'Overall',
  'Attack',
  'Defence',
  'Strength',
  'Hitpoints',
  'Ranged',
  'Prayer',
  'Magic',
  'Cooking',
  'Woodcutting',
  'Fletching',
  'Fishing',
  'Firemaking',
  'Crafting',
  'Smithing',
  'Mining',
  'Herblore',
  'Agility',
  'Thieving',
  'Slayer',
  'Farming',
  'Runecraft',
  'Hunter',
  'Construction'
];

/**
 * Fetch player stats from OSRS Hiscores API with retry logic
 * @param {string} username - OSRS username
 * @param {number} retries - Number of retries (default 3)
 * @returns {Promise<Object>} Player stats with skill levels and XP
 */
async function fetchPlayerStats(username, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchPlayerStatsOnce(username);
    } catch (err) {
      if (attempt === retries) {
        throw err;
      }
      // Wait before retrying (exponential backoff: 2s, 4s, 8s)
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

/**
 * Single attempt to fetch player stats
 * @param {string} username - OSRS username
 * @returns {Promise<Object>} Player stats with skill levels and XP
 */
function fetchPlayerStatsOnce(username) {
  return new Promise((resolve, reject) => {
    const url = `https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=${encodeURIComponent(username)}`;
    
    const request = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 404) {
          return reject(new Error(`Player "${username}" not found in hiscores`));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`OSRS API returned status ${res.statusCode}`));
        }
        
        try {
          const stats = parseHiscoresData(data);
          resolve(stats);
        } catch (err) {
          reject(err);
        }
      });
    });
    
    request.on('error', (err) => {
      reject(err);
    });
    
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Parse the CSV-like data from OSRS Hiscores
 * Format: rank,level,xp for each skill
 * @param {string} data - Raw hiscores data
 * @returns {Object} Parsed stats object
 */
function parseHiscoresData(data) {
  const lines = data.trim().split('\n');
  const stats = {};
  
  // First 24 lines are skills
  for (let i = 0; i < SKILLS.length && i < lines.length; i++) {
    const [rank, level, xp] = lines[i].split(',').map(val => parseInt(val, 10));
    stats[SKILLS[i]] = {
      rank: rank === -1 ? null : rank,
      level: level === -1 ? 1 : level,
      xp: xp === -1 ? 0 : xp
    };
  }
  
  return stats;
}

/**
 * Compare two stat objects and return the differences
 * @param {Object} oldStats - Previous stats
 * @param {Object} newStats - Current stats
 * @returns {Array} Array of changes with skill name, old level, new level, xp gained
 */
function compareStats(oldStats, newStats) {
  const changes = [];
  
  for (const skill of SKILLS) {
    if (!oldStats[skill] || !newStats[skill]) continue;
    
    const oldLevel = oldStats[skill].level;
    const newLevel = newStats[skill].level;
    const oldXp = oldStats[skill].xp;
    const newXp = newStats[skill].xp;
    
    if (newLevel > oldLevel || newXp > oldXp) {
      changes.push({
        skill,
        oldLevel,
        newLevel,
        oldXp,
        newXp,
        xpGained: newXp - oldXp,
        levelsGained: newLevel - oldLevel
      });
    }
  }
  
  return changes;
}

/**
 * Get total level from stats
 * @param {Object} stats - Player stats
 * @returns {number} Total level
 */
function getTotalLevel(stats) {
  let total = 0;
  for (const skill of SKILLS) {
    if (skill === 'Overall') continue;
    if (stats[skill]) {
      total += stats[skill].level;
    }
  }
  return total;
}

module.exports = {
  fetchPlayerStats,
  compareStats,
  getTotalLevel,
  SKILLS
};
