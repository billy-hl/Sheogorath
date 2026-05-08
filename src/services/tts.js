'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createAudioResource, StreamType } = require('@discordjs/voice');

const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');

/**
 * Convert text to speech using ElevenLabs API and return an audio resource.
 * @param {string} text - The text to convert to speech
 * @returns {Promise<AudioResource>} Audio resource ready for voice playback
 */
async function textToSpeech(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel voice

  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY not set in .env');
  }

  // Truncate to 5000 chars (ElevenLabs limit for standard tier)
  const truncatedText = text.slice(0, 5000);
  if (text.length > 5000) {
    console.log(`[TTS] Text truncated from ${text.length} to 5000 chars`);
  }

  const payload = JSON.stringify({
    text: truncatedText,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      res => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', c => errorData += c);
          res.on('end', () => {
            reject(new Error(`ElevenLabs API error ${res.statusCode}: ${errorData}`));
          });
          return;
        }

        // Stream audio to temp file, then create resource
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
        const tempFile = path.join(TEMP_DIR, `tts_${Date.now()}.mp3`);
        const writeStream = fs.createWriteStream(tempFile);

        res.pipe(writeStream);
        writeStream.on('finish', () => {
          console.log(`[TTS] Generated audio: ${tempFile}`);
          const resource = createAudioResource(tempFile, {
            inputType: StreamType.Arbitrary,
          });
          // Clean up file after a delay
          resource.playStream.once('end', () => {
            setTimeout(() => {
              try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
            }, 5000);
          });
          resolve(resource);
        });
        writeStream.on('error', reject);
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { textToSpeech };
