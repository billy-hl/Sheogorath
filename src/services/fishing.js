const fs = require('fs');
const path = require('path');

class FishingGame {
  constructor() {
    this.dataFile = path.join(__dirname, '../data/fishing_data.json');
    this.ensureDataFile();
  }

  ensureDataFile() {
    if (!fs.existsSync(path.dirname(this.dataFile))) {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    }
    if (!fs.existsSync(this.dataFile)) {
      fs.writeFileSync(this.dataFile, JSON.stringify({
        players: {},
        shop: this.getDefaultShop(),
        market: this.getDefaultMarket(),
        challenges: this.getDefaultChallenges(),
        achievements: this.getDefaultAchievements(),
        tournaments: {},
        weather: this.getDefaultWeather()
      }, null, 2));
    }
  }

  loadData() {
    try {
      const data = fs.readFileSync(this.dataFile, 'utf8');
      const parsedData = JSON.parse(data);
      
      // Ensure all required global data structures exist
      if (!parsedData.challenges) {
        parsedData.challenges = this.getDefaultChallenges();
      }
      if (!parsedData.achievements) {
        parsedData.achievements = this.getDefaultAchievements();
      }
      if (!parsedData.tournaments) {
        parsedData.tournaments = {};
      }
      if (!parsedData.weather) {
        parsedData.weather = this.getDefaultWeather();
      }
      
      return parsedData;
    } catch (error) {
      console.error('Error loading fishing data:', error);
      return {
        players: {},
        shop: this.getDefaultShop(),
        market: this.getDefaultMarket(),
        challenges: this.getDefaultChallenges(),
        achievements: this.getDefaultAchievements(),
        tournaments: {},
        weather: this.getDefaultWeather()
      };
    }
  }

  saveData(data) {
    try {
      // Create a deep copy to avoid modifying the original data
      const dataToSave = JSON.parse(JSON.stringify(data, (key, value) => {
        // Convert Sets to arrays for JSON serialization
        if (value instanceof Set) {
          return Array.from(value);
        }
        return value;
      }));
      fs.writeFileSync(this.dataFile, JSON.stringify(dataToSave, null, 2));
    } catch (error) {
      console.error('Error saving fishing data:', error);
    }
  }

  getPlayerData(userId) {
    const data = this.loadData();
    if (!data.players[userId]) {
      data.players[userId] = {
        level: 1,
        experience: 0,
        coins: 100, // Starting money
        inventory: {},
        equipment: {
          rod: 'basic_rod',
          bait: 'worms',
          hook: 'basic_hook'
        },
        stats: {
          totalCasts: 0,
          totalFish: 0,
          rareFish: 0,
          legendaryFish: 0,
          biggestCatch: 0,
          totalCoins: 100,
          locationsVisited: new Set(),
          dailyStats: {
            date: new Date().toDateString(),
            casts: 0,
            fishCaught: 0,
            rareFish: 0,
            experience: 0
          },
          weeklyStats: {
            week: this.getWeekNumber(),
            casts: 0,
            fishCaught: 0,
            rareFish: 0,
            experience: 0
          }
        },
        achievements: [],
        challenges: {
          daily: {},
          weekly: {}
        },
        lastMiniGame: 0
      };
      this.saveData(data);
    } else {
      // Migration: Ensure existing players have new fields
      const player = data.players[userId];
      
      // Ensure stats object exists
      if (!player.stats) {
        player.stats = {
          totalCasts: 0,
          totalFish: 0,
          rareFish: 0,
          biggestCatch: 0,
          totalCoins: player.coins || 100
        };
      }
      
      // Add missing stats fields
      if (typeof player.stats.legendaryFish === 'undefined') player.stats.legendaryFish = 0;
      
      // Handle locationsVisited - convert from array to Set if needed
      if (!player.stats.locationsVisited) {
        player.stats.locationsVisited = new Set();
      } else if (Array.isArray(player.stats.locationsVisited)) {
        player.stats.locationsVisited = new Set(player.stats.locationsVisited);
      }
      
      // Handle dailyStats locations - convert from array to Set if needed
      if (player.stats.dailyStats && !player.stats.dailyStats.locations) {
        player.stats.dailyStats.locations = new Set();
      } else if (player.stats.dailyStats && Array.isArray(player.stats.dailyStats.locations)) {
        player.stats.dailyStats.locations = new Set(player.stats.dailyStats.locations);
      }
      
      // Add daily/weekly stats if missing
      if (!player.stats.dailyStats) {
        player.stats.dailyStats = {
          date: new Date().toDateString(),
          casts: 0,
          fishCaught: 0,
          rareFish: 0,
          experience: 0
        };
      }
      
      // Add daily/weekly stats if missing
      if (!player.stats.dailyStats) {
        player.stats.dailyStats = {
          date: new Date().toDateString(),
          casts: 0,
          fishCaught: 0,
          rareFish: 0,
          experience: 0
        };
      }
      
      if (!player.stats.weeklyStats) {
        player.stats.weeklyStats = {
          week: this.getWeekNumber(),
          casts: 0,
          fishCaught: 0,
          rareFish: 0,
          experience: 0
        };
      }
      
      // Add challenges if missing
      if (!player.challenges) {
        player.challenges = {
          daily: {},
          weekly: {}
        };
      }
      
      // Add lastMiniGame if missing
      if (typeof player.lastMiniGame === 'undefined') {
        player.lastMiniGame = 0;
      }
      
      // Save migrated data
      this.saveData(data);
    }
    return data.players[userId];
  }

