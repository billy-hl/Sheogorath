const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getAIResponse } = require('../ai/openai');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('story')
    .setDescription('Have Sheogorath tell you a story')
    .addStringOption(option =>
      option.setName('topic')
        .setDescription('Story topic or theme')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('length')
        .setDescription('Story length')
        .setRequired(false)
        .addChoices(
          { name: 'Short', value: 1 },
          { name: 'Medium', value: 2 },
          { name: 'Long', value: 3 }
        )),

  async execute(interaction) {
    const topic = interaction.options.getString('topic');
    const length = interaction.options.getInteger('length') || 2;

    await interaction.deferReply();

    try {
      const lengthMap = {
        1: 'short (2-3 paragraphs)',
        2: 'medium (4-5 paragraphs)',
        3: 'long (6-8 paragraphs)'
      };

      const prompt = topic
        ? `Tell a ${lengthMap[length]} story about "${topic}" in your typical Sheogorath style - chaotic, sarcastic, delusional, helpful, and threatening. Make it engaging and memorable.`
        : `Tell a ${lengthMap[length]} random story in your typical Sheogorath style - chaotic, sarcastic, delusional, helpful, and threatening. Make it engaging and memorable.`;

      const storyResponse = await getAIResponse(prompt);

      const embed = new EmbedBuilder()
        .setTitle('📖 Sheogorath\'s Tale')
        .setDescription(storyResponse)
        .setColor(0x53FC18) // Kick green
        .setFooter({
          text: `Story told by ${interaction.user.username} • The Mad King weaves his web...`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      // Add topic info if specified
      if (topic) {
        embed.addFields({
          name: '🎯 Theme',
          value: topic,
          inline: true
        });
      }

      embed.addFields({
        name: '📏 Length',
        value: lengthMap[length],
        inline: true
      });

      await interaction.editReply({ embeds: [embed] });

      // Try to react with story-related emojis
      try {
        const message = await interaction.fetchReply();
        await message.react('📖');
        await message.react('🎭');
      } catch (reactionError) {
        console.log('Could not add reactions - missing permissions');
      }

    } catch (error) {
      console.error('Story command error:', error);

      // Fallback to a static story
      const fallbackStories = [
        "Once upon a time in the Shivering Isles, there was a cheese that dreamed of becoming a wheel. But alas, it was just a wedge of disappointment. The end. *evil laughter*",
        "In the depths of Oblivion, a flame atronach fell in love with an ice atronach. Their relationship was... complicated. *wink*",
        "A mortal once asked me for the meaning of life. I told him it was 42. He looked so confused... mortals are adorable when they're confused!"
      ];

      const fallbackStory = fallbackStories[Math.floor(Math.random() * fallbackStories.length)];

      const embed = new EmbedBuilder()
        .setTitle('📖 Sheogorath\'s Quick Tale')
        .setDescription(fallbackStory)
        .setColor(0xff6b6b)
        .setFooter({
          text: `AI is napping, but I never do! • ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      try {
        const message = await interaction.fetchReply();
        await message.react('📖');
        await message.react('🤣');
      } catch (reactionError) {
        console.log('Could not add reactions - missing permissions');
      }
    }
  },
};
