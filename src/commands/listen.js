const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { recordUser, cleanupOldRecordings } = require('../services/voice-recording');
const { transcribeAudio, parseVoiceCommand } = require('../services/whisper');
const fs = require('fs').promises;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('listen')
    .setDescription('Listen for a voice command')
    .addIntegerOption(option =>
      option
        .setName('duration')
        .setDescription('Recording duration in seconds (default: 10)')
        .setMinValue(3)
        .setMaxValue(30)
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      // Check if user is in a voice channel
      const member = interaction.member;
      const voiceChannel = member.voice.channel;

      if (!voiceChannel) {
        return interaction.editReply({
          content: '❌ You need to be in a voice channel to use this command!'
        });
      }

      if (voiceChannel.type !== ChannelType.GuildVoice) {
        return interaction.editReply({
          content: '❌ This command only works in voice channels!'
        });
      }

      const duration = (interaction.options.getInteger('duration') || 10) * 1000;

      await interaction.editReply({
        content: `🎤 Listening for ${duration/1000} seconds... **Start speaking now!**`
      });

      // Record the user's audio
      let audioFilePath;
      try {
        audioFilePath = await recordUser(voiceChannel, interaction.user.id, duration);
        console.log('Recording saved:', audioFilePath);
      } catch (recordError) {
        console.error('Recording error:', recordError);
        return interaction.editReply({
          content: `❌ Failed to record audio: ${recordError.message}`
        });
      }

      // Update message
      await interaction.editReply({
        content: '🔄 Processing your voice command...'
      });

      // Transcribe the audio
      let transcription;
      try {
        transcription = await transcribeAudio(audioFilePath);
        console.log('Transcription:', transcription);
      } catch (transcribeError) {
        console.error('Transcription error:', transcribeError);
        // Cleanup audio file
        await fs.unlink(audioFilePath).catch(console.error);
        return interaction.editReply({
          content: `❌ Failed to transcribe audio: ${transcribeError.message}`
        });
      }

      // Cleanup audio file
      await fs.unlink(audioFilePath).catch(console.error);

      if (!transcription || transcription.length === 0) {
        return interaction.editReply({
          content: '❌ No speech detected. Please try again and speak clearly.'
        });
      }

      // Parse the voice command
      const parsedCommand = parseVoiceCommand(transcription);
      console.log('Parsed command:', parsedCommand);

      // Execute the command
      await executeVoiceCommand(interaction, parsedCommand);

      // Cleanup old recordings periodically
      cleanupOldRecordings().catch(console.error);

    } catch (error) {
      console.error('Listen command error:', error);
      await interaction.editReply({
        content: `❌ An error occurred: ${error.message}`
      }).catch(console.error);
    }
  }
};

/**
 * Execute a parsed voice command
 * @param {Interaction} interaction - The Discord interaction
 * @param {Object} parsedCommand - The parsed command object
 */
async function executeVoiceCommand(interaction, parsedCommand) {
  const { command, originalText, parameters } = parsedCommand;

  try {
    switch (command) {
      case 'play':
        const query = parameters[0];
        const playCommand = interaction.client.commands.get('play');
        if (playCommand) {
          await interaction.editReply({
            content: `🎵 You said: *"${originalText}"*\n\nPlaying: **${query}**...`
          });
          // Execute the play command programmatically
          await playCommand.execute(interaction, query);
        } else {
          await interaction.editReply({
            content: `🎵 You said: *"${originalText}"*\n\n(Play command not available)`
          });
        }
        break;

      case 'stop':
        const stopCommand = interaction.client.commands.get('stop');
        if (stopCommand) {
          await interaction.editReply({
            content: `⏹️ You said: *"${originalText}"*\n\nStopping music...`
          });
          await stopCommand.execute(interaction);
        }
        break;

      case 'skip':
        const skipCommand = interaction.client.commands.get('skip');
        if (skipCommand) {
          await interaction.editReply({
            content: `⏭️ You said: *"${originalText}"*\n\nSkipping song...`
          });
          await skipCommand.execute(interaction);
        }
        break;

      case 'pause':
        const pauseCommand = interaction.client.commands.get('pause');
        if (pauseCommand) {
          await interaction.editReply({
            content: `⏸️ You said: *"${originalText}"*\n\nPausing...`
          });
          await pauseCommand.execute(interaction);
        }
        break;

      case 'resume':
        const resumeCommand = interaction.client.commands.get('resume');
        if (resumeCommand) {
          await interaction.editReply({
            content: `▶️ You said: *"${originalText}"*\n\nResuming...`
          });
          await resumeCommand.execute(interaction);
        }
        break;

      case 'queue':
        const queueCommand = interaction.client.commands.get('queue');
        if (queueCommand) {
          await interaction.editReply({
            content: `📋 You said: *"${originalText}"*`
          });
          await queueCommand.execute(interaction);
        }
        break;

      case 'weather':
        const location = parameters[1] || null;
        const weatherCommand = interaction.client.commands.get('weather');
        if (weatherCommand) {
          await interaction.editReply({
            content: `🌤️ You said: *"${originalText}"*\n\nFetching weather...`
          });
          await weatherCommand.execute(interaction, location);
        }
        break;

      case 'help':
        await interaction.editReply({
          content: `❓ You said: *"${originalText}"*\n\n**Voice Commands:**\n` +
                  `• "Play [song name]" - Play music\n` +
                  `• "Stop" - Stop music\n` +
                  `• "Skip" - Skip current song\n` +
                  `• "Pause" / "Resume" - Control playback\n` +
                  `• "Queue" - Show current queue\n` +
                  `• "Weather" - Get weather info\n` +
                  `• Or just ask me anything!`
        });
        break;

      case 'chat':
      default:
        // Use AI to respond to the voice command
        await interaction.editReply({
          content: `💬 You said: *"${originalText}"*\n\nLet me think about that...`
        });
        
        // Get AI response
        const { askChatGPTDirect } = require('../ai/grok');
        try {
          const aiResponse = await askChatGPTDirect(originalText);
          await interaction.editReply({
            content: `💬 You said: *"${originalText}"*\n\n${aiResponse}`
          });
        } catch (err) {
          await interaction.editReply({
            content: `💬 You said: *"${originalText}"*\n\n(I heard you, but I'm having trouble responding right now)`
          });
        }
        break;
    }
  } catch (error) {
    console.error('Error executing voice command:', error);
    await interaction.editReply({
      content: `💬 You said: *"${originalText}"*\n\n❌ Error: ${error.message}`
    }).catch(console.error);
  }
}
