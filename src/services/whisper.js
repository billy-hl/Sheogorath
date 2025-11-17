const { OpenAI } = require('openai');
const fs = require('fs');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Transcribe audio file using OpenAI Whisper API
 * @param {string} audioFilePath - Path to the audio file
 * @param {string} language - Language code (optional, auto-detect if not provided)
 * @returns {Promise<string>} Transcribed text
 */
async function transcribeAudio(audioFilePath, language = null) {
  try {
    console.log(`Transcribing audio file: ${audioFilePath}`);
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-1',
      language: language || undefined,
      response_format: 'text'
    });

    console.log('Transcription result:', transcription);
    return transcription.trim();
  } catch (error) {
    console.error('Whisper API error:', error);
    throw new Error(`Failed to transcribe audio: ${error.message}`);
  }
}

/**
 * Parse voice command and extract intent
 * @param {string} transcription - The transcribed text
 * @returns {Object} Parsed command with action and parameters
 */
function parseVoiceCommand(transcription) {
  const text = transcription.toLowerCase().trim();
  
  // Common command patterns
  const patterns = {
    play: /^(play|put on|start playing)\s+(.+)$/i,
    stop: /^(stop|halt|cease|end)(\s+music|\s+playing)?$/i,
    skip: /^(skip|next|skip song)$/i,
    pause: /^(pause|hold|wait)$/i,
    resume: /^(resume|continue|unpause)$/i,
    queue: /^(show queue|what's in queue|queue|show songs)$/i,
    weather: /^(weather|what's the weather|how's the weather)(\s+in\s+(.+))?$/i,
    help: /^(help|commands|what can you do)$/i
  };

  // Check each pattern
  for (const [command, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match) {
      return {
        command,
        originalText: transcription,
        parameters: match.slice(2).filter(Boolean)
      };
    }
  }

  // If no pattern matches, treat as a general question/chat
  return {
    command: 'chat',
    originalText: transcription,
    parameters: [transcription]
  };
}

module.exports = {
  transcribeAudio,
  parseVoiceCommand
};
