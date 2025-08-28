const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fishingGame = require('../services/fishing');
const { getAIResponse } = require('../ai/openai');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fish')
    .setDescription('🎣 Complete fishing game system')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('What would you like to do?')
        .setRequired(false)
        .addChoices(
          { name: '🎣 Cast Line', value: 'cast' },
          { name: '🛒 Shop', value: 'shop' },
          { name: '📊 Stats', value: 'stats' },
          { name: '❓ Help', value: 'help' }
        ))
    .addStringOption(option =>
      option.setName('location')
        .setDescription('Where do you want to fish? (for cast action)')
        .setRequired(false)
        .addChoices(
          { name: '🏞️ River', value: 'river' },
          { name: '🌊 Ocean', value: 'ocean' },
          { name: '🏔️ Mountain Lake', value: 'mountain' },
          { name: '🌌 Mystic Pond', value: 'mystic' },
          { name: '🔥 Lava Lake', value: 'lava' }
        ))
    .addStringOption(option =>
      option.setName('weather_set')
        .setDescription('Set new weather (admin only, for weather action)')
        .setRequired(false)
        .addChoices(
          { name: 'Sunny', value: 'sunny' },
          { name: 'Cloudy', value: 'cloudy' },
          { name: 'Rainy', value: 'rainy' },
          { name: 'Stormy', value: 'stormy' },
          { name: 'Foggy', value: 'foggy' }
        ))
    .addStringOption(option =>
      option.setName('challenge_type')
        .setDescription('Type of challenges to view (for challenges action)')
        .setRequired(false)
        .addChoices(
          { name: 'Daily', value: 'daily' },
          { name: 'Weekly', value: 'weekly' },
          { name: 'All', value: 'all' }
        ))
    .addStringOption(option =>
      option.setName('achievement_filter')
        .setDescription('Filter achievements by status (for achievements action)')
        .setRequired(false)
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Completed', value: 'completed' },
          { name: 'In Progress', value: 'progress' }
        ))
    .addStringOption(option =>
      option.setName('minigame_difficulty')
        .setDescription('Mini-game difficulty (for minigame action)')
        .setRequired(false)
        .addChoices(
          { name: 'Easy (Common Fish)', value: 'common' },
          { name: 'Medium (Uncommon Fish)', value: 'uncommon' },
          { name: 'Hard (Rare Fish)', value: 'rare' },
          { name: 'Expert (Legendary Fish)', value: 'legendary' },
          { name: 'Master (Event Fish)', value: 'event' }
        ))
    .addStringOption(option =>
      option.setName('confirm_clear')
        .setDescription('Type "CONFIRM" to clear all data (admin only, for clear action)')
        .setRequired(false)),

  async execute(interaction) {
    const action = interaction.options.getString('action') || 'help';

    switch (action) {
      case 'help':
        return await this.handleHelp(interaction);
      case 'cast':
        return await this.handleCast(interaction);
      case 'shop':
        return await this.handleShop(interaction);
      case 'stats':
        return await this.handleStats(interaction);
      default:
        return await this.handleHelp(interaction);
    }
  },

  // Handle help menu
  async handleHelp(interaction) {
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);

    const embed = new EmbedBuilder()
      .setTitle('🎣 Fishing Game Commands')
      .setDescription('Welcome to the ultimate fishing experience! Here are all available commands:')
      .setColor(0x4a90e2)
      .setFooter({
        text: `Level ${playerData.level} Fisher • ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      })
      .setTimestamp();

    // Main commands
    embed.addFields({
      name: '🎣 **Available Actions**',
      value: 
        `• **Cast Line** - Cast your line and try to catch fish!\n` +
        `  └ Choose from 5 different locations with unique fish\n` +
        `  └ Weather affects catch rates and mini-games\n` +
        `  └ Equipment bonuses and level progression\n\n` +
        `• **Shop** - Buy equipment and sell your fish\n` +
        `  └ Upgrade your rods, bait, and hooks\n` +
        `  └ Sell caught fish for coins\n` +
        `  └ View your inventory\n\n` +
        `• **Stats** - View all your fishing statistics\n` +
        `  └ Challenges, achievements, and progress\n` +
        `  └ Weather conditions and mini-games\n` +
        `  └ Detailed fishing statistics\n\n` +
        `• **Help** - Show this help menu`,
      inline: false
    });

    // Admin commands (only show to admins)
    const isAdmin = interaction.member.permissions.has('Administrator') || 
                   interaction.user.id === process.env.ADMIN_USER_ID;
    
    if (isAdmin) {
      embed.addFields({
        name: '⚠️ **Admin Actions**',
        value: 
          `• **Clear Data** - **DANGER:** Clear all fishing data\n` +
          `  └ Requires confirmation: Type "CONFIRM"\n` +
          `  └ **Cannot be undone!**`,
        inline: false
      });
    }

    // Quick stats
    embed.addFields({
      name: '📊 **Your Stats**',
      value: 
        `**Level:** ${playerData.level}\n` +
        `**Coins:** ${playerData.coins}\n` +
        `**Total Fish:** ${playerData.stats.totalFish || 0}\n` +
        `**Rare Fish:** ${playerData.stats.rareFish || 0}`,
      inline: true
    });

    // Tips
    embed.addFields({
      name: '💡 **Tips**',
      value: 
        `• Use better equipment for higher catch rates\n` +
        `• Complete daily challenges for rewards\n` +
        `• Weather affects fishing success\n` +
        `• Mini-games give bonus multipliers\n` +
        `• Legendary fish trigger special AI comments!`,
      inline: true
    });

    // Quick action buttons
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('fish_quick_cast')
          .setLabel('🎣 Quick Cast')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('fish_view_challenges')
          .setLabel('🎯 Challenges')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_view_achievements')
          .setLabel('🏆 Achievements')
          .setStyle(ButtonStyle.Success)
      );

    await interaction.reply({ embeds: [embed], components: [row] });
  },

  // Handle shop
  async handleShop(interaction) {
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);
    const shopData = fishingGame.loadData().shop;

    const embed = new EmbedBuilder()
      .setTitle('🛒 Fishing Shop')
      .setDescription(`**Welcome to the shop!**\n\n**Your Coins:** ${playerData.coins} 🪙\n\nChoose what you'd like to browse:`)
      .setColor(0x00ff00)
      .setFooter({
        text: `Shop - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      })
      .setTimestamp();

    // Shop categories
    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_rods')
          .setLabel('🎣 Rods')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('shop_bait')
          .setLabel('🪱 Bait')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('shop_hooks')
          .setLabel('🪝 Hooks')
          .setStyle(ButtonStyle.Primary)
      );

    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('shop_sell')
          .setLabel('💰 Sell Fish')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('shop_inventory')
          .setLabel('📦 Inventory')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.reply({ embeds: [embed], components: [row1, row2] });
  },

  // Handle stats menu
  async handleStats(interaction) {
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);

    const embed = new EmbedBuilder()
      .setTitle('📊 Fishing Statistics')
      .setDescription(`**Your Fishing Profile**\n\n**Level:** ${playerData.level}\n**Experience:** ${playerData.experience}\n**Coins:** ${playerData.coins}\n\nChoose what stats you'd like to view:`)
      .setColor(0x4a90e2)
      .setFooter({
        text: `Stats - ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      })
      .setTimestamp();

    // Quick stats
    embed.addFields({
      name: '🎣 Fishing Stats',
      value: 
        `**Total Casts:** ${playerData.stats.totalCasts || 0}\n` +
        `**Fish Caught:** ${playerData.stats.totalFish || 0}\n` +
        `**Rare Fish:** ${playerData.stats.rareFish || 0}\n` +
        `**Legendary Fish:** ${playerData.stats.legendaryFish || 0}\n` +
        `**Biggest Catch:** ${playerData.stats.biggestCatch || 0} lbs`,
      inline: true
    });

    // Stats menu buttons
    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('stats_challenges')
          .setLabel('🎯 Challenges')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('stats_achievements')
          .setLabel('🏆 Achievements')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('stats_weather')
          .setLabel('🌤️ Weather')
          .setStyle(ButtonStyle.Secondary)
      );

    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('stats_minigame')
          .setLabel('🎮 Mini-Game')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('fish_quick_cast')
          .setLabel('🎣 Go Fish!')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.reply({ embeds: [embed], components: [row1, row2] });
  },

  // Handle main fishing (cast)
  async handleCast(interaction) {
    const location = interaction.options.getString('location') || 'river';
    const userId = interaction.user.id;
    const allowedChannelId = '1410703437502353428';

    // Check if command is used in the correct channel
    if (interaction.channelId !== allowedChannelId) {
      return await interaction.reply({
        content: `❌ Fishing is only allowed in the designated fishing channel! Please use the fishing commands there.`,
        flags: 64
      });
    }

    const playerData = fishingGame.getPlayerData(userId);

    await interaction.deferReply();

    try {
      // Check if player has enough stamina (simple cooldown system)
      const now = Date.now();
      const lastCast = playerData.lastCast || 0;
      const cooldown = 1000; // 1 second between casts

      if (now - lastCast < cooldown) {
        const remaining = Math.ceil((cooldown - (now - lastCast)) / 1000);
        return await interaction.editReply(`⏰ **Cooldown Active!** You must wait ${remaining} seconds before casting again.`);
      }

      // Update last cast time
      fishingGame.updatePlayerData(userId, { lastCast: now });

      // Attempt to catch a fish using the enhanced system
      const catchResult = fishingGame.attemptCatch(userId, location);
      
      // Create response embed
      const embed = new EmbedBuilder()
        .setTitle('🎣 Fishing Adventure')
        .setColor(catchResult.success ? fishingGame.getRarityColor(catchResult.fish.rarity) : 0x666666)
        .setFooter({
          text: `Level ${playerData.level} Fisher • ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        });

      if (catchResult.success) {
        const fish = catchResult.fish;
        const emoji = fishingGame.getRarityEmoji(fish.rarity);
        
        embed.setDescription(`**${this.getLocationName(location)}**

${emoji} **You caught a ${fish.name.replace('_', ' ')}!**

**Weight:** ${fish.weight} lbs
**Value:** ${fish.value} coins
**Rarity:** ${fish.rarity.charAt(0).toUpperCase() + fish.rarity.slice(1)}`);

        // Weather information
        embed.addFields({
          name: '🌤️ Weather',
          value: catchResult.weather,
          inline: true
        });

        // Mini-game results
        if (catchResult.miniGame && catchResult.miniGame.success) {
          embed.addFields({
            name: '🎮 Mini-Game Bonus!',
            value: catchResult.miniGame.message,
            inline: true
          });
        }

        // Achievement notifications
        if (catchResult.newAchievements && catchResult.newAchievements.length > 0) {
          const achievementText = catchResult.newAchievements.map(ach => 
            `${ach.emoji} **${ach.name}** - ${ach.description}`
          ).join('\n');
          
          embed.addFields({
            name: '🏆 New Achievements!',
            value: achievementText,
            inline: false
          });
        }

        // AI comments for rare catches
        if (fish.rarity === 'legendary' || fish.rarity === 'event') {
          try {
            const aiPrompt = fish.rarity === 'legendary' 
              ? `Comment on ${interaction.user.username} catching a legendary ${fish.name.replace('_', ' ')} weighing ${fish.weight} lbs in your typical chaotic, excited style. Make it epic and memorable!`
              : `Comment on ${interaction.user.username} catching a special event ${fish.name.replace('_', ' ')} weighing ${fish.weight} lbs. Make it mysterious and otherworldly in your style!`;
            
            const aiComment = await getAIResponse(aiPrompt);
            
            embed.addFields({
              name: fish.rarity === 'legendary' ? '🎭 Sheogorath\'s Praise' : '🌟 Sheogorath\'s Wonder',
              value: `*${aiComment}*`,
              inline: false
            });
          } catch (aiError) {
            console.error('AI comment generation failed:', aiError);
            // Fallback to static messages
            const fallbackMessage = fish.rarity === 'legendary'
              ? `*The Mad King is impressed! This fish shall be remembered in the annals of fishing history!*`
              : `*A fish touched by the cosmos itself! The stars align for you, mortal!*`;
            
            embed.addFields({
              name: fish.rarity === 'legendary' ? '🎉 Legendary Catch!' : '🌟 Special Event Fish!',
              value: fallbackMessage,
              inline: false
            });
          }
        }

        // Level up notification
        const newPlayerData = fishingGame.getPlayerData(userId);
        if (newPlayerData.level > playerData.level) {
          embed.addFields({
            name: '⬆️ Level Up!',
            value: `**Congratulations!** You reached level ${newPlayerData.level}!\n*You received ${newPlayerData.level * 50} bonus coins!*`,
            inline: false
          });
        }
      } else {
        embed.setDescription(`**${this.getLocationName(location)}**

🎣 **No fish this time!**

*The waters remain mysterious... try again!*`);

        // Weather information for failed catches too
        embed.addFields({
          name: '🌤️ Weather',
          value: catchResult.weather,
          inline: true
        });

        // Mini-game results for failed catches
        if (catchResult.miniGame && !catchResult.miniGame.success) {
          embed.addFields({
            name: '🎮 Mini-Game Result',
            value: catchResult.miniGame.message,
            inline: true
          });
        }
      }

      // Add equipment info
      const equipment = playerData.equipment;
      embed.addFields({
        name: '🎯 Equipment',
        value: `**Rod:** ${fishingGame.loadData().shop.rods[equipment.rod].name}\n**Bait:** ${fishingGame.loadData().shop.bait[equipment.bait].name}\n**Hook:** ${fishingGame.loadData().shop.hooks[equipment.hook].name}`,
        inline: true
      });

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Fishing command error:', error);
      await interaction.editReply('❌ Something went wrong with your fishing trip! Please try again.');
    }
  },

  // Handle weather management
  async handleWeather(interaction) {
    const newWeather = interaction.options.getString('weather_set');
    const currentWeather = fishingGame.getCurrentWeather();
    const data = fishingGame.loadData();
    const weatherEffects = data.weather.effects;
    
    await interaction.deferReply();

    try {
      // Check if user is trying to set weather (admin check)
      if (newWeather) {
        const isAdmin = interaction.member.permissions.has('Administrator') || 
                       interaction.user.id === process.env.ADMIN_USER_ID;
        
        if (!isAdmin) {
          return await interaction.editReply('❌ Only administrators can change the weather!');
        }
        
        fishingGame.setWeather(newWeather);
        
        const embed = new EmbedBuilder()
          .setTitle('🌤️ Weather Changed!')
          .setDescription(`**${interaction.user.username}** has changed the weather to **${newWeather.charAt(0).toUpperCase() + newWeather.slice(1)}**!`)
          .setColor(0xffa500)
          .addFields({
            name: '📊 Effects',
            value: weatherEffects[newWeather].message,
            inline: true
          })
          .setFooter({
            text: `Weather control by ${interaction.user.username}`,
            iconURL: interaction.user.displayAvatarURL({ dynamic: true })
          })
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
      } else {
        // Just show current weather
        const embed = new EmbedBuilder()
          .setTitle('🌤️ Current Fishing Weather')
          .setDescription(`**${currentWeather.charAt(0).toUpperCase() + currentWeather.slice(1)}**`)
          .setColor(this.getWeatherColor(currentWeather))
          .addFields(
            {
              name: '📊 Catch Rate Multiplier',
              value: `${weatherEffects[currentWeather].catchMultiplier}x`,
              inline: true
            },
            {
              name: '💬 Conditions',
              value: weatherEffects[currentWeather].message,
              inline: true
            }
          )
          .setFooter({
            text: 'Weather affects fishing success rates',
            iconURL: interaction.user.displayAvatarURL({ dynamic: true })
          })
          .setTimestamp();

        // Add weather emoji
        embed.setThumbnail(this.getWeatherEmoji(currentWeather));

        await interaction.editReply({ embeds: [embed] });
      }

    } catch (error) {
      console.error('Weather command error:', error);
      await interaction.editReply('❌ Failed to check weather. Please try again.');
    }
  },

  // Handle challenges
  async handleChallenges(interaction) {
    const type = interaction.options.getString('challenge_type') || 'all';
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);
    
    // Ensure challenges are up to date
    fishingGame.checkDailyChallenges(userId);
    fishingGame.checkWeeklyChallenges(userId);
    
    const data = fishingGame.loadData();
    const challenges = data.challenges;
    
    await interaction.deferReply();

    try {
      const embed = new EmbedBuilder()
        .setTitle('🎯 Fishing Challenges')
        .setColor(0x4a90e2)
        .setFooter({
          text: `Challenges for ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      let challengeText = '';

      if (type === 'daily' || type === 'all') {
        embed.addFields({
          name: '📅 Daily Challenges',
          value: this.formatChallenges(challenges.daily, playerData.challenges.daily, 'daily'),
          inline: false
        });
      }

      if (type === 'weekly' || type === 'all') {
        embed.addFields({
          name: '📊 Weekly Challenges',
          value: this.formatChallenges(challenges.weekly, playerData.challenges.weekly, 'weekly'),
          inline: false
        });
      }

      // Add progress summary
      const dailyProgress = this.getChallengeProgress(challenges.daily, playerData.challenges.daily);
      const weeklyProgress = this.getChallengeProgress(challenges.weekly, playerData.challenges.weekly);
      
      embed.addFields({
        name: '📈 Progress Summary',
        value: `**Daily:** ${dailyProgress.completed}/${dailyProgress.total} completed\n**Weekly:** ${weeklyProgress.completed}/${weeklyProgress.total} completed`,
        inline: true
      });

      // Add refresh button
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('refresh_challenges')
            .setLabel('🔄 Refresh')
            .setStyle(ButtonStyle.Secondary)
        );

      await interaction.editReply({ embeds: [embed], components: [row] });

    } catch (error) {
      console.error('Challenges command error:', error);
      await interaction.editReply('❌ Failed to load challenges. Please try again.');
    }
  },

  // Handle achievements
  async handleAchievements(interaction) {
    const filter = interaction.options.getString('achievement_filter') || 'all';
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);
    
    // Check for new achievements
    const newAchievements = fishingGame.checkAchievements(userId);
    
    await interaction.deferReply();

    try {
      const data = fishingGame.loadData();
      const allAchievements = data.achievements;
      
      const embed = new EmbedBuilder()
        .setTitle('🏆 Fishing Achievements')
        .setColor(0xffd700)
        .setFooter({
          text: `${playerData.achievements.length}/${allAchievements.length} unlocked • ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      // Achievement progress
      const completedCount = playerData.achievements.length;
      const totalCount = allAchievements.length;
      const completionRate = Math.round((completedCount / totalCount) * 100);

      embed.setDescription(`**Achievement Progress:** ${completedCount}/${totalCount} (${completionRate}%)\n\n`);

      // Filter achievements
      let filteredAchievements = allAchievements;
      if (filter === 'completed') {
        filteredAchievements = allAchievements.filter(ach => playerData.achievements.includes(ach.id));
      } else if (filter === 'progress') {
        filteredAchievements = allAchievements.filter(ach => !playerData.achievements.includes(ach.id));
      }

      // Group achievements by category
      const categories = {
        '🎣 Basic': [],
        '🐟 Fishing': [],
        '💎 Rare': [],
        '👑 Legendary': [],
        '💰 Wealth': [],
        '⬆️ Progression': []
      };

      filteredAchievements.forEach(achievement => {
        const unlocked = playerData.achievements.includes(achievement.id);
        const status = unlocked ? '✅' : '⏳';
        
        let category = '🎣 Basic';
        if (achievement.type.includes('fish')) category = '🐟 Fishing';
        else if (achievement.type.includes('rare') || achievement.type.includes('legendary')) category = '💎 Rare';
        else if (achievement.type.includes('legendary')) category = '👑 Legendary';
        else if (achievement.type.includes('coin')) category = '💰 Wealth';
        else if (achievement.type.includes('level')) category = '⬆️ Progression';
        
        categories[category].push(`${status} ${achievement.emoji} **${achievement.name}**\n${achievement.description}\n*Reward: ${achievement.reward.coins} coins, ${achievement.reward.exp} XP*`);
      });

      // Add fields for each category
      Object.entries(categories).forEach(([categoryName, achievements]) => {
        if (achievements.length > 0) {
          embed.addFields({
            name: categoryName,
            value: achievements.join('\n\n'),
            inline: false
          });
        }
      });

      // New achievements notification
      if (newAchievements.length > 0) {
        const newAchText = newAchievements.map(ach => 
          `${ach.emoji} **${ach.name}**`
        ).join(', ');
        
        embed.addFields({
          name: '🎉 New Achievements Unlocked!',
          value: newAchText,
          inline: false
        });
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Achievements command error:', error);
      await interaction.editReply('❌ Failed to load achievements. Please try again.');
    }
  },

  // Handle minigame
  async handleMinigame(interaction) {
    const difficulty = interaction.options.getString('minigame_difficulty') || 'common';
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);
    
    await interaction.deferReply();

    try {
      // Check cooldown
      const now = Date.now();
      const cooldown = 30000; // 30 seconds
      
      if (now - playerData.lastMiniGame < cooldown) {
        const remaining = Math.ceil((cooldown - (now - playerData.lastMiniGame)) / 1000);
        return await interaction.editReply(`⏰ **Cooldown Active!** You must wait ${remaining} seconds before playing another mini-game.`);
      }

      // Play the mini-game
      const result = fishingGame.playMiniGame(userId, difficulty);
      
      const embed = new EmbedBuilder()
        .setTitle('🎮 Fishing Mini-Game')
        .setColor(result.success ? 0x00ff00 : 0xff0000)
        .setFooter({
          text: `Mini-game practice • ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      const difficultyNames = {
        common: '🐟 Easy (Common)',
        uncommon: '🐠 Medium (Uncommon)', 
        rare: '🦈 Hard (Rare)',
        legendary: '🐋 Expert (Legendary)',
        event: '🎏 Master (Event)'
      };

      embed.addFields({
        name: '🎯 Difficulty',
        value: difficultyNames[difficulty],
        inline: true
      });

      if (result.success) {
        embed.setDescription('🎉 **Success!** You caught the fish with a bonus!\n\n' + result.message);
        embed.addFields({
          name: '💎 Reward',
          value: `**${result.bonus.toFixed(1)}x** multiplier applied to your next catch!`,
          inline: true
        });
      } else {
        embed.setDescription('❌ **Failed!** The fish got away!\n\n' + result.message);
        embed.addFields({
          name: '📉 Penalty',
          value: `**${result.bonus.toFixed(1)}x** reduced catch rate for your next attempt.`,
          inline: true
        });
      }

      // Add practice stats
      const totalGames = playerData.stats.totalCasts || 0;
      embed.addFields({
        name: '📊 Your Stats',
        value: `Total casts: ${totalGames}\nKeep practicing to improve your skills!`,
        inline: false
      });

      // Add play again button
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`minigame_retry_${difficulty}`)
            .setLabel('🎮 Play Again')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('minigame_different')
            .setLabel('🔄 Different Difficulty')
            .setStyle(ButtonStyle.Secondary)
        );

      await interaction.editReply({ embeds: [embed], components: [row] });

    } catch (error) {
      console.error('Mini-game command error:', error);
      await interaction.editReply('❌ Failed to start mini-game. Please try again.');
    }
  },

  // Handle clear (admin only)
  async handleClear(interaction) {
    // Check if user is an administrator
    const isAdmin = interaction.member.permissions.has('Administrator') || 
                   interaction.user.id === process.env.ADMIN_USER_ID;
    
    if (!isAdmin) {
      return await interaction.reply({
        content: '❌ This command is restricted to administrators only.',
        flags: 64
      });
    }

    const confirmation = interaction.options.getString('confirm_clear');

    if (confirmation !== 'CONFIRM') {
      return await interaction.reply({
        content: '❌ You must type "CONFIRM" exactly to proceed with clearing all fishing data.',
        flags: 64
      });
    }

    await interaction.deferReply();

    try {
      const success = fishingGame.clearAllData();

      if (success) {
        const embed = new EmbedBuilder()
          .setTitle('🗑️ Fishing Data Cleared')
          .setDescription('✅ **All fishing game data has been successfully cleared and reset to defaults.**\n\n**What was reset:**\n• All player data (levels, coins, inventory, stats)\n• Shop and market data\n• Challenge and achievement progress\n• Tournament data\n• Weather settings\n\n**Note:** This action cannot be undone. All players will need to start fresh.')
          .setColor(0xff6b6b)
          .setFooter({
            text: `Cleared by ${interaction.user.username}`,
            iconURL: interaction.user.displayAvatarURL({ dynamic: true })
          })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply('❌ Failed to clear fishing data. Please check the console for errors.');
      }

    } catch (error) {
      console.error('Clear fishing data error:', error);
      await interaction.editReply('❌ An error occurred while clearing the fishing data.');
    }
  },

  getBaseCatchChance(location) {
    const chances = {
      river: 0.7,
      ocean: 0.6,
      mountain: 0.5,
      mystic: 0.4,
      lava: 0.3
    };
    return chances[location] || 0.5;
  },

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
  },

  getExpForRarity(rarity) {
    const expValues = {
      common: 5,
      uncommon: 10,
      rare: 25,
      legendary: 50,
      event: 75
    };
    return expValues[rarity] || 5;
  },

  getLocationName(location) {
    const names = {
      river: '🏞️ Tranquil River',
      ocean: '🌊 Vast Ocean',
      mountain: '🏔️ Mountain Lake',
      mystic: '🌌 Mystic Pond',
      lava: '🔥 Lava Lake'
    };
    return names[location] || 'Unknown Location';
  },

  // Utility methods for new handlers
  getWeatherColor(weather) {
    const colors = {
      sunny: 0xffd700,
      cloudy: 0x87ceeb,
      rainy: 0x4682b4,
      stormy: 0x2f4f4f,
      foggy: 0xd3d3d3
    };
    return colors[weather] || 0x808080;
  },

  getWeatherEmoji(weather) {
    const emojis = {
      sunny: '☀️',
      cloudy: '☁️',
      rainy: '🌧️',
      stormy: '⛈️',
      foggy: '🌫️'
    };
    return emojis[weather] || '🌤️';
  },

  formatChallenges(challenges, playerChallenges, type) {
    if (!challenges || challenges.length === 0) {
      return 'No challenges available.';
    }

    return challenges.map(challenge => {
      const playerChallenge = playerChallenges.find(pc => pc.id === challenge.id);
      const completed = playerChallenge && playerChallenge.completed;
      const progress = playerChallenge ? playerChallenge.progress : 0;
      const target = challenge.target;
      
      const status = completed ? '✅' : '⏳';
      const progressText = `${progress}/${target}`;
      
      return `${status} **${challenge.name}**\n${challenge.description}\n*Progress: ${progressText} • Reward: ${challenge.reward.coins} coins, ${challenge.reward.exp} XP*`;
    }).join('\n\n');
  },

  getChallengeProgress(challenges, playerChallenges) {
    const total = challenges.length;
    const completed = challenges.filter(challenge => {
      const playerChallenge = playerChallenges.find(pc => pc.id === challenge.id);
      return playerChallenge && playerChallenge.completed;
    }).length;
    
    return { total, completed };
  }
};