  updatePlayerData(userId, updates) {
    const data = this.loadData();
    if (!data.players[userId]) {
      data.players[userId] = this.getPlayerData(userId);
    }
    Object.assign(data.players[userId], updates);
    this.saveData(data);
  }

  getDefaultShop() {
    return {
      rods: {
        basic_rod: { name: 'Basic Rod', cost: 0, description: 'A simple fishing rod for beginners' },
        sturdy_rod: { name: 'Sturdy Rod', cost: 500, description: 'A more durable rod for deeper waters' },
        enchanted_rod: { name: 'Enchanted Rod', cost: 2000, description: 'A magical rod that attracts rare fish' },
        legendary_rod: { name: 'Legendary Rod', cost: 5000, description: 'The ultimate fishing rod of legends' }
      },
      bait: {
        worms: { name: 'Worms', cost: 10, description: 'Basic bait for common fish' },
        minnows: { name: 'Minnows', cost: 25, description: 'Live bait for better catches' },
        magical_lure: { name: 'Magical Lure', cost: 100, description: 'Enchanted bait that glows in the dark' },
        dragon_scale: { name: 'Dragon Scale', cost: 500, description: 'Extremely rare bait from ancient dragons' }
      },
      hooks: {
        basic_hook: { name: 'Basic Hook', cost: 0, description: 'Standard fishing hook' },
        barbed_hook: { name: 'Barbed Hook', cost: 200, description: 'Hook that catches more fish' },
        golden_hook: { name: 'Golden Hook', cost: 800, description: 'Luxurious hook that attracts valuable fish' },
        dimensional_hook: { name: 'Dimensional Hook', cost: 3000, description: 'Hook that can catch fish from other realms' }
      }
    };
  }

  getDefaultMarket() {
    return {
      fish_prices: {
        // Common fish
        minnow: { basePrice: 5, rarity: 'common' },
        perch: { basePrice: 8, rarity: 'common' },
        catfish: { basePrice: 12, rarity: 'common' },
        bass: { basePrice: 15, rarity: 'common' },

        // Uncommon fish
        trout: { basePrice: 25, rarity: 'uncommon' },
        salmon: { basePrice: 35, rarity: 'uncommon' },
        tuna: { basePrice: 45, rarity: 'uncommon' },

        // Rare fish
        golden_fish: { basePrice: 100, rarity: 'rare' },
        crystal_fish: { basePrice: 150, rarity: 'rare' },
        shadow_fish: { basePrice: 200, rarity: 'rare' },

        // Legendary fish
        dragon_fish: { basePrice: 500, rarity: 'legendary' },
        phoenix_fish: { basePrice: 750, rarity: 'legendary' },
        void_fish: { basePrice: 1000, rarity: 'legendary' },

        // Special event fish
        festival_fish: { basePrice: 300, rarity: 'event' },
        lunar_fish: { basePrice: 400, rarity: 'event' }
      }
    };
  }

