const { SlashCommandBuilder } = require('discord.js');
const wakeWordDetector = require('../services/wake-word');
const { recordUser } = require('../services/voice-recording');
const { transcribeAudio, parseVoiceCommand } = require('../services/whisper');
const fs = require('fs').promises;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('joinvoice')
    .setDescription('Bot joins your voice channel and listens for wake word'),

  async execute(interaction) {
    try {
      // Check if user is in a voice channel
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({
          content: '❌ You need to be in a voice channel first!',
          flags: 64
        });
      }

      // Check if already listening in this channel
      if (wakeWordDetector.isListening(voiceChannel.id)) {
        return interaction.reply({
          content: '✅ I\'m already listening in this channel!',
          flags: 64
        });
      }

      // Get Picovoice access key from env
      const accessKey = process.env.PICOVOICE_ACCESS_KEY;
      if (!accessKey) {
        return interaction.reply({
          content: '❌ Wake word detection not configured. Missing PICOVOICE_ACCESS_KEY in .env',
          flags: 64
        });
      }

      await interaction.deferReply({ flags: 64 });

      // Define wake word callback
      const onWakeWord = async (userId) => {
        try {
          console.log(`Wake word triggered by user ${userId}, starting recording...`);
          
          // Send notification to channel
          await interaction.followUp({
            content: `🎤 Wake word detected! Listening...`,
            flags: 64
          });

          // Record audio for 10 seconds
          const audioPath = await recordUser(voiceChannel, userId, 10000);

          // Transcribe
          const transcription = await transcribeAudio(audioPath);
          console.log(`Transcription: ${transcription}`);

          // Parse command
          const parsedCommand = parseVoiceCommand(transcription);
          console.log('Parsed command:', parsedCommand);

          // Execute command
          const result = await executeVoiceCommand(parsedCommand, interaction, voiceChannel);
          
          // Send result
          await interaction.followUp({
            content: result,
            flags: 64
          });

          // Clean up audio file
          await fs.unlink(audioPath).catch(() => {});

        } catch (err) {
          console.error('Wake word callback error:', err);
          await interaction.followUp({
            content: `❌ Error processing command: ${err.message}`,
            flags: 64
          }).catch(() => {});
        }
      };

      // Start listening for wake word
      await wakeWordDetector.startListening(voiceChannel, onWakeWord, accessKey);

      await interaction.editReply({
        content: `✅ Joined **${voiceChannel.name}**! Say **"Hey Fred"** to activate voice commands.\n\nUse \`/leavevoice\` to disconnect.`
      });

    } catch (err) {
      console.error('Join voice error:', err);
      
      if (interaction.deferred) {
        await interaction.editReply({
          content: `❌ Failed to join voice: ${err.message}`
        });
      } else {
        await interaction.reply({
          content: `❌ Failed to join voice: ${err.message}`,
          flags: 64
        });
      }
    }
  }
};

/**
 * Execute a parsed voice command
 */
async function executeVoiceCommand(parsedCommand, interaction, voiceChannel) {
  const { command, parameters, originalText } = parsedCommand;

  try {
    switch (command) {
      case 'play': {
        const query = parameters.join(' ');
        const musicCommand = require('./music');
        
        // Create fake interaction for music command
        const fakeInteraction = {
          ...interaction,
          options: {
            getString: (name) => name === 'query' ? query : null
          },
          reply: async (content) => content.content || content,
          editReply: async (content) => content.content || content,
          deferReply: async () => {},
          member: interaction.member,
          guild: interaction.guild,
          channel: interaction.channel
        };

        await musicCommand.execute(fakeInteraction);
        return `🎵 Playing: ${query}`;
      }

      case 'stop': {
        const stopCommand = require('./stop');
        await stopCommand.execute(interaction);
        return '⏹️ Stopped playback';
      }

      case 'skip': {
        const skipCommand = require('./skip');
        await skipCommand.execute(interaction);
        return '⏭️ Skipped track';
      }

      case 'pause': {
        const pauseCommand = require('./pause');
        await pauseCommand.execute(interaction);
        return '⏸️ Paused playback';
      }

      case 'resume': {
        const resumeCommand = require('./resume');
        await resumeCommand.execute(interaction);
        return '▶️ Resumed playback';
      }

      case 'queue': {
        const queueCommand = require('./queue');
        const result = await queueCommand.execute(interaction);
        return result || '📋 Queue command executed';
      }

      default:
        return `🤔 Command not recognized: "${originalText}"`;
    }
  } catch (err) {
    console.error('Execute voice command error:', err);
    return `❌ Error: ${err.message}`;
  }
}
