const { SlashCommandBuilder } = require('discord.js');

const SERIOUS_PROMPT = `You are a helpful, knowledgeable assistant. Answer accurately, concisely, and factually. No roleplay, no character, no whimsy. Provide direct, well-sourced answers. If you're unsure about something, say so.`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask a real question and get a straight answer (no Sheogorath persona)')
    .addStringOption(option =>
      option.setName('question')
        .setDescription('Your question')
        .setRequired(true)),
  async execute(interaction) {
    const { getAIResponse } = require('../ai/grok');
    const question = interaction.options.getString('question');
    await interaction.deferReply();

    try {
      const response = await getAIResponse(question, {
        rawSystemPrompt: SERIOUS_PROMPT,
        maxTokens: 1000,
      });

      if (!response || response.trim().length < 5) {
        throw new Error('Empty response from AI');
      }

      // Split if over 2000 chars (account for the question header)
      const header = `**Q:** ${question}\n\n`;
      const fullReply = header + response;

      if (fullReply.length <= 2000) {
        await interaction.editReply(fullReply);
      } else {
        const chunks = [];
        let remaining = fullReply;
        while (remaining.length > 0) {
          if (remaining.length <= 2000) {
            chunks.push(remaining);
            break;
          }
          let splitAt = remaining.lastIndexOf('\n', 2000);
          if (splitAt < 1000) splitAt = remaining.lastIndexOf(' ', 2000);
          if (splitAt < 1000) splitAt = 2000;
          chunks.push(remaining.slice(0, splitAt));
          remaining = remaining.slice(splitAt).trimStart();
        }
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      }
    } catch (err) {
      console.error('Ask command error:', err.message);
      await interaction.editReply(`Something went wrong: ${err.message}`);
    }
  },
};