  getDefaultChallenges() {
    return {
      daily: [
        {
          id: 'daily_caster',
          name: 'Daily Caster',
          description: 'Cast your line 10 times today',
          type: 'casts',
          target: 10,
          reward: { coins: 100, exp: 50 },
          emoji: '🎣'
        },
        {
          id: 'daily_fisher',
          name: 'Daily Fisher',
          description: 'Catch 5 fish today',
          type: 'fish_caught',
          target: 5,
          reward: { coins: 150, exp: 75 },
          emoji: '🐟'
        },
        {
          id: 'daily_explorer',
          name: 'Daily Explorer',
          description: 'Fish in 3 different locations today',
          type: 'locations',
          target: 3,
          reward: { coins: 200, exp: 100 },
          emoji: '🗺️'
        }
      ],
      weekly: [
        {
          id: 'weekly_master',
          name: 'Weekly Master',
          description: 'Catch 25 fish this week',
          type: 'fish_caught',
          target: 25,
          reward: { coins: 500, exp: 250 },
          emoji: '👑'
        },
        {
          id: 'weekly_rare_hunter',
          name: 'Rare Hunter',
          description: 'Catch 3 rare or legendary fish this week',
          type: 'rare_fish',
          target: 3,
          reward: { coins: 750, exp: 300 },
          emoji: '💎'
        },
        {
          id: 'weekly_leveler',
          name: 'Weekly Leveler',
          description: 'Gain 500 experience this week',
          type: 'experience',
          target: 500,
          reward: { coins: 300, exp: 150 },
          emoji: '⬆️'
        }
      ]
    };
  }

  getDefaultAchievements() {
    return [
      {
        id: 'first_cast',
        name: 'First Cast',
        description: 'Cast your line for the first time',
        type: 'casts',
        target: 1,
        reward: { coins: 50, exp: 25 },
        emoji: '🎣',
        unlocked: false
      },
      {
        id: 'century_club',
        name: 'Century Club',
        description: 'Cast your line 100 times',
        type: 'casts',
        target: 100,
        reward: { coins: 500, exp: 200 },
        emoji: '💯',
        unlocked: false
      },
      {
        id: 'fish_master',
        name: 'Fish Master',
        description: 'Catch 50 fish',
        type: 'fish_caught',
        target: 50,
        reward: { coins: 300, exp: 150 },
        emoji: '🐟',
        unlocked: false
      },
      {
        id: 'rare_fisher',
        name: 'Rare Fisher',
        description: 'Catch your first rare fish',
        type: 'rare_fish',
        target: 1,
        reward: { coins: 200, exp: 100 },
        emoji: '💎',
        unlocked: false
      },
      {
        id: 'legendary_catcher',
        name: 'Legendary Catcher',
        description: 'Catch your first legendary fish',
        type: 'legendary_fish',
        target: 1,
        reward: { coins: 1000, exp: 500 },
        emoji: '👑',
        unlocked: false
      },
      {
        id: 'big_game_hunter',
        name: 'Big Game Hunter',
        description: 'Catch a fish weighing 15+ lbs',
        type: 'big_catch',
        target: 15,
        reward: { coins: 750, exp: 300 },
        emoji: '🏆',
        unlocked: false
      },
      {
        id: 'millionaire',
        name: 'Millionaire',
        description: 'Accumulate 10,000 coins',
        type: 'coins',
        target: 10000,
        reward: { coins: 1000, exp: 500 },
        emoji: '💰',
        unlocked: false
      },
      {
        id: 'level_10',
        name: 'Apprentice Fisher',
        description: 'Reach fishing level 10',
        type: 'level',
        target: 10,
        reward: { coins: 500, exp: 250 },
        emoji: '🎓',
        unlocked: false
      },
      {
        id: 'level_25',
        name: 'Expert Fisher',
        description: 'Reach fishing level 25',
        type: 'level',
        target: 25,
        reward: { coins: 1000, exp: 500 },
        emoji: '🎯',
        unlocked: false
      },
      {
        id: 'level_50',
        name: 'Master Fisher',
        description: 'Reach fishing level 50',
        type: 'level',
        target: 50,
        reward: { coins: 2000, exp: 1000 },
        emoji: '👑',
        unlocked: false
      }
    ];
  }

