const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Play a number guessing game with Sheogorath!')
    .addIntegerOption(option =>
      option.setName('max')
        .setDescription('Maximum number to guess (default: 100)')
        .setRequired(false)
        .setMinValue(10)
        .setMaxValue(1000)),

  async execute(interaction) {
    const maxNumber = interaction.options.getInteger('max') || 100;
    const targetNumber = Math.floor(Math.random() * maxNumber) + 1;

    const embed = new EmbedBuilder()
      .setTitle('🔢 Sheogorath\'s Guessing Game')
      .setColor(0x53FC18) // Kick green
      .setDescription(`**I've chosen a number between 1 and ${maxNumber}!**\n\nCan you guess what it is?`)
      .addFields({
        name: '🎯 How to Play',
        value: 'Use the buttons below to guess!\nI\'ll tell you if you\'re too high or too low.',
        inline: false
      });

    const row1 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`guess_25_${targetNumber}_${maxNumber}`)
          .setLabel('25')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`guess_50_${targetNumber}_${maxNumber}`)
          .setLabel('50')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`guess_75_${targetNumber}_${maxNumber}`)
          .setLabel('75')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`guess_100_${targetNumber}_${maxNumber}`)
          .setLabel('100')
          .setStyle(ButtonStyle.Secondary)
      );

    const row2 = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`guess_custom_${targetNumber}_${maxNumber}`)
          .setLabel('🎲 Custom Guess')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`guess_giveup_${targetNumber}_${maxNumber}`)
          .setLabel('😔 Give Up')
          .setStyle(ButtonStyle.Danger)
      );

    embed.setFooter({
      text: `Game started by ${interaction.user.username} • Guess wisely!`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

    await interaction.reply({
      embeds: [embed],
      components: [row1, row2]
    });
  },
};
