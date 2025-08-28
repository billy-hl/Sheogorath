const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Create a giveaway (Admin only)')
    .addStringOption(option =>
      option.setName('prize')
        .setDescription('What are you giving away?')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('duration')
        .setDescription('Duration in minutes')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('winners')
        .setDescription('Number of winners (default: 1)')
        .setRequired(false))
    .addRoleOption(option =>
      option.setName('required_role')
        .setDescription('Required role to participate (optional)')
        .setRequired(false)),

  async execute(interaction) {
    // Check if user has admin permissions
    if (!interaction.member.permissions.has('Administrator')) {
      return await interaction.reply({
        content: '❌ You need Administrator permissions to create giveaways!',
        ephemeral: true
      });
    }

    const prize = interaction.options.getString('prize');
    const duration = interaction.options.getInteger('duration');
    const winners = interaction.options.getInteger('winners') || 1;
    const requiredRole = interaction.options.getRole('required_role');

    const embed = new EmbedBuilder()
      .setTitle('🎉 GIVEAWAY!')
      .setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor((Date.now() + duration * 60 * 1000) / 1000)}:R>\n\nReact with 🎉 to enter!${requiredRole ? `\n\n**Required Role:** ${requiredRole}` : ''}`)
      .setColor(0xffd700)
      .setFooter({ text: `Hosted by ${interaction.user.username}` })
      .setTimestamp();

    const message = await interaction.reply({
      embeds: [embed],
      fetchReply: true
    });

    await message.react('🎉');

    // Store giveaway data (in a real implementation, you'd want to persist this)
    const giveawayData = {
      messageId: message.id,
      channelId: interaction.channel.id,
      hostId: interaction.user.id,
      prize,
      winners,
      endTime: Date.now() + duration * 60 * 1000,
      requiredRole: requiredRole?.id,
      participants: new Set()
    };

    // Set up giveaway end
    setTimeout(async () => {
      try {
        const updatedMessage = await message.fetch();
        const reaction = updatedMessage.reactions.cache.get('🎉');

        if (!reaction) return;

        const users = await reaction.users.fetch();
        const participants = users.filter(user => !user.bot);

        if (participants.size === 0) {
          await message.edit({
            embeds: [new EmbedBuilder()
              .setTitle('🎉 GIVEAWAY ENDED')
              .setDescription(`**Prize:** ${prize}\n\nNo valid participants!`)
              .setColor(0xff0000)]
          });
          return;
        }

        // Select winners
        const participantArray = Array.from(participants.values());
        const selectedWinners = [];
        for (let i = 0; i < Math.min(winners, participantArray.length); i++) {
          const winner = participantArray.splice(Math.floor(Math.random() * participantArray.length), 1)[0];
          selectedWinners.push(winner);
        }

        const winnerMentions = selectedWinners.map(w => w.toString()).join(', ');

        await message.edit({
          embeds: [new EmbedBuilder()
            .setTitle('🎉 GIVEAWAY ENDED!')
            .setDescription(`**Prize:** ${prize}\n**Winner(s):** ${winnerMentions}\n\nCongratulations! 🎊`)
            .setColor(0x00ff00)]
        });

        await message.reply(`🎉 Congratulations ${winnerMentions}! You won **${prize}**!`);

      } catch (error) {
        console.error('Error ending giveaway:', error);
      }
    }, duration * 60 * 1000);
  },
};
