'use strict';
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getAIResponse } = require('../ai/grok');
const { generateImage } = require('../ai/comfyui');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('imagine')
    .setDescription('Command the Mad God to conjure an image from the chaos of your imagination')
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Describe what you want Sheogorath to conjure')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const userPrompt = interaction.options.getString('prompt');

    try {
      // Let Sheogorath riff on the prompt in character before generating
      const flavourText = await getAIResponse(
        `A mortal has asked you to conjure a vision: "${userPrompt}". React to this request in one short sentence, in character as the Mad God.`,
        { maxTokens: 40, rawSystemPrompt: process.env.CLIENT_INSTRUCTIONS }
      );

      // Enhance the prompt for cinematic realism with a dark fantasy tone
      const enhancedPrompt = await getAIResponse(
        `Rewrite this image prompt to be photorealistic and cinematic. Dark fantasy atmosphere, dramatic lighting, highly detailed, no cartoons or illustrations. Keep it under 200 characters. Prompt: "${userPrompt}"`,
        { maxTokens: 60, rawSystemPrompt: 'You are a prompt engineer for photorealistic image generation. Output only the rewritten prompt, nothing else.' }
      );

      console.log(`[Imagine] Final prompt: ${enhancedPrompt || userPrompt}`);

      const imageBuffer = await generateImage(enhancedPrompt || userPrompt);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'vision.png' });

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('🌀 A Vision From The Shivering Isles')
        .setDescription(`*"${flavourText}"*`)
        .setImage('attachment://vision.png')
        .setFooter({ text: `Conjured from: ${userPrompt.substring(0, 80)}${userPrompt.length > 80 ? '...' : ''}` });

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (err) {
      console.error('[Imagine] Error:', err.message);
      await interaction.editReply('The Mad God\'s visions are... unavailable at this moment. Even chaos has its limits. Try again!');
    }
  },
};
