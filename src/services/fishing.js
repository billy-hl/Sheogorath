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
        market: this.getDefaultMarket()
      }, null, 2));
    }
  }

  loadData() {
    try {
      const data = fs.readFileSync(this.dataFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading fishing data:', error);
      return {
        players: {},
        shop: this.getDefaultShop(),
        market: this.getDefaultMarket()
      };
    }
  }

  saveData(data) {
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
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
          biggestCatch: 0,
          totalCoins: 100
        },
        achievements: []
      };
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
}

module.exports = new FishingGame();
