'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createAudioResource, StreamType } = require('@discordjs/voice');

const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');
const USAGE_FILE = path.join(__dirname, '..', '..', 'data', 'tts-usage.json');

// Monthly character limit (40k credits = 40k characters)
const MONTHLY_LIMIT = parseInt(process.env.TTS_MONTHLY_LIMIT) || 40000;

function getUsage() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return { month: new Date().getMonth(), chars: 0 };
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    return { month: new Date().getMonth(), chars: 0 };
  }
}

function saveUsage(chars) {
  const currentMonth = new Date().getMonth();
  let usage = getUsage();
  
  // Reset if new month
  if (usage.month !== currentMonth) {
    usage = { month: currentMonth, chars: 0 };
  }
  
  usage.chars += chars;
  
  const dir = path.dirname(USAGE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  
  console.log(`[TTS] Usage: ${usage.chars}/${MONTHLY_LIMIT} chars this month`);
  return usage.chars;
}

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

  // Check monthly limit
  const usage = getUsage();
  if (usage.chars >= MONTHLY_LIMIT) {
    throw new Error(`TTS monthly limit reached (${MONTHLY_LIMIT} chars). Resets next month.`);
  }

  // Truncate to 5000 chars (ElevenLabs limit for standard tier)
  const truncatedText = text.slice(0, 5000);
  if (text.length > 5000) {
    console.log(`[TTS] Text truncated from ${text.length} to 5000 chars`);
  }

  // Check if this request would exceed limit
  if (usage.chars + truncatedText.length > MONTHLY_LIMIT) {
    const remaining = MONTHLY_LIMIT - usage.chars;
    throw new Error(`TTS limit would be exceeded. ${remaining} chars remaining this month.`);
  }

  const payload = JSON.stringify({
    text: truncatedText,
    model_id: 'eleven_monolingual_v1',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.85,
      style: 0.0,
      use_speaker_boost: true
    },
    output_format: 'mp3_44100_128'
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
          // Track usage
          saveUsage(truncatedText.length);
          
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

/**
 * Get ElevenLabs subscription info with real-time quota usage
 * @returns {Promise<Object>} Subscription data with character_count, character_limit, etc.
 */
async function getElevenLabsQuota() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY not set in .env');
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: '/v1/user/subscription',
        method: 'GET',
        headers: {
          'xi-api-key': apiKey,
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`ElevenLabs API error ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

module.exports = { textToSpeech, getElevenLabsQuota };
