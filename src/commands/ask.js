const { SlashCommandBuilder } = require('discord.js');
const { getVoiceConnection, joinVoiceChannel, createAudioPlayer, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const { textToSpeech } = require('../services/tts');

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

      // Check if user is in voice
      const member = interaction.member;
      const voiceChannel = member?.voice?.channel;

      if (voiceChannel && process.env.ELEVENLABS_API_KEY) {
        try {
          console.log(`[Voice] /ask user in voice channel, joining to speak`);

          // Join voice
          let connection = getVoiceConnection(interaction.guild.id);
          if (!connection || connection.joinConfig.channelId !== voiceChannel.id) {
            connection = joinVoiceChannel({
              channelId: voiceChannel.id,
              guildId: interaction.guild.id,
              adapterCreator: interaction.guild.voiceAdapterCreator,
            });
          }

          // Generate TTS
          const audioResource = await textToSpeech(response);

          // Play audio
          const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
          connection.subscribe(player);
          player.play(audioResource);

          // Also send text
          await sendTextReply(interaction, question, response);

          // Auto-disconnect
          player.once(AudioPlayerStatus.Idle, () => {
            setTimeout(() => {
              if (connection.state.status !== 'destroyed') connection.destroy();
            }, 2000);
          });
        } catch (voiceErr) {
          console.error('[Voice] TTS failed:', voiceErr.message);
          await sendTextReply(interaction, question, response);
        }
      } else {
        // Text-only
        await sendTextReply(interaction, question, response);
      }
    } catch (err) {
      console.error('Ask command error:', err.message);
      await interaction.editReply(`Something went wrong: ${err.message}`);
    }
  },
};

async function sendTextReply(interaction, question, response) {
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
}
