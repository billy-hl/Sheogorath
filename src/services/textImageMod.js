'use strict';

const axios = require('axios');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MOD_MODEL || 'qwen3-coder:latest';

const SYSTEM_PROMPT = `You are a content moderation classifier for a Discord server. Your job is to detect text-based images (ASCII art, Unicode art, emoticon art, kaomoji compositions) that depict sexual or explicit content.

Sexual/explicit content includes: breasts, genitals, sexual acts, nudity, or any body parts arranged to suggest sexual imagery. Common examples: ( . )( . ) or (  .  )(  .  ) representing breasts, 8==D or similar representing a penis, ASCII figures in sexual poses, etc.

Reply with ONLY the word YES if the message appears to be a text-based image with sexual/explicit content. Reply with ONLY the word NO otherwise.

Do not flag normal text conversation, even if it discusses mature topics.`;

// Characters commonly used in ASCII/text art
const ART_CHARS = new Set('()[]{}<>|/\\_.-=~*#@^+,;:!?\'"`');

/**
 * Heuristic pre-filter — cheap check before hitting Ollama.
 * Returns true if the message looks like it could be text-based art.
 */
function looksLikeTextArt(content) {
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  // Single-line: must be mostly drawing chars (catches things like "8==D" or "( . )( . )")
  if (lines.length === 1) {
    const line = lines[0].trim();
    if (line.length < 3) return false;
    const artCount = [...line].filter(c => ART_CHARS.has(c) || c === ' ').length;
    const ratio = artCount / line.length;
    // Require at least one "structural" character to avoid false positives like "omg!!!" or "lol!!!"
    const STRUCTURAL = new Set('()[]{}<>|/\\=~*');
    const hasStructural = [...line].some(c => STRUCTURAL.has(c));
    if (!hasStructural) return false;
    // Short strings use a lower threshold — emoticons like "8==D" have fewer art chars
    const threshold = line.length < 15 ? 0.38 : 0.55;
    return ratio > threshold;
  }

  // Multi-line: if 2+ lines are drawing-char-heavy it's probably art
  const heavyLines = lines.filter(line => {
    if (line.trim().length < 2) return false;
    const artCount = [...line].filter(c => ART_CHARS.has(c) || c === ' ').length;
    return artCount / line.length > 0.45;
  });

  return heavyLines.length >= 2;
}

/**
 * Ask Ollama whether the message contains sexualized text-based imagery.
 * Returns true if Ollama says YES.
 */
async function ollamaCheck(content) {
  try {
    const res = await axios.post(
      `${OLLAMA_URL}/api/generate`,
      {
        model: OLLAMA_MODEL,
        system: SYSTEM_PROMPT,
        // /no_think disables qwen3's chain-of-thought so we get YES/NO directly
        prompt: `/no_think\n${content}`,
        stream: false,
        options: { temperature: 0, num_predict: 64 },
      },
      { timeout: 20000 }
    );

    const reply = (res.data?.response || '').trim().toUpperCase();
    console.log(`[TextImageMod] Ollama response: "${reply.slice(0, 80)}"`);
    // Match YES or NO anywhere in the response (handles any stray prefix tokens)
    if (/\bYES\b/.test(reply)) return true;
    if (/\bNO\b/.test(reply)) return false;
    // Ambiguous — fail open
    console.warn('[TextImageMod] Ambiguous response, skipping:', reply);
    return false;
  } catch (err) {
    console.warn('[TextImageMod] Ollama check failed, skipping:', err.message);
    return false; // fail open — don't block messages if Ollama is down
  }
}

/**
 * Main moderation check. Returns true if the message should be removed.
 */
async function isSexualizedTextImage(content) {
  if (!content || content.length < 3) return false;
  if (!looksLikeTextArt(content)) return false;
  return ollamaCheck(content);
}

module.exports = { isSexualizedTextImage };
