const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tournament')
    .setDescription('Join or view fishing tournaments')
    .addSubcommand(subcommand =>
      subcommand
        .setName('join')
        .setDescription('Join the current tournament'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('View tournament status'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('leaderboard')
        .setDescription('View tournament leaderboard'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Create a new tournament (admin only)')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Tournament name')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('duration')
            .setDescription('Duration in hours')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('entry_fee')
            .setDescription('Entry fee in coins')
            .setRequired(false))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    
    await interaction.deferReply();

    try {
      switch (subcommand) {
        case 'join':
          await this.handleJoin(interaction);
          break;
        case 'status':
          await this.handleStatus(interaction);
          break;
        case 'leaderboard':
          await this.handleLeaderboard(interaction);
          break;
        case 'create':
          await this.handleCreate(interaction);
          break;
      }
    } catch (error) {
      console.error('Tournament command error:', error);
      await interaction.editReply('❌ Tournament command failed. Please try again.');
    }
  },

  async handleJoin(interaction) {
    const userId = interaction.user.id;
    const playerData = fishingGame.getPlayerData(userId);
    const data = fishingGame.loadData();
    
    // Check if there's an active tournament
    const activeTournament = Object.values(data.tournaments || {}).find(t => t.active);
    
    if (!activeTournament) {
      return await interaction.editReply('❌ No active tournament available. Check back later!');
    }

    // Check if player already joined
    if (activeTournament.participants && activeTournament.participants.includes(userId)) {
      return await interaction.editReply('❌ You are already participating in this tournament!');
    }

    // Check entry fee
    const entryFee = activeTournament.entryFee || 0;
    if (playerData.coins < entryFee) {
      return await interaction.editReply(`❌ Insufficient coins! Entry fee is ${entryFee} coins, but you only have ${playerData.coins}.`);
    }

    // Deduct entry fee
    if (entryFee > 0) {
      playerData.coins -= entryFee;
      fishingGame.updatePlayerData(userId, { coins: playerData.coins });
    }

    // Add to tournament
    if (!activeTournament.participants) activeTournament.participants = [];
    activeTournament.participants.push(userId);
    
    if (!activeTournament.scores) activeTournament.scores = {};
    activeTournament.scores[userId] = {
      totalFish: 0,
      totalWeight: 0,
      rareFish: 0,
      legendaryFish: 0,
      score: 0
    };

    // Save tournament data
    data.tournaments[activeTournament.id] = activeTournament;
    fishingGame.saveData(data);

    const embed = new EmbedBuilder()
      .setTitle('🎣 Tournament Joined!')
      .setDescription(`**Welcome to ${activeTournament.name}!**\n\nYou have successfully joined the tournament.`)
      .setColor(0x00ff00)
      .addFields(
        {
          name: '⏰ Ends',
          value: `<t:${Math.floor(activeTournament.endTime / 1000)}:R>`,
          inline: true
        },
        {
          name: '👥 Participants',
          value: `${activeTournament.participants.length}`,
          inline: true
        }
      )
      .setFooter({
        text: `Good luck, ${interaction.user.username}!`,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true })
      });

    if (entryFee > 0) {
      embed.addFields({
        name: '💰 Entry Fee Paid',
        value: `${entryFee} coins`,
        inline: true
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },

  async handleStatus(interaction) {
    const data = fishingGame.loadData();
    const activeTournament = Object.values(data.tournaments || {}).find(t => t.active);
    
    if (!activeTournament) {
      const embed = new EmbedBuilder()
        .setTitle('🏆 Tournament Status')
        .setDescription('No active tournament at the moment.')
        .setColor(0x666666)
        .addFields({
          name: '📅 Next Tournament',
          value: 'Check back later for new tournaments!',
          inline: false
        });
      
      return await interaction.editReply({ embeds: [embed] });
    }

    const timeLeft = Math.max(0, activeTournament.endTime - Date.now());
    const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
    const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${activeTournament.name}`)
      .setDescription(activeTournament.description || 'A fishing tournament!')
      .setColor(0xffd700)
      .addFields(
        {
          name: '⏰ Time Remaining',
          value: `${hoursLeft}h ${minutesLeft}m`,
          inline: true
        },
        {
          name: '👥 Participants',
          value: `${activeTournament.participants?.length || 0}`,
          inline: true
        },
        {
          name: '💰 Entry Fee',
          value: `${activeTournament.entryFee || 0} coins`,
          inline: true
        }
      );

    // Show player's status if participating
    const userId = interaction.user.id;
    if (activeTournament.participants?.includes(userId)) {
      const playerScore = activeTournament.scores?.[userId];
      if (playerScore) {
        embed.addFields({
          name: '📊 Your Progress',
          value: `Fish: ${playerScore.totalFish} | Weight: ${playerScore.totalWeight}lbs | Score: ${playerScore.score}`,
          inline: false
        });
      }
    } else {
      embed.addFields({
        name: '🎯 Join Now!',
        value: 'Use `/tournament join` to participate!',
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },

  async handleLeaderboard(interaction) {
    const data = fishingGame.loadData();
    const activeTournament = Object.values(data.tournaments || {}).find(t => t.active);
    
    if (!activeTournament || !activeTournament.scores) {
      return await interaction.editReply('❌ No active tournament or no scores available.');
    }

    // Sort participants by score
    const leaderboard = Object.entries(activeTournament.scores)
      .sort(([,a], [,b]) => b.score - a.score)
      .slice(0, 10); // Top 10

    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${activeTournament.name} - Leaderboard`)
      .setColor(0xffd700)
      .setTimestamp();

    if (leaderboard.length === 0) {
      embed.setDescription('No scores recorded yet.');
    } else {
      const leaderboardText = await Promise.all(
        leaderboard.map(async ([userId, score], index) => {
          const user = await interaction.client.users.fetch(userId).catch(() => null);
          const username = user ? user.username : 'Unknown User';
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
          
          return `${medal} ${username} - ${score.score} points\n   └ Fish: ${score.totalFish}, Weight: ${score.totalWeight}lbs`;
        })
      );
      
      embed.setDescription(leaderboardText.join('\n\n'));
    }

    await interaction.editReply({ embeds: [embed] });
  },

  async handleCreate(interaction) {
    // Admin check
    const isAdmin = interaction.member.permissions.has('Administrator') || 
                   interaction.user.id === process.env.ADMIN_USER_ID;
    
    if (!isAdmin) {
      return await interaction.editReply('❌ Only administrators can create tournaments!');
    }

    const name = interaction.options.getString('name');
    const duration = interaction.options.getInteger('duration');
    const entryFee = interaction.options.getInteger('entry_fee') || 0;

    const data = fishingGame.loadData();
    if (!data.tournaments) data.tournaments = {};

    // End any active tournament
    Object.values(data.tournaments).forEach(t => t.active = false);

    // Create new tournament
    const tournamentId = `tournament_${Date.now()}`;
    const endTime = Date.now() + (duration * 60 * 60 * 1000);

    data.tournaments[tournamentId] = {
      id: tournamentId,
      name: name,
      description: `A ${duration}-hour fishing tournament!`,
      entryFee: entryFee,
      startTime: Date.now(),
      endTime: endTime,
      active: true,
      participants: [],
      scores: {}
    };

    fishingGame.saveData(data);

    const embed = new EmbedBuilder()
      .setTitle('🏆 Tournament Created!')
      .setDescription(`**${name}** has been created and is now active!`)
      .setColor(0x00ff00)
      .addFields(
        {
          name: '⏰ Duration',
          value: `${duration} hours`,
          inline: true
        },
        {
          name: '💰 Entry Fee',
          value: `${entryFee} coins`,
          inline: true
        },
        {
          name: '🏁 Ends',
          value: `<t:${Math.floor(endTime / 1000)}:F>`,
          inline: false
        }
      );

    await interaction.editReply({ embeds: [embed] });
  }
};
