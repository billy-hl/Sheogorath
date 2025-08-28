const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the fishing leaderboard!')
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Leaderboard category')
        .setRequired(false)
        .addChoices(
          { name: '🎣 Total Fish Caught', value: 'fish' },
          { name: '💎 Rare Fish', value: 'rare' },
          { name: '🏆 Biggest Catch', value: 'biggest' },
          { name: '⬆️ Highest Level', value: 'level' },
          { name: '💰 Total Coins Earned', value: 'coins' }
        )),

  async execute(interaction) {
    const category = interaction.options.getString('category') || 'fish';
    const data = fishingGame.loadData();

    await interaction.deferReply();

    try {
      // Get all players with fishing data
      const players = Object.entries(data.players)
        .filter(([_, playerData]) => playerData.stats && playerData.stats.totalFish > 0)
        .map(([userId, playerData]) => ({
          userId,
          ...playerData
        }));

      if (players.length === 0) {
        const embed = new EmbedBuilder()
          .setTitle('🏆 Fishing Leaderboard')
          .setDescription('*No fishermen have cast their lines yet! Be the first to start fishing!*')
          .setColor(0x53FC18);

        return await interaction.editReply({ embeds: [embed] });
      }

      // Sort players based on category
      let sortedPlayers;
      let categoryName;
      let valueFormatter;

      switch (category) {
        case 'fish':
          sortedPlayers = players.sort((a, b) => b.stats.totalFish - a.stats.totalFish);
          categoryName = 'Total Fish Caught';
          valueFormatter = (stats) => `${stats.totalFish} fish`;
          break;
        case 'rare':
          sortedPlayers = players.sort((a, b) => b.stats.rareFish - a.stats.rareFish);
          categoryName = 'Rare Fish Caught';
          valueFormatter = (stats) => `${stats.rareFish} rare fish`;
          break;
        case 'biggest':
          sortedPlayers = players.sort((a, b) => b.stats.biggestCatch - a.stats.biggestCatch);
          categoryName = 'Biggest Catch';
          valueFormatter = (stats) => `${stats.biggestCatch} lbs`;
          break;
        case 'level':
          sortedPlayers = players.sort((a, b) => b.level - a.level);
          categoryName = 'Highest Level';
          valueFormatter = (player) => `Level ${player.level} (${player.experience} XP)`;
          break;
        case 'coins':
          sortedPlayers = players.sort((a, b) => b.stats.totalCoins - a.stats.totalCoins);
          categoryName = 'Total Coins Earned';
          valueFormatter = (stats) => `${stats.totalCoins} coins`;
          break;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Fishing Leaderboard - ${categoryName}`)
        .setColor(0x53FC18)
        .setDescription('*The finest fishermen in the realm!*');

      // Show top 10 players
      const topPlayers = sortedPlayers.slice(0, 10);
      let leaderboardText = '';

      for (let i = 0; i < topPlayers.length; i++) {
        const player = topPlayers[i];
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
        const value = valueFormatter(category === 'level' ? player : player.stats);

        // Try to get username (this is a simplified approach)
        const username = `<@${player.userId}>`;

        leaderboardText += `${medal} ${username} - ${value}\n`;
      }

      embed.addFields({
        name: '🎯 Top Fishermen',
        value: leaderboardText || '*No data available*',
        inline: false
      });

      // Add current user's rank if they're in the top 10
      const currentUserIndex = sortedPlayers.findIndex(p => p.userId === interaction.user.id);
      if (currentUserIndex >= 0 && currentUserIndex < 10) {
        const currentPlayer = sortedPlayers[currentUserIndex];
        const value = valueFormatter(category === 'level' ? currentPlayer : currentPlayer.stats);

        embed.addFields({
          name: '📍 Your Rank',
          value: `**#${currentUserIndex + 1}** - ${value}`,
          inline: false
        });
      }

      embed.setFooter({
        text: `Total fishermen: ${players.length} • Use /leaderboard to see other categories`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Leaderboard command error:', error);
      await interaction.editReply('❌ Failed to load the leaderboard! Please try again.');
    }
  },
};
