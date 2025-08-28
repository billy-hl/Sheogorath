const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('challenges')
    .setDescription('View your daily and weekly fishing challenges')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of challenges to view')
        .setRequired(false)
        .addChoices(
          { name: 'Daily', value: 'daily' },
          { name: 'Weekly', value: 'weekly' },
          { name: 'All', value: 'all' }
        )),

  async execute(interaction) {
    const type = interaction.options.getString('type') || 'all';
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

  formatChallenges(challenges, playerProgress, type) {
    if (challenges.length === 0) {
      return '*No challenges available*';
    }

    return challenges.map(challenge => {
      const progress = playerProgress[challenge.id];
      const completed = progress && progress.completed;
      const currentProgress = progress ? progress.progress || 0 : 0;
      
      const status = completed ? '✅' : '⏳';
      const progressText = `${currentProgress}/${challenge.target}`;
      
      return `${status} ${challenge.emoji} **${challenge.name}**\n${challenge.description}\n*Progress: ${progressText} • Reward: ${challenge.reward.coins} coins, ${challenge.reward.exp} XP*`;
    }).join('\n\n');
  },

  getChallengeProgress(challenges, playerProgress) {
    const total = challenges.length;
    const completed = challenges.filter(challenge => 
      playerProgress[challenge.id] && playerProgress[challenge.id].completed
    ).length;
    
    return { total, completed };
  }
};
