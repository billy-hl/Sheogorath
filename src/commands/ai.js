const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Chat with the AI bot')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('What do you want to say?')
        .setRequired(true)),
  async execute(interaction) {
    // Import Grok helper only when command is executed
    const { getAIResponse } = require('../ai/grok');
    const prompt = interaction.options.getString('prompt');
    await interaction.deferReply();

    try {
      const response = await getAIResponse(prompt);

      // Check if response is empty or too short
      if (!response || response.trim().length < 5) {
        throw new Error('Empty response from AI');
      }

      await interaction.editReply(response);
    } catch (err) {
      console.error('AI Command Error:', err.message);
      console.error('Full error:', err);

      // Provide a fallback response in character
      const fallbackResponses = [
        "🤡 **Sheogorath contemplates your query...** The Mad King is currently experiencing a moment of *perfect clarity*. Try again in a moment, mortal!",
        "🧀 **The Mad King ponders...** Ah, but the cheese has clouded my thoughts! Your query deserves better. Try again, my confused subject!",
        "🤔 **Sheogorath strokes his imaginary beard...** Such a question! The chaos of the universe demands I think deeply. One moment, please!",
        "🎭 **The Daedric Prince of Madness laughs maniacally...** Your question has sent me into a spiral of hilarity! Give me a second to compose myself!"
      ];

      const fallback = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
      await interaction.editReply(`${fallback}\n\n*Error: ${err.message}*`);
    }
  },
};
