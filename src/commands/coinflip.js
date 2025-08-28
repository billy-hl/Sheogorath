const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Flip a coin - let fate decide!')
    .addStringOption(option =>
      option.setName('choice')
        .setDescription('Your prediction (heads/tails)')
        .setRequired(false)
        .addChoices(
          { name: 'Heads', value: 'heads' },
          { name: 'Tails', value: 'tails' }
        )),

  async execute(interaction) {
    const userChoice = interaction.options.getString('choice');
    const result = Math.random() < 0.5 ? 'heads' : 'tails';

    const embed = new EmbedBuilder()
      .setTitle('🪙 Sheogorath\'s Coin Flip')
      .setColor(0x53FC18) // Kick green
      .setDescription('**The Mad King flips a coin into the air!**');

    // Add some dramatic flair
    embed.addFields({
      name: '🎭 The Result',
      value: `**${result.toUpperCase()}!**`,
      inline: true
    });

    if (userChoice) {
      const won = userChoice.toLowerCase() === result;
      embed.addFields({
        name: won ? '🎉 You Win!' : '😈 You Lose!',
        value: won
          ? `*${userChoice === 'heads' ? 'Heads' : 'Tails'} it is! The coin favors you this time...*`
          : `*${userChoice === 'heads' ? 'Tails' : 'Heads'}! How utterly disappointing!*`,
        inline: true
      });
    }

    // Sheogorath's commentary
    const commentaries = {
      heads: [
        '*"Heads! The side with the face! Or is it tails? Who can tell?"*',
        '*"Heads! The coin has chosen the noble path... or has it?"*',
        '*"Heads! A perfectly reasonable outcome, if you ask me!"*'
      ],
      tails: [
        '*"Tails! The mysterious side! What secrets does it hold?"*',
        '*"Tails! The coin has spoken! Or has it merely whispered?"*',
        '*"Tails! A most chaotic result! I approve!"*'
      ]
    };

    const randomCommentary = commentaries[result][Math.floor(Math.random() * commentaries[result].length)];
    embed.addFields({
      name: 'Sheogorath Says',
      value: randomCommentary,
      inline: false
    });

    embed.setFooter({
      text: `Flipped by ${interaction.user.username} • Fate is but a coin toss!`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

    await interaction.reply({ embeds: [embed] });
  },
};
