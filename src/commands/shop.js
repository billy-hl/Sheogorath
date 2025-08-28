const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Visit Sheogorath\'s Fishing Emporium!')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('What would you like to do?')
        .setRequired(true)
        .addChoices(
          { name: '🛒 Browse Shop', value: 'browse' },
          { name: '💰 Sell Fish', value: 'sell' },
          { name: '📊 Market Prices', value: 'prices' }
        )),

  async execute(interaction) {
    const action = interaction.options.getString('action');
    const userId = interaction.user.id;
    const allowedChannelId = '1410703437502353428';

    // Check if command is used in the correct channel
    if (interaction.channelId !== allowedChannelId) {
      return await interaction.reply({
        content: `❌ Fishing shop is only available in the designated fishing channel! Please use the fishing commands there.`,
        flags: 64
      });
    }

    const playerData = fishingGame.getPlayerData(userId);
    const shopData = fishingGame.loadData().shop;

    await interaction.deferReply();

    try {
      if (action === 'browse') {
        await this.showShopMenu(interaction, playerData, shopData);
      } else if (action === 'sell') {
        await this.showSellMenu(interaction, playerData);
      } else if (action === 'prices') {
        await this.showMarketPrices(interaction);
      }

    } catch (error) {
      console.error('Shop command error:', error);
      await interaction.editReply('❌ The shop seems to be having technical difficulties! Please try again.');
    }
  },

  async showShopMenu(interaction, playerData, shopData) {
    const embed = new EmbedBuilder()
      .setTitle('🛒 Sheogorath\'s Fishing Emporium')
      .setDescription(`*Welcome, ${interaction.user.username}! The Mad King has assembled the finest fishing equipment from across the realms!*\n\n**Your Coins:** ${playerData.coins} 🪙`)
      .setColor(0x53FC18)
      .addFields(
        {
          name: '🎣 Fishing Rods',
          value: this.formatShopItems(shopData.rods, playerData.equipment.rod),
          inline: false
        },
        {
          name: '🪱 Bait',
          value: this.formatShopItems(shopData.bait, playerData.equipment.bait),
          inline: false
        },
        {
          name: '🪝 Hooks',
          value: this.formatShopItems(shopData.hooks, playerData.equipment.hook),
          inline: false
        }
      )
      .setFooter({
        text: 'Use the menus below to purchase equipment!',
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    // Create select menus for each category
    const rodMenu = new StringSelectMenuBuilder()
      .setCustomId('shop_rods')
      .setPlaceholder('Choose a fishing rod...')
      .addOptions(
        Object.entries(shopData.rods).map(([key, item]) => ({
          label: item.name,
          description: `${item.cost} coins - ${item.description}`,
          value: `buy_rod_${key}`,
          emoji: playerData.equipment.rod === key ? '✅' : '🎣'
        }))
      );

    const baitMenu = new StringSelectMenuBuilder()
      .setCustomId('shop_bait')
      .setPlaceholder('Choose bait...')
      .addOptions(
        Object.entries(shopData.bait).map(([key, item]) => ({
          label: item.name,
          description: `${item.cost} coins - ${item.description}`,
          value: `buy_bait_${key}`,
          emoji: playerData.equipment.bait === key ? '✅' : '🪱'
        }))
      );

    const hookMenu = new StringSelectMenuBuilder()
      .setCustomId('shop_hooks')
      .setPlaceholder('Choose a hook...')
      .addOptions(
        Object.entries(shopData.hooks).map(([key, item]) => ({
          label: item.name,
          description: `${item.cost} coins - ${item.description}`,
          value: `buy_hook_${key}`,
          emoji: playerData.equipment.hook === key ? '✅' : '🪝'
        }))
      );

    const row1 = new ActionRowBuilder().addComponents(rodMenu);
    const row2 = new ActionRowBuilder().addComponents(baitMenu);
    const row3 = new ActionRowBuilder().addComponents(hookMenu);

    await interaction.editReply({
      embeds: [embed],
      components: [row1, row2, row3]
    });
  },

  async showSellMenu(interaction, playerData) {
    const inventory = playerData.inventory;
    const marketData = fishingGame.loadData().market;

    if (Object.keys(inventory).length === 0) {
      const embed = new EmbedBuilder()
        .setTitle('💰 Fish Market')
        .setDescription('*You have no fish to sell! Go fishing first, mortal!*')
        .setColor(0xff6b6b);

      return await interaction.editReply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setTitle('💰 Fish Market')
      .setDescription(`*The Mad King will buy your worthless fish... for a price!*\n\n**Your Inventory:**`)
      .setColor(0x53FC18);

    let totalValue = 0;
    const sellOptions = [];

    Object.entries(inventory).forEach(([fishName, quantity]) => {
      const fishInfo = marketData.fish_prices[fishName];
      if (fishInfo) {
        const value = fishInfo.basePrice * quantity;
        totalValue += value;

        embed.addFields({
          name: `${fishingGame.getRarityEmoji(fishInfo.rarity)} ${fishName.replace('_', ' ')} (x${quantity})`,
          value: `${value} coins (${fishInfo.basePrice} each)`,
          inline: true
        });

        sellOptions.push({
          label: `${fishName.replace('_', ' ')} (x${quantity})`,
          description: `Sell for ${value} coins`,
          value: `sell_${fishName}_${quantity}`,
          emoji: fishingGame.getRarityEmoji(fishInfo.rarity)
        });
      }
    });

    embed.addFields({
      name: '💵 Total Value',
      value: `${totalValue} coins`,
      inline: false
    });

    if (sellOptions.length > 0) {
      const sellMenu = new StringSelectMenuBuilder()
        .setCustomId('sell_fish')
        .setPlaceholder('Choose fish to sell...')
        .addOptions(sellOptions);

      const row = new ActionRowBuilder().addComponents(sellMenu);

      embed.setFooter({
        text: 'Select fish to sell them all!',
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

      await interaction.editReply({
        embeds: [embed],
        components: [row]
      });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
  },

  async showMarketPrices(interaction) {
    const marketData = fishingGame.loadData().market;

    const embed = new EmbedBuilder()
      .setTitle('📊 Fish Market Prices')
      .setDescription('*Current market values for your fishing endeavors!*')
      .setColor(0x53FC18);

    // Group fish by rarity
    const fishByRarity = {};
    Object.entries(marketData.fish_prices).forEach(([name, info]) => {
      if (!fishByRarity[info.rarity]) {
        fishByRarity[info.rarity] = [];
      }
      fishByRarity[info.rarity].push({ name, ...info });
    });

    // Add fields for each rarity
    Object.entries(fishByRarity).forEach(([rarity, fish]) => {
      const fishList = fish.map(f =>
        `${fishingGame.getRarityEmoji(f.rarity)} ${f.name.replace('_', ' ')}: ${f.basePrice} coins`
      ).join('\n');

      embed.addFields({
        name: `${this.getRarityDisplayName(rarity)} Fish`,
        value: fishList,
        inline: true
      });
    });

    embed.setFooter({
      text: 'Prices may vary based on fish size and market conditions',
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

    await interaction.editReply({ embeds: [embed] });
  },

  formatShopItems(items, equipped) {
    return Object.entries(items).map(([key, item]) => {
      const equippedMark = equipped === key ? ' ✅' : '';
      return `${item.name}: ${item.cost} coins${equippedMark}\n*${item.description}*`;
    }).join('\n\n');
  },

  getRarityDisplayName(rarity) {
    const names = {
      common: '🐟 Common',
      uncommon: '🐠 Uncommon',
      rare: '🦈 Rare',
      legendary: '🐋 Legendary',
      event: '🎏 Event'
    };
    return names[rarity] || rarity;
  }
};
