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
    // Import OpenAI and helper only when command is executed
    const { getAIResponse } = require('../ai/openai');
    const prompt = interaction.options.getString('prompt');
    await interaction.deferReply();
    try {
      const response = await getAIResponse(prompt);
      await interaction.editReply(response);
    } catch (err) {
      await interaction.editReply('Error getting AI response.');
    }
  },
};
