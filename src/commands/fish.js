const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fishingGame = require('../services/fishing');
const { getAIResponse } = require('../ai/openai');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fish')
    .setDescription('Cast your line and try to catch some fish!')
    .addStringOption(option =>
      option.setName('location')
        .setDescription('Where do you want to fish?')
        .setRequired(false)
        .addChoices(
          { name: '🏞️ River', value: 'river' },
          { name: '🌊 Ocean', value: 'ocean' },
          { name: '🏔️ Mountain Lake', value: 'mountain' },
          { name: '🌌 Mystic Pond', value: 'mystic' },
          { name: '🔥 Lava Lake', value: 'lava' }
        )),

  async execute(interaction) {
    const location = interaction.options.getString('location') || 'river';
    const userId = interaction.user.id;
    const allowedChannelId = '1410703437502353428';

    // Check if command is used in the correct channel
    if (interaction.channelId !== allowedChannelId) {
      return await interaction.reply({
        content: `❌ Fishing is only allowed in the designated fishing channel! Please use the fishing commands there.`,
        ephemeral: true
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

      // Determine catch chance based on equipment and location
      let catchChance = this.getBaseCatchChance(location);
      catchChance *= this.getEquipmentModifier(playerData.equipment);

      // Special location bonuses
      const locationBonuses = {
        river: { common: 1.2, uncommon: 1.0, rare: 0.8, legendary: 0.5, event: 0.1 },
        ocean: { common: 0.8, uncommon: 1.2, rare: 1.0, legendary: 0.8, event: 0.2 },
        mountain: { common: 0.9, uncommon: 0.9, rare: 1.3, legendary: 1.0, event: 0.3 },
        mystic: { common: 0.5, uncommon: 0.8, rare: 1.2, legendary: 1.5, event: 0.5 },
        lava: { common: 0.3, uncommon: 0.5, rare: 1.0, legendary: 2.0, event: 1.0 }
      };

      const bonuses = locationBonuses[location];

      // Attempt to catch a fish
      const caughtFish = Math.random() < catchChance;
      let fish = null;
      let rarity = null;

      if (caughtFish) {
        // Determine rarity with location bonuses
        let rand = Math.random();
        if (rand < 0.6 * bonuses.common) rarity = 'common';
        else if (rand < 0.85 * bonuses.uncommon) rarity = 'uncommon';
        else if (rand < 0.95 * bonuses.rare) rarity = 'rare';
        else if (rand < 0.99 * bonuses.legendary) rarity = 'legendary';
        else rarity = 'event';

        fish = fishingGame.getRandomFish(rarity, playerData.equipment);

        if (fish) {
          // Add to inventory
          fishingGame.addToInventory(userId, fish.name, 1);

          // Update stats
          playerData.stats.totalCasts++;
          playerData.stats.totalFish++;
          if (rarity === 'rare' || rarity === 'legendary' || rarity === 'event') {
            playerData.stats.rareFish++;
          }
          if (fish.weight > playerData.stats.biggestCatch) {
            playerData.stats.biggestCatch = fish.weight;
          }

          // Add experience
          const expGain = this.getExpForRarity(rarity) + Math.floor(fish.weight);
          fishingGame.addExperience(userId, expGain);

          fishingGame.updatePlayerData(userId, {
            stats: playerData.stats,
            experience: playerData.experience,
            level: playerData.level
          });
        }
      } else {
        // Update cast count even for misses
        playerData.stats.totalCasts++;
        fishingGame.updatePlayerData(userId, { stats: playerData.stats });
      }

      // Create response embed
      const embed = new EmbedBuilder()
        .setTitle('🎣 Fishing Adventure')
        .setColor(fish ? fishingGame.getRarityColor(fish.rarity) : 0x666666)
        .setFooter({
          text: `Level ${playerData.level} Fisher • ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        });

      if (fish) {
        const emoji = fishingGame.getRarityEmoji(fish.rarity);
        embed.setDescription(`**${this.getLocationName(location)}**\n\n${emoji} **You caught a ${fish.name.replace('_', ' ')}!**\n\n**Weight:** ${fish.weight} lbs\n**Value:** ${fish.value} coins\n**Rarity:** ${fish.rarity.charAt(0).toUpperCase() + fish.rarity.slice(1)}`);

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

        // Special messages for rare catches (keep existing ones for non-legendary)
        if (fish.rarity === 'rare') {
          embed.addFields({
            name: '✨ Rare Find!',
            value: `*A fine catch indeed! The waters smile upon you today.*`,
            inline: false
          });
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
        embed.setDescription(`**${this.getLocationName(location)}**\n\n🎣 **No fish this time!**\n\n*The waters remain mysterious... try again!*`);
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
  }
};
