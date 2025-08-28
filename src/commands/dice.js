const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Roll dice with Sheogorath\'s chaotic luck!')
    .addIntegerOption(option =>
      option.setName('sides')
        .setDescription('Number of sides on the die (default: 6)')
        .setRequired(false)
        .setMinValue(2)
        .setMaxValue(100))
    .addIntegerOption(option =>
      option.setName('count')
        .setDescription('Number of dice to roll (default: 1)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10)),

  async execute(interaction) {
    const sides = interaction.options.getInteger('sides') || 6;
    const count = interaction.options.getInteger('count') || 1;

    const results = [];
    let total = 0;

    for (let i = 0; i < count; i++) {
      const roll = Math.floor(Math.random() * sides) + 1;
      results.push(roll);
      total += roll;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎲 Sheogorath\'s Dice Rolling')
      .setColor(0x53FC18) // Kick green
      .setDescription(`**The Mad King rolls ${count} d${sides}${count > 1 ? 's' : ''}!**`);

    if (count === 1) {
      embed.addFields({
        name: 'Result',
        value: `**${results[0]}**`,
        inline: true
      });
    } else {
      embed.addFields(
        { name: 'Individual Rolls', value: results.join(', '), inline: true },
        { name: 'Total', value: `**${total}**`, inline: true }
      );
    }

    // Add some chaotic commentary based on the result
    let commentary = '';
    if (sides === 6 && count === 1) {
      if (results[0] === 1) commentary = '*"A one? How utterly predictable! The universe mocks you!"*';
      else if (results[0] === 6) commentary = '*"Six! The number of perfection! Or is it the number of chaos? Who knows!"*';
      else if (results[0] === 4) commentary = '*"Four... the number of... something. I forget what."*';
    } else if (total === sides * count) {
      commentary = '*"Perfect roll! The gods smile upon you... or do they?"*';
    } else if (total === count) {
      commentary = '*"Oh dear, oh dear! The worst possible outcome! How delightful!"*';
    }

    if (commentary) {
      embed.addFields({ name: 'Sheogorath Says', value: commentary, inline: false });
    }

    embed.setFooter({
      text: `Rolled by ${interaction.user.username} • Chaos reigns!`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

    await interaction.reply({ embeds: [embed] });
  },
};
