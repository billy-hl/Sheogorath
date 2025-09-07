const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getAIResponse } = require('../ai/grok');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('advice')
    .setDescription('Get chaotic advice from Sheogorath')
    .addStringOption(option =>
      option.setName('topic')
        .setDescription('What do you need advice about?')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('serious')
        .setDescription('Make it somewhat serious? (default: chaotic)')
        .setRequired(false)),

  async execute(interaction) {
    const topic = interaction.options.getString('topic');
    const serious = interaction.options.getBoolean('serious') || false;

    await interaction.deferReply();

    try {
      const prompt = serious
        ? `Give advice about "${topic}" in Sheogorath's style - be somewhat helpful but still maintain your chaotic, sarcastic personality. Mix wisdom with madness.`
        : `Give completely chaotic, sarcastic, delusional, and threatening advice about "${topic}" in your typical Sheogorath style. Make it memorable and entertaining.`;

      const adviceResponse = await getAIResponse(prompt);

      const embed = new EmbedBuilder()
        .setTitle(serious ? '🎭 Sheogorath\'s Wisdom' : '🤡 Sheogorath\'s "Advice"')
        .setDescription(adviceResponse)
        .setColor(serious ? 0x4a90e2 : 0x53FC18) // Blue for serious, green for chaotic
        .setFooter({
          text: `Advice for ${interaction.user.username} • Take it or leave it, mortal!`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      embed.addFields({
        name: '❓ Question',
        value: topic,
        inline: false
      });

      if (serious) {
        embed.addFields({
          name: '📝 Mode',
          value: 'Somewhat Serious',
          inline: true
        });
      } else {
        embed.addFields({
          name: '🎪 Mode',
          value: 'Pure Chaos',
          inline: true
        });
      }

      await interaction.editReply({ embeds: [embed] });

      // Try to react with advice-related emojis
      try {
        const message = await interaction.fetchReply();
        await message.react(serious ? '🤔' : '🤡');
        await message.react('💡');
      } catch (reactionError) {
        console.log('Could not add reactions - missing permissions');
      }

    } catch (error) {
      console.error('Advice command error:', error);

      // Fallback advice
      const fallbackAdvice = serious
        ? `About "${topic}"? Well, sometimes the most serious answer is to embrace the chaos. But if you must be serious... trust your instincts, but not too much. *sage nod*`
        : `Ah, "${topic}"! My advice? Do the opposite of what anyone sane would tell you. Dance with danger, laugh at logic, and remember: the cheese is always the answer! *maniacal laughter*`;

      const embed = new EmbedBuilder()
        .setTitle('🎭 Sheogorath\'s Backup Advice')
        .setDescription(fallbackAdvice)
        .setColor(0xff6b6b)
        .setFooter({
          text: `AI is confused, but I never am! • ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      try {
        const message = await interaction.fetchReply();
        await message.react('🤷');
        await message.react('💡');
      } catch (reactionError) {
        console.log('Could not add reactions - missing permissions');
      }
    }
  },
};