  getDefaultWeather() {
    return {
      current: 'sunny',
      effects: {
        sunny: { catchMultiplier: 1.0, message: 'Perfect fishing weather!' },
        cloudy: { catchMultiplier: 0.9, message: 'Overcast skies, fish are a bit shy.' },
        rainy: { catchMultiplier: 1.2, message: 'Rain brings the fish out!' },
        stormy: { catchMultiplier: 0.7, message: 'Stormy weather makes fishing difficult.' },
        foggy: { catchMultiplier: 0.8, message: 'Foggy conditions reduce visibility.' }
      }
    };
  }

  getFishRarity() {
    const rand = Math.random();
    if (rand < 0.6) return 'common';      // 60%
    if (rand < 0.85) return 'uncommon';   // 25%
    if (rand < 0.95) return 'rare';       // 10%
    if (rand < 0.99) return 'legendary';  // 4%
    return 'event';                       // 1%
  }

  getRandomFish(rarity, equipment) {
    const data = this.loadData();
    const fishByRarity = Object.entries(data.market.fish_prices)
      .filter(([_, info]) => info.rarity === rarity)
      .map(([name, info]) => ({ name, ...info }));

    if (fishByRarity.length === 0) return null;

    // Equipment modifiers
    let catchBonus = 1;
    if (equipment.rod === 'enchanted_rod') catchBonus *= 1.5;
    if (equipment.rod === 'legendary_rod') catchBonus *= 2;
    if (equipment.bait === 'magical_lure') catchBonus *= 1.3;
    if (equipment.bait === 'dragon_scale') catchBonus *= 1.8;
    if (equipment.hook === 'barbed_hook') catchBonus *= 1.2;
    if (equipment.hook === 'golden_hook') catchBonus *= 1.5;
    if (equipment.hook === 'dimensional_hook') catchBonus *= 2.5;

    const selectedFish = fishByRarity[Math.floor(Math.random() * fishByRarity.length)];
    const weight = Math.random() * 10 * catchBonus + 0.5; // 0.5 to 10+ lbs

    return {
      name: selectedFish.name,
      weight: Math.round(weight * 10) / 10,
      value: Math.floor(selectedFish.basePrice * (weight / 5) * (Math.random() * 0.4 + 0.8)), // ±20% variation
      rarity: selectedFish.rarity
    };
  }

  addToInventory(userId, item, quantity = 1) {
    const playerData = this.getPlayerData(userId);
    if (!playerData.inventory[item]) {
      playerData.inventory[item] = 0;
    }
    playerData.inventory[item] += quantity;
    this.updatePlayerData(userId, { inventory: playerData.inventory });
  }

  removeFromInventory(userId, item, quantity = 1) {
    const playerData = this.getPlayerData(userId);
    if (playerData.inventory[item] && playerData.inventory[item] >= quantity) {
      playerData.inventory[item] -= quantity;
      if (playerData.inventory[item] <= 0) {
        delete playerData.inventory[item];
      }
      this.updatePlayerData(userId, { inventory: playerData.inventory });
      return true;
    }
    return false;
  }

  addExperience(userId, exp) {
    const playerData = this.getPlayerData(userId);
    playerData.experience += exp;

    // Level up calculation (simple exponential growth)
    const newLevel = Math.floor(Math.sqrt(playerData.experience / 100)) + 1;
    if (newLevel > playerData.level) {
      playerData.level = newLevel;
      // Bonus coins for leveling up
      playerData.coins += newLevel * 50;
    }

    this.updatePlayerData(userId, {
      experience: playerData.experience,
      level: playerData.level,
      coins: playerData.coins
    });
  }

  getRarityColor(rarity) {
    const colors = {
      common: 0x808080,      // Gray
      uncommon: 0x00ff00,    // Green
      rare: 0x0080ff,        // Blue
      legendary: 0xff8000,   // Orange
      event: 0xff0080        // Pink
    };
    return colors[rarity] || 0xffffff;
  }

