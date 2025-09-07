const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getAIResponse } = require('../ai/grok');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('joke')
    .setDescription('Have Sheogorath tell you a joke!')
    .addStringOption(option =>
      option.setName('topic')
        .setDescription('Optional topic for the joke (leave empty for random)')
        .setRequired(false)),

  async execute(interaction) {
    const topic = interaction.options.getString('topic');

    await interaction.deferReply();

    try {
      // Create a prompt that fits Sheogorath's personality
      const prompt = topic
        ? `Tell me a joke about ${topic}. Make it funny, sarcastic, and in your typical Sheogorath style - evil, threatening, delusional, helpful, and friendly.`
        : `Tell me a random joke in your typical Sheogorath style - sarcastic, evil, threatening, delusional, helpful, and friendly.`;

      const jokeResponse = await getAIResponse(prompt);

      const embed = new EmbedBuilder()
        .setTitle('😂 Sheogorath\'s Joke')
        .setDescription(jokeResponse)
        .setColor(0x53FC18) // Kick green to match theme
        .setFooter({
          text: `Requested by ${interaction.user.username} • Stay mad, mortal!`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      // Add topic info if specified
      if (topic) {
        embed.addFields({
          name: '🎯 Topic',
          value: topic,
          inline: true
        });
      }

      await interaction.editReply({ embeds: [embed] });

      // Try to react with laughing emojis (ignore if no permission)
      try {
        const message = await interaction.fetchReply();
        await message.react('😂');
        await message.react('🤣');
      } catch (reactionError) {
        // Silently ignore reaction permission errors
        console.log('Could not add reactions - missing permissions');
      }

    } catch (error) {
      console.error('Joke command error:', error);

      // Fallback to a static joke if AI fails
      const fallbackJokes = [
        "Why don't scientists trust atoms? Because they make up everything! *evil laughter*",
        "I told my wife she was drawing her eyebrows too high. She looked surprised. *delusional grin*",
        "Why did the scarecrow win an award? Because he was outstanding in his field! *helpful nod*",
        "I'm reading a book on anti-gravity. It's impossible to put down! *sarcastic smirk*",
        "Why don't eggs tell jokes? They'd crack each other up! *threatening whisper*"
      ];

      const fallbackJoke = fallbackJokes[Math.floor(Math.random() * fallbackJokes.length)];

      const embed = new EmbedBuilder()
        .setTitle('😂 Sheogorath\'s Backup Joke')
        .setDescription(fallbackJoke)
        .setColor(0xff6b6b)
        .setFooter({
          text: `AI is sleeping, but I never do! • ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true })
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      // Try to react with laughing emojis (ignore if no permission)
      try {
        const message = await interaction.fetchReply();
        await message.react('😂');
        await message.react('🤣');
      } catch (reactionError) {
        // Silently ignore reaction permission errors
        console.log('Could not add reactions - missing permissions');
      }
    }
  },
};
