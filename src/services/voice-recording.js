const { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const pipelineAsync = promisify(pipeline);

/**
 * Record audio from a user in a voice channel
 * @param {VoiceChannel} voiceChannel - The voice channel to join
 * @param {string} userId - The user ID to record
 * @param {number} duration - Recording duration in milliseconds (default 10 seconds)
 * @returns {Promise<string>} Path to the recorded audio file
 */
async function recordUser(voiceChannel, userId, duration = 10000) {
  return new Promise(async (resolve, reject) => {
    let connection = null;
    
    try {
      // Join the voice channel
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true
      });

      await new Promise((resolveReady, rejectReady) => {
        connection.on(VoiceConnectionStatus.Ready, resolveReady);
        connection.on(VoiceConnectionStatus.Disconnected, () => rejectReady(new Error('Connection failed')));
        
        setTimeout(() => rejectReady(new Error('Connection timeout')), 10000);
      });

      const receiver = connection.receiver;
      const outputPath = path.join(__dirname, '../../temp', `recording-${userId}-${Date.now()}.pcm`);
      
      // Ensure temp directory exists
      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      let recordingStarted = false;
      let hasAudio = false;
      const writeStream = createWriteStream(outputPath);
      
      console.log(`Waiting for user ${userId} to speak...`);

      // Subscribe to the user's audio stream immediately
      // This will capture all audio during the recording period
      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.Manual
        }
      });

      // Decode opus to PCM
      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      });

      const audioStream = opusStream.pipe(decoder).pipe(writeStream);

      // Track if we receive any audio data
      decoder.on('data', () => {
        if (!hasAudio) {
          hasAudio = true;
          console.log(`Receiving audio from user ${userId}`);
        }
      });

      // Monitor speaking events
      receiver.speaking.on('start', (speakingUserId) => {
        if (speakingUserId === userId && !recordingStarted) {
          recordingStarted = true;
          console.log(`User ${userId} started speaking`);
        }
      });

      // Set recording timeout - stop after specified duration
      const recordingTimeout = setTimeout(async () => {
        console.log('Recording duration reached, stopping...');
        
        try {
          opusStream.destroy();
          decoder.end();
          writeStream.end();
          
          // Wait a bit for stream to finish writing
          await new Promise(resolve => setTimeout(resolve, 500));
          
          connection.destroy();
          
          if (!hasAudio) {
            console.log('No audio data received');
            await fs.unlink(outputPath).catch(() => {});
            reject(new Error('No audio detected. Please speak clearly into your microphone.'));
          } else {
            // Convert PCM to WAV
            const wavPath = await convertPCMtoWAV(outputPath);
            resolve(wavPath);
          }
        } catch (err) {
          connection.destroy();
          reject(err);
        }
      }, duration);

      audioStream.on('error', (err) => {
        console.error('Recording stream error:', err);
        clearTimeout(recordingTimeout);
        connection.destroy();
        reject(err);
      });

    } catch (err) {
      if (connection) connection.destroy();
      reject(err);
    }
  });
}

/**
 * Convert raw PCM audio to WAV format using ffmpeg
 * @param {string} pcmPath - Path to the PCM file
 * @returns {Promise<string>} Path to the WAV file
 */
async function convertPCMtoWAV(pcmPath) {
  const { spawn } = require('child_process');
  const wavPath = pcmPath.replace('.pcm', '.wav');

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 's16le',           // Input format: signed 16-bit little-endian PCM
      '-ar', '48000',          // Sample rate: 48kHz
      '-ac', '2',              // Channels: stereo
      '-i', pcmPath,           // Input file
      '-y',                    // Overwrite output file
      wavPath                  // Output file
    ]);

    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        // Delete PCM file after conversion
        fs.unlink(pcmPath).catch(console.error);
        resolve(wavPath);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

/**
 * Cleanup old recording files
 * @param {number} maxAge - Maximum age in milliseconds (default 1 hour)
 */
async function cleanupOldRecordings(maxAge = 3600000) {
  try {
    const tempDir = path.join(__dirname, '../../temp');
    const files = await fs.readdir(tempDir);
    const now = Date.now();

    for (const file of files) {
      if (file.startsWith('recording-')) {
        const filePath = path.join(tempDir, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
          console.log(`Deleted old recording: ${file}`);
        }
      }
    }
  } catch (err) {
    console.error('Error cleaning up recordings:', err);
  }
}

module.exports = {
  recordUser,
  cleanupOldRecordings
};
