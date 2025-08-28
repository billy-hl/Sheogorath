const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Check your fishing inventory and stats!')
    .addStringOption(option =>
      option.setName('view')
        .setDescription('What to view')
        .setRequired(false)
        .addChoices(
          { name: '📦 Full Inventory', value: 'full' },
          { name: '🎣 Equipment', value: 'equipment' },
          { name: '🐟 Fish Collection', value: 'fish' },
          { name: '📊 Statistics', value: 'stats' }
        )),

  async execute(interaction) {
    const view = interaction.options.getString('view') || 'full';
    const userId = interaction.user.id;
    const allowedChannelId = '1410703437502353428';

    // Check if command is used in the correct channel
    if (interaction.channelId !== allowedChannelId) {
      return await interaction.reply({
        content: `❌ Fishing inventory is only available in the designated fishing channel! Please use the fishing commands there.`,
        ephemeral: true
      });
    }

    const playerData = fishingGame.getPlayerData(userId);
    const shopData = fishingGame.loadData().shop;

    await interaction.deferReply();

    try {
      const embed = new EmbedBuilder()
        .setTitle('🎒 Fishing Inventory')
        .setColor(0x53FC18)
        .setFooter({
          text: `Level ${playerData.level} Fisher • ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        });

      if (view === 'full' || view === 'equipment') {
        embed.addFields({
          name: '🎣 Current Equipment',
          value: this.formatEquipment(playerData.equipment, shopData),
          inline: false
        });
      }

      if (view === 'full' || view === 'fish') {
        const fishInventory = this.formatFishInventory(playerData.inventory);
        if (fishInventory) {
          embed.addFields({
            name: '🐟 Fish Collection',
            value: fishInventory,
            inline: false
          });
        } else {
          embed.addFields({
            name: '🐟 Fish Collection',
            value: '*No fish caught yet! Go fishing!*',
            inline: false
          });
        }
      }

      if (view === 'full' || view === 'stats') {
        embed.addFields({
          name: '📊 Fishing Statistics',
          value: this.formatStats(playerData.stats, playerData),
          inline: false
        });
      }

      // Add player info
      embed.setDescription(`**Level ${playerData.level}** • **${playerData.experience} XP** • **${playerData.coins} Coins** 🪙`);

      // Add progress to next level
      const expForNextLevel = (playerData.level) * (playerData.level) * 100;
      const expForCurrentLevel = (playerData.level - 1) * (playerData.level - 1) * 100;
      const progress = playerData.experience - expForCurrentLevel;
      const needed = expForNextLevel - expForCurrentLevel;

      if (progress > 0 && needed > 0) {
        const progressBar = this.createProgressBar(progress, needed, 10);
        embed.addFields({
          name: '⬆️ Level Progress',
          value: `${progressBar} ${progress}/${needed} XP to level ${playerData.level + 1}`,
          inline: false
        });
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Inventory command error:', error);
      await interaction.editReply('❌ Failed to load your inventory! Please try again.');
    }
  },

  formatEquipment(equipment, shopData) {
    const rod = shopData.rods[equipment.rod];
    const bait = shopData.bait[equipment.bait];
    const hook = shopData.hooks[equipment.hook];

    return `**🎣 Rod:** ${rod.name}\n*${rod.description}*\n\n**🪱 Bait:** ${bait.name}\n*${bait.description}*\n\n**🪝 Hook:** ${hook.name}\n*${hook.description}*`;
  },

  formatFishInventory(inventory) {
    if (Object.keys(inventory).length === 0) return null;

    const marketData = fishingGame.loadData().market;
    const fishEntries = Object.entries(inventory)
      .map(([fishName, quantity]) => {
        const fishInfo = marketData.fish_prices[fishName];
        if (fishInfo) {
          const emoji = fishingGame.getRarityEmoji(fishInfo.rarity);
          const totalValue = fishInfo.basePrice * quantity;
          return `${emoji} ${fishName.replace('_', ' ')}: ${quantity} (${totalValue} coins)`;
        }
        return null;
      })
      .filter(entry => entry !== null);

    return fishEntries.join('\n');
  },

  formatStats(stats, playerData) {
    const totalValue = Object.entries(playerData.inventory).reduce((sum, [fishName, quantity]) => {
      const fishInfo = fishingGame.loadData().market.fish_prices[fishName];
      return sum + (fishInfo ? fishInfo.basePrice * quantity : 0);
    }, 0);

    return `**🎯 Total Casts:** ${stats.totalCasts}\n` +
           `**🐟 Fish Caught:** ${stats.totalFish}\n` +
           `**💎 Rare Fish:** ${stats.rareFish}\n` +
           `**🏆 Biggest Catch:** ${stats.biggestCatch} lbs\n` +
           `**💰 Inventory Value:** ${totalValue} coins\n` +
           `**💵 Total Coins Earned:** ${stats.totalCoins}`;
  },

  createProgressBar(current, max, length = 10) {
    const percentage = current / max;
    const filled = Math.round(percentage * length);
    const empty = length - filled;

    const filledChar = '█';
    const emptyChar = '░';

    return filledChar.repeat(filled) + emptyChar.repeat(empty);
  }
};
