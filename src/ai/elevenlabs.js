'use strict';
/**
 * His speaking voice, through ElevenLabs.
 *
 * Only the clip commentary talks out loud (services/commentary.js), one short
 * request per line he says over the footage. The key in .env is scoped to
 * speech alone, so it cannot read the account's quota back: the cap below is
 * the only thing between a busy clips channel and an empty plan, and it is
 * deliberately well under what a starter plan allows in a month.
 */

const API = 'https://api.elevenlabs.io/v1/text-to-speech';

/** The most expressive of their models, and the one he was auditioned in. */
const MODEL = 'eleven_multilingual_v2';

/**
 * Characters he may speak in a day, across every guild.
 *
 * A clip's commentary is a few hundred characters, so this is roughly twenty
 * clips. Kept in memory: a restart resets it, which at worst doubles one day's
 * spend, and not worth a data file for.
 */
const DAILY_CHARACTERS = 6000;

let spentOn = null;
let spent = 0;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function configured() {
  return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

/** Characters left today. */
function remaining() {
  if (spentOn !== today()) { spentOn = today(); spent = 0; }
  return DAILY_CHARACTERS - spent;
}

/**
 * Speak one line. Resolves to MP3 bytes.
 *
 * Throws when the voice is not configured, when the line would go over the day's
 * allowance, or when ElevenLabs refuses — the caller decides what that means
 * for the clip, since half a commentary is no commentary.
 */
async function speech(text) {
  if (!configured()) throw new Error('ElevenLabs is not configured');
  if (text.length > remaining()) throw new Error('his voice is spent for today');

  const res = await fetch(`${API}/${process.env.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  spent += text.length;
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { speech, remaining, configured, DAILY_CHARACTERS };
