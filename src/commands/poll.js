const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a poll for server members')
    .addStringOption(option =>
      option.setName('question')
        .setDescription('The poll question')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('option1')
        .setDescription('First option')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('option2')
        .setDescription('Second option')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('option3')
        .setDescription('Third option (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('option4')
        .setDescription('Fourth option (optional)')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('duration')
        .setDescription('Poll duration in minutes (default: 60)')
        .setRequired(false)),

  async execute(interaction) {
    const question = interaction.options.getString('question');
    const options = [
      interaction.options.getString('option1'),
      interaction.options.getString('option2'),
      interaction.options.getString('option3'),
      interaction.options.getString('option4')
    ].filter(Boolean);

    const duration = interaction.options.getInteger('duration') || 60;

    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

    const embed = new EmbedBuilder()
      .setTitle('📊 Poll')
      .setDescription(`**${question}**\n\n${options.map((opt, i) => `${emojis[i]} ${opt}`).join('\n')}`)
      .setColor(0x00ff00)
      .setFooter({ text: `Poll ends in ${duration} minutes • Created by ${interaction.user.username}` })
      .setTimestamp();

    const message = await interaction.reply({
      embeds: [embed],
      fetchReply: true
    });

    // Add reactions
    for (let i = 0; i < options.length; i++) {
      await message.react(emojis[i]);
    }

    // Set up auto-close
    setTimeout(async () => {
      try {
        const updatedMessage = await message.fetch();
        const results = emojis.slice(0, options.length).map((emoji, i) => {
          const reaction = updatedMessage.reactions.cache.get(emoji);
          return `${emojis[i]} ${options[i]}: ${reaction ? reaction.count - 1 : 0} votes`;
        });

        const resultEmbed = new EmbedBuilder()
          .setTitle('📊 Poll Results')
          .setDescription(`**${question}**\n\n${results.join('\n')}`)
          .setColor(0xffa500)
          .setFooter({ text: 'Poll ended' })
          .setTimestamp();

        await message.edit({ embeds: [resultEmbed] });
      } catch (error) {
        console.error('Error updating poll results:', error);
      }
    }, duration * 60 * 1000);
  },
};
