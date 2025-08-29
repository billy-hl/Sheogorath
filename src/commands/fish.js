const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fish')
    .setDescription('🎣 Complete fishing game - all features accessible through buttons'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);

    const embed = new EmbedBuilder()
      .setTitle('🎣 Welcome to Fishing Paradise!')
      .setDescription(`**Ahoy, ${interaction.user.username}!**\n\nWelcome to the ultimate fishing experience! Choose what you'd like to do from the options below.\n\n**Your Stats:**\n• Level: ${playerData.level}\n• Coins: ${playerData.coins} 🪙\n• Total Fish: ${playerData.stats.totalFish || 0}`)
      .setColor(0x4a90e2)
      .setFooter({
        text: `Fishing Paradise • ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      })
      .setTimestamp();

    // Main action buttons - Row 1
    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('fish_cast')
          .setLabel('🎣 Cast Your Line')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('fish_shop')
          .setLabel('🛒 Shop & Equipment')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('fish_inventory')
          .setLabel('📦 Your Inventory')
          .setStyle(ButtonStyle.Secondary)
      );

    // Stats and challenges - Row 2
    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('fish_stats')
          .setLabel('📊 Statistics')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('fish_challenges')
          .setLabel('🎯 Challenges')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('fish_achievements')
          .setLabel('🏆 Achievements')
          .setStyle(ButtonStyle.Success)
      );

    // Mini-games and special features - Row 3
    const row3 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('fish_minigame')
          .setLabel('🎮 Mini-Game')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('fish_weather')
          .setLabel('🌤️ Weather')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('fish_help')
          .setLabel('❓ Help & Info')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.reply({ embeds: [embed], components: [row1, row2, row3] });
  }
};