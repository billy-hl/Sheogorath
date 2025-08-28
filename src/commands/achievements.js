const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('achievements')
    .setDescription('View your fishing achievements and progress')
    .addStringOption(option =>
      option.setName('filter')
        .setDescription('Filter achievements by status')
        .setRequired(false)
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Completed', value: 'completed' },
          { name: 'In Progress', value: 'progress' }
        )),

  async execute(interaction) {
    const filter = interaction.options.getString('filter') || 'all';
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
};
