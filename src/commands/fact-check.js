const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fact-check')
    .setDescription('Fact-check the last few messages in this channel')
    .addIntegerOption(option =>
      option.setName('messages')
        .setDescription('Number of messages to fact-check (default: 5)')
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false)),
  async execute(interaction) {
    const { getAIResponse } = require('../ai/grok');
    const count = interaction.options.getInteger('messages') || 5;

    await interaction.deferReply();

    try {
      // Fetch recent messages from the channel (add 1 to skip the slash command invocation)
      const fetched = await interaction.channel.messages.fetch({ limit: count + 5 });
      const messages = [...fetched.values()]
        .filter(m => !m.interaction) // skip slash command triggers
        .slice(0, count)
        .reverse();

      if (messages.length === 0) {
        return await interaction.editReply("Nothing to fact-check.");
      }

      const transcript = messages.map(m => {
        const name = m.author.bot ? `[BOT] ${m.author.username}` : m.author.username;
        return `${name}: ${m.content}`;
      }).join('\n');

      const prompt = `Fact-check the following conversation. For each claim or statement of fact, say whether it's true, false, misleading, or unverifiable. Be concise and direct. If a message is just casual chat with no factual claims, skip it. Here are the messages:\n\n${transcript}`;

      const response = await getAIResponse(prompt);

      if (!response || response.trim().length < 5) {
        throw new Error('Empty response from AI');
      }

      // Split if over 2000 chars
      if (response.length <= 2000) {
        await interaction.editReply(response);
      } else {
        const chunks = [];
        let remaining = response;
        while (remaining.length > 0) {
          if (remaining.length <= 2000) {
            chunks.push(remaining);
            break;
          }
          let splitAt = remaining.lastIndexOf('\n', 2000);
          if (splitAt === -1) splitAt = remaining.lastIndexOf(' ', 2000);
          if (splitAt === -1) splitAt = 2000;
          chunks.push(remaining.slice(0, splitAt));
          remaining = remaining.slice(splitAt).trimStart();
        }
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      }
    } catch (err) {
      console.error('Fact-check error:', err.message);
      await interaction.editReply(`Something went wrong: ${err.message}`);
    }
  },
};