  getRarityEmoji(rarity) {
    const emojis = {
      common: '🐟',
      uncommon: '🐠',
      rare: '🦈',
      legendary: '🐋',
      event: '🎏'
    };
    return emojis[rarity] || '🐟';
  }

  // Utility methods
  getWeekNumber() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const diff = now - start;
    const oneWeek = 1000 * 60 * 60 * 24 * 7;
    return Math.floor(diff / oneWeek);
  }

  getCurrentWeather() {
    const data = this.loadData();
    return data.weather.current;
  }

  setWeather(weather) {
    const data = this.loadData();
    data.weather.current = weather;
    this.saveData(data);
  }

  // Challenge and achievement methods
  checkDailyChallenges(userId) {
    const playerData = this.getPlayerData(userId);
    const today = new Date().toDateString();
    
    // Reset daily stats if it's a new day
    if (playerData.stats.dailyStats.date !== today) {
      playerData.stats.dailyStats = {
        date: today,
        casts: 0,
        fishCaught: 0,
        rareFish: 0,
        experience: 0,
        locations: new Set()
      };
      playerData.challenges.daily = {};
    } else {
      // Ensure locations is a Set if it exists
      if (playerData.stats.dailyStats.locations && Array.isArray(playerData.stats.dailyStats.locations)) {
        playerData.stats.dailyStats.locations = new Set(playerData.stats.dailyStats.locations);
      } else if (!playerData.stats.dailyStats.locations) {
        playerData.stats.dailyStats.locations = new Set();
      }
      
      // Ensure locationsVisited is a Set if it exists
      if (playerData.stats.locationsVisited && Array.isArray(playerData.stats.locationsVisited)) {
        playerData.stats.locationsVisited = new Set(playerData.stats.locationsVisited);
      } else if (!playerData.stats.locationsVisited) {
        playerData.stats.locationsVisited = new Set();
      }
    }
    
    return playerData;
  }

  checkWeeklyChallenges(userId) {
    const playerData = this.getPlayerData(userId);
    const currentWeek = this.getWeekNumber();
    
    // Reset weekly stats if it's a new week
    if (playerData.stats.weeklyStats.week !== currentWeek) {
      playerData.stats.weeklyStats = {
        week: currentWeek,
        casts: 0,
        fishCaught: 0,
        rareFish: 0,
        experience: 0
      };
      playerData.challenges.weekly = {};
    }
    
    return playerData;
  }

  updateChallengeProgress(userId, type, value = 1) {
    const playerData = this.checkDailyChallenges(userId);
    this.checkWeeklyChallenges(userId);
    
    const data = this.loadData();
    const challenges = data.challenges;
    
    // Special handling for locations challenge
    if (type === 'locations') {
      // Update daily stats locations Set
      if (!playerData.stats.dailyStats.locations) {
        playerData.stats.dailyStats.locations = new Set();
      }
      playerData.stats.dailyStats.locations.add(value); // value is the location name
      
      // Update challenge progress based on unique locations visited
      const uniqueLocationsVisited = playerData.stats.dailyStats.locations.size;
      
      challenges.daily.forEach(challenge => {
        if (challenge.type === 'locations' && !playerData.challenges.daily[challenge.id]) {
          if (!playerData.challenges.daily[challenge.id]) {
            playerData.challenges.daily[challenge.id] = { progress: 0, completed: false };
          }
          
          playerData.challenges.daily[challenge.id].progress = uniqueLocationsVisited;
          
          if (playerData.challenges.daily[challenge.id].progress >= challenge.target) {
            playerData.challenges.daily[challenge.id].completed = true;
            this.giveChallengeReward(userId, challenge);
          }
        }
      });
    } else {
      // Update daily challenges for other types
      challenges.daily.forEach(challenge => {
        if (challenge.type === type && !playerData.challenges.daily[challenge.id]) {
          if (!playerData.challenges.daily[challenge.id]) {
            playerData.challenges.daily[challenge.id] = { progress: 0, completed: false };
          }
          
          playerData.challenges.daily[challenge.id].progress += value;
          
          if (playerData.challenges.daily[challenge.id].progress >= challenge.target) {
            playerData.challenges.daily[challenge.id].completed = true;
            this.giveChallengeReward(userId, challenge);
          }
        }
      });
    }
    
    // Update weekly challenges
    challenges.weekly.forEach(challenge => {
      if (challenge.type === type && !playerData.challenges.weekly[challenge.id]) {
        if (!playerData.challenges.weekly[challenge.id]) {
          playerData.challenges.weekly[challenge.id] = { progress: 0, completed: false };
        }
        
        playerData.challenges.weekly[challenge.id].progress += value;
        
        if (playerData.challenges.weekly[challenge.id].progress >= challenge.target) {
          playerData.challenges.weekly[challenge.id].completed = true;
          this.giveChallengeReward(userId, challenge);
        }
      }
    });
    
    this.updatePlayerData(userId, { challenges: playerData.challenges, stats: playerData.stats });
  }

  giveChallengeReward(userId, challenge) {
    const playerData = this.getPlayerData(userId);
    playerData.coins += challenge.reward.coins;
    this.addExperience(userId, challenge.reward.exp);
    
    // Mark as completed
    this.updatePlayerData(userId, { coins: playerData.coins });
  }

  checkAchievements(userId) {
    const playerData = this.getPlayerData(userId);
    const data = this.loadData();
    const achievements = data.achievements;
    const newAchievements = [];
    
    achievements.forEach(achievement => {
      if (!playerData.achievements.includes(achievement.id)) {
        let unlocked = false;
        
        switch (achievement.type) {
          case 'casts':
            unlocked = playerData.stats.totalCasts >= achievement.target;
            break;
          case 'fish_caught':
            unlocked = playerData.stats.totalFish >= achievement.target;
            break;
          case 'rare_fish':
            unlocked = playerData.stats.rareFish >= achievement.target;
            break;
          case 'legendary_fish':
            unlocked = playerData.stats.legendaryFish >= achievement.target;
            break;
          case 'big_catch':
            unlocked = playerData.stats.biggestCatch >= achievement.target;
            break;
          case 'coins':
            unlocked = playerData.coins >= achievement.target;
            break;
          case 'level':
            unlocked = playerData.level >= achievement.target;
            break;
        }
        
        if (unlocked) {
          playerData.achievements.push(achievement.id);
          playerData.coins += achievement.reward.coins;
          this.addExperience(userId, achievement.reward.exp);
          newAchievements.push(achievement);
        }
      }
    });
    
    if (newAchievements.length > 0) {
      this.updatePlayerData(userId, { 
        achievements: playerData.achievements,
        coins: playerData.coins
      });
    }
    
    return newAchievements;
  }

  // Mini-game methods
  playMiniGame(userId, fishRarity) {
    const playerData = this.getPlayerData(userId);
    const now = Date.now();
    
    // Cooldown check (30 seconds between mini-games)
    if (now - playerData.lastMiniGame < 30000) {
      return { success: false, message: 'Mini-game cooldown active!' };
    }
    
    playerData.lastMiniGame = now;
    
    // Mini-game difficulty based on fish rarity
    const difficulties = {
      common: 0.8,
      uncommon: 0.7,
      rare: 0.6,
      legendary: 0.5,
      event: 0.4
    };
    
    const difficulty = difficulties[fishRarity] || 0.8;
    const success = Math.random() < difficulty;
    
    if (success) {
      const bonusMultiplier = 1 + (1 - difficulty) * 2; // Higher bonus for harder games
      return { 
        success: true, 
        bonus: bonusMultiplier,
        message: `🎮 Mini-game success! Bonus multiplier: ${bonusMultiplier.toFixed(1)}x`
      };
    } else {
      return { 
        success: false, 
        bonus: 0.5,
        message: '🎮 Mini-game failed! Reduced catch rate.' 
      };
    }
  }

  // Weather effects
  getWeatherMultiplier() {
    const weather = this.getCurrentWeather();
    const data = this.loadData();
    return data.weather.effects[weather]?.catchMultiplier || 1.0;
  }

  getWeatherMessage() {
    const weather = this.getCurrentWeather();
    const data = this.loadData();
    return data.weather.effects[weather]?.message || 'Weather conditions are normal.';
  }

  // Enhanced fishing with all new features
  attemptCatch(userId, location) {
    const playerData = this.checkDailyChallenges(userId);
    this.checkWeeklyChallenges(userId);
    
    // Update location tracking
    if (!playerData.stats.locationsVisited) {
      playerData.stats.locationsVisited = new Set();
    } else if (Array.isArray(playerData.stats.locationsVisited)) {
      playerData.stats.locationsVisited = new Set(playerData.stats.locationsVisited);
    }
    
    const isNewLocation = !playerData.stats.locationsVisited.has(location);
    playerData.stats.locationsVisited.add(location);
    
    // Update location challenge if it's a new location
    if (isNewLocation) {
      this.updateChallengeProgress(userId, 'locations', location);
    }
    
    // Weather effects
    const weatherMultiplier = this.getWeatherMultiplier();
    
    // Equipment modifiers
    let catchChance = this.getBaseCatchChance(location) * weatherMultiplier;
    catchChance *= this.getEquipmentModifier(playerData.equipment);
    
    // Mini-game bonus
    const miniGameResult = this.playMiniGame(userId, 'common'); // Default rarity for chance calculation
    if (miniGameResult.success) {
      catchChance *= miniGameResult.bonus;
    }
    
    // Update daily/weekly stats
    playerData.stats.dailyStats.casts++;
    playerData.stats.weeklyStats.casts++;
    playerData.stats.totalCasts++;
    
    this.updateChallengeProgress(userId, 'casts');
    
    if (Math.random() < catchChance) {
      // Determine rarity with location bonuses
      const locationBonuses = this.getLocationBonuses(location);
      let rarity = this.getFishRarityWithBonuses(locationBonuses);
      
      const fish = this.getRandomFish(rarity, playerData.equipment);
      
      if (fish) {
        // Mini-game for actual catch
        const actualMiniGame = this.playMiniGame(userId, fish.rarity);
        if (actualMiniGame.success) {
          fish.weight *= actualMiniGame.bonus;
          fish.value = Math.floor(fish.value * actualMiniGame.bonus);
        }
        
        // Add to inventory and update stats
        this.addToInventory(userId, fish.name, 1);
        
        playerData.stats.totalFish++;
        playerData.stats.dailyStats.fishCaught++;
        playerData.stats.weeklyStats.fishCaught++;
        
        if (fish.weight > playerData.stats.biggestCatch) {
          playerData.stats.biggestCatch = fish.weight;
        }
        
        if (['rare', 'legendary', 'event'].includes(fish.rarity)) {
          playerData.stats.rareFish++;
          playerData.stats.dailyStats.rareFish++;
          playerData.stats.weeklyStats.rareFish++;
          
          if (fish.rarity === 'legendary') {
            playerData.stats.legendaryFish++;
          }
        }
        
        // Update challenges and achievements
        this.updateChallengeProgress(userId, 'fish_caught');
        if (['rare', 'legendary', 'event'].includes(fish.rarity)) {
          this.updateChallengeProgress(userId, 'rare_fish');
        }
        
        // Update tournament scores
        this.updateTournamentScore(userId, fish);
        
        const newAchievements = this.checkAchievements(userId);
        
        this.updatePlayerData(userId, { stats: playerData.stats });
        
        return { 
          success: true, 
          fish, 
          miniGame: actualMiniGame,
          newAchievements,
          weather: this.getWeatherMessage()
        };
      }
    }
    
    this.updatePlayerData(userId, { stats: playerData.stats });
    return { 
      success: false, 
      miniGame: miniGameResult,
      weather: this.getWeatherMessage()
    };
  }

  getLocationBonuses(location) {
    return {
      river: { common: 1.2, uncommon: 1.0, rare: 0.8, legendary: 0.5, event: 0.1 },
      ocean: { common: 0.8, uncommon: 1.2, rare: 1.0, legendary: 0.8, event: 0.2 },
      mountain: { common: 0.9, uncommon: 0.9, rare: 1.3, legendary: 1.0, event: 0.3 },
      mystic: { common: 0.5, uncommon: 0.8, rare: 1.2, legendary: 1.5, event: 0.5 },
      lava: { common: 0.3, uncommon: 0.5, rare: 1.0, legendary: 2.0, event: 1.0 }
    }[location] || { common: 1.0, uncommon: 1.0, rare: 1.0, legendary: 1.0, event: 1.0 };
  }

  getFishRarityWithBonuses(bonuses) {
    const rand = Math.random();
    if (rand < 0.6 * bonuses.common) return 'common';
    if (rand < 0.85 * bonuses.uncommon) return 'uncommon';
    if (rand < 0.95 * bonuses.rare) return 'rare';
    if (rand < 0.99 * bonuses.legendary) return 'legendary';
    return 'event';
  }

  getBaseCatchChance(location) {
    const chances = {
      river: 0.7,
      ocean: 0.6,
      mountain: 0.5,
      mystic: 0.4,
      lava: 0.3
    };
    return chances[location] || 0.5;
  }

  getEquipmentModifier(equipment) {
    let modifier = 1.0;

    // Rod modifiers
    if (equipment.rod === 'sturdy_rod') modifier *= 1.1;
    else if (equipment.rod === 'enchanted_rod') modifier *= 1.3;
    else if (equipment.rod === 'legendary_rod') modifier *= 1.6;

    // Bait modifiers
    if (equipment.bait === 'minnows') modifier *= 1.15;
    else if (equipment.bait === 'magical_lure') modifier *= 1.3;
    else if (equipment.bait === 'dragon_scale') modifier *= 1.5;

    // Hook modifiers
    if (equipment.hook === 'barbed_hook') modifier *= 1.1;
    else if (equipment.hook === 'golden_hook') modifier *= 1.25;
    else if (equipment.hook === 'dimensional_hook') modifier *= 1.4;

    return modifier;
  }

  // Tournament methods
  updateTournamentScore(userId, fish) {
    const data = this.loadData();
    const activeTournament = Object.values(data.tournaments || {}).find(t => t.active);
    
    if (!activeTournament || !activeTournament.participants?.includes(userId)) {
      return; // No active tournament or user not participating
    }

    if (!activeTournament.scores) activeTournament.scores = {};
    if (!activeTournament.scores[userId]) {
      activeTournament.scores[userId] = {
        totalFish: 0,
        totalWeight: 0,
        rareFish: 0,
        legendaryFish: 0,
        score: 0
      };
    }

    const playerScore = activeTournament.scores[userId];
    playerScore.totalFish++;
    playerScore.totalWeight += fish.weight;
    
    if (fish.rarity === 'rare' || fish.rarity === 'legendary' || fish.rarity === 'event') {
      playerScore.rareFish++;
    }
    
    if (fish.rarity === 'legendary') {
      playerScore.legendaryFish++;
    }

    // Calculate score (weight * rarity multiplier)
    const rarityMultipliers = {
      common: 1,
      uncommon: 2,
      rare: 5,
      legendary: 10,
      event: 15
    };
    
    const scoreGain = Math.floor(fish.weight * rarityMultipliers[fish.rarity]);
    playerScore.score += scoreGain;

    // Save tournament data
    data.tournaments[activeTournament.id] = activeTournament;
    this.saveData(data);
  }

  getActiveTournament() {
    const data = this.loadData();
    return Object.values(data.tournaments || {}).find(t => t.active);
  }

  clearAllData() {
    try {
      const defaultData = {
        players: {},
        shop: this.getDefaultShop(),
        market: this.getDefaultMarket(),
        challenges: this.getDefaultChallenges(),
        achievements: this.getDefaultAchievements(),
        tournaments: {},
        weather: this.getDefaultWeather()
      };
      
      this.saveData(defaultData);
      console.log('✅ All fishing data has been cleared and reset to defaults.');
      return true;
    } catch (error) {
      console.error('❌ Error clearing fishing data:', error);
      return false;
    }
  }

  // Tournament management methods
  endExpiredTournaments() {
    const data = this.loadData();
    const now = Date.now();
    const endedTournaments = [];

    for (const [tournamentId, tournament] of Object.entries(data.tournaments)) {
      if (tournament.active && tournament.endTime && now >= tournament.endTime) {
        tournament.active = false;
        tournament.ended = true;
        endedTournaments.push(tournament);
      }
    }

    if (endedTournaments.length > 0) {
      this.saveData(data);
    }

    return endedTournaments;
  }
}

module.exports = new FishingGame();
