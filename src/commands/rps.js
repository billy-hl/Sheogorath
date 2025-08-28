const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Play Rock Paper Scissors with Sheogorath!')
    .addStringOption(option =>
      option.setName('choice')
        .setDescription('Your choice')
        .setRequired(true)
        .addChoices(
          { name: '🪨 Rock', value: 'rock' },
          { name: '📄 Paper', value: 'paper' },
          { name: '✂️ Scissors', value: 'scissors' }
        )),

  async execute(interaction) {
    const userChoice = interaction.options.getString('choice');
    const choices = ['rock', 'paper', 'scissors'];
    const sheogorathChoice = choices[Math.floor(Math.random() * choices.length)];

    const choiceEmojis = {
      rock: '🪨',
      paper: '📄',
      scissors: '✂️'
    };

    // Determine winner
    let result;
    let resultColor;
    let resultTitle;

    if (userChoice === sheogorathChoice) {
      result = 'tie';
      resultColor = 0xffa500; // Orange
      resultTitle = '🤝 It\'s a Tie!';
    } else if (
      (userChoice === 'rock' && sheogorathChoice === 'scissors') ||
      (userChoice === 'paper' && sheogorathChoice === 'rock') ||
      (userChoice === 'scissors' && sheogorathChoice === 'paper')
    ) {
      result = 'win';
      resultColor = 0x00ff00; // Green
      resultTitle = '🎉 You Win!';
    } else {
      result = 'lose';
      resultColor = 0xff0000; // Red
      resultTitle = '😈 Sheogorath Wins!';
    }

    const embed = new EmbedBuilder()
      .setTitle('✂️ Rock Paper Scissors')
      .setColor(resultColor)
      .setDescription('**The Mad King challenges you to a game of wits!**');

    embed.addFields(
      {
        name: `🤵 Your Choice`,
        value: `${choiceEmojis[userChoice]} ${userChoice.charAt(0).toUpperCase() + userChoice.slice(1)}`,
        inline: true
      },
      {
        name: `🤴 Sheogorath's Choice`,
        value: `${choiceEmojis[sheogorathChoice]} ${sheogorathChoice.charAt(0).toUpperCase() + sheogorathChoice.slice(1)}`,
        inline: true
      },
      {
        name: resultTitle,
        value: getResultMessage(result, userChoice, sheogorathChoice),
        inline: false
      }
    );

    embed.setFooter({
      text: `Played by ${interaction.user.username} • Best of luck next time!`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    });

    await interaction.reply({ embeds: [embed] });
  },
};

function getResultMessage(result, userChoice, sheogorathChoice) {
  const messages = {
    tie: [
      `*A tie! How utterly boring! Shall we try again, or shall we declare chaos the winner?*`,
      `*Stalemate! The universe refuses to choose a side. How delightful!*`,
      `*Neither wins! The game mocks us both. How perfectly chaotic!*`
    ],
    win: [
      `*You win! The student has become the master... for now.*`,
      `*Victory is yours! But remember, in the realm of madness, nothing is certain.*`,
      `*You bested me! How... unexpected. I approve of this turn of events!*`
    ],
    lose: [
      `*I win! As it should be! The Mad King reigns supreme!*`,
      `*Victory is mine! How could you doubt the outcome?*`,
      `*You lose! But don't despair - in madness, losing can be winning!*`
    ]
  };

  return messages[result][Math.floor(Math.random() * messages[result].length)];
}
