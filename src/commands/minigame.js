const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('minigame')
    .setDescription('Practice fishing mini-games to improve your catch rates')
    .addStringOption(option =>
      option.setName('difficulty')
        .setDescription('Mini-game difficulty')
        .setRequired(false)
        .addChoices(
          { name: 'Easy (Common Fish)', value: 'common' },
          { name: 'Medium (Uncommon Fish)', value: 'uncommon' },
          { name: 'Hard (Rare Fish)', value: 'rare' },
          { name: 'Expert (Legendary Fish)', value: 'legendary' },
          { name: 'Master (Event Fish)', value: 'event' }
        )),

  async execute(interaction) {
    const difficulty = interaction.options.getString('difficulty') || 'common';
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
};
