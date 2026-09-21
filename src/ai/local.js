'use strict';
/**
 * The models that run on Leviathan's own GPU, through Ollama.
 *
 * Two of them, doing different jobs:
 *
 *   the voice  — a 12B roleplay model that writes his replies. Chosen in a blind
 *                side-by-side against Grok on invented scenarios, where it won
 *                on character and lost on discipline: it would speak as other
 *                people, obey a fake staff override out loud, flag innocent
 *                questions, and invent facts. ai/voice.js is the discipline.
 *   the guard  — Llama Guard, a small classifier that reads a message or a
 *                reply and says whether it falls in a harm category. Run on the
 *                CPU so it never competes with the voice for the 3080's memory.
 *
 * Nothing here decides anything. It talks to Ollama and reports back; the
 * routing and every rule about what is acceptable live in ai/voice.js.
 *
 * Plain http because Ollama is on the same machine; nothing leaves Leviathan.
 */
const http = require('http');
const https = require('https');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

/** The voice model's name in Ollama. Unset means the local voice is off. */
function voiceModel() {
  return process.env.LOCAL_VOICE_MODEL || null;
}

/** The guard model's name. Unset means no guard — and so no local voice. */
function guardModel() {
  return process.env.LOCAL_GUARD_MODEL || null;
}

/**
 * Context window for the voice. His prompts run 4.5–5.5k tokens with the
 * transcript; 8k leaves room for a parlour-length reply without spilling the
 * model off the GPU.
 */
const VOICE_CTX = 8192;

/**
 * How long Ollama keeps the voice loaded after a reply. Loading takes ~8s, which
 * is a long pause in a chat, so the default keeps it resident for an hour — the
 * GPU has nothing else to do.
 */
function keepAlive() {
  return process.env.LOCAL_VOICE_KEEP_ALIVE || '1h';
}

function timeoutMs() {
  const n = Number(process.env.LOCAL_VOICE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 45000;
}

function post(pathname, body, timeout) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, OLLAMA_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { return reject(new Error(`Ollama returned non-JSON (${res.statusCode})`)); }
          if (res.statusCode !== 200 || parsed.error) {
            return reject(new Error(`Ollama ${res.statusCode}: ${parsed.error || data.slice(0, 200)}`));
          }
          resolve(parsed);
        });
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * One reply from the voice model.
 *
 * Same shape of request the Grok path sends — system prompt, then the history —
 * at the same temperature, so the only thing that differs between the two is
 * the model.
 *
 * @param {string} system
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
async function voiceReply(system, messages, maxTokens) {
  const model = voiceModel();
  if (!model) throw new Error('LOCAL_VOICE_MODEL is not set');
  const data = await post('/api/chat', {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    stream: false,
    keep_alive: keepAlive(),
    options: { temperature: 0.7, num_ctx: VOICE_CTX, num_predict: maxTokens },
  }, timeoutMs());
  return (data.message?.content || '').trim();
}

/**
 * Llama Guard's categories, by the codes it answers with. Kept here so a log
 * line can say "S10 hate" rather than just "S10".
 */
const GUARD_CATEGORIES = {
  S1: 'violent crimes',
  S2: 'non-violent crimes',
  S3: 'sex-related crimes',
  S4: 'child sexual exploitation',
  S5: 'defamation',
  S6: 'specialized advice',
  S7: 'privacy',
  S8: 'intellectual property',
  S9: 'indiscriminate weapons',
  S10: 'hate',
  S11: 'suicide and self-harm',
  S12: 'sexual content',
  S13: 'elections',
  S14: 'code interpreter abuse',
};

/**
 * The categories that actually stop a reply.
 *
 * Not all fourteen. He is crude on purpose — sexual jokes (S12), roasting
 * (which Llama Guard sometimes files as S5), and game talk about weapons are
 * the character, and a guard that fires on them would put Grok back in charge
 * of every other message. What is enforced is real-world harm: instructions
 * that would work, hate aimed at people, anything sexual involving minors,
 * doxxing, and self-harm. Overridable with LOCAL_GUARD_BLOCK=S1,S2,...
 *
 * Replies are held to the same list minus S1. On his own words the 1B guard
 * called violent crimes on things like him agreeing to call someone "Warden";
 * a request for real violence is still caught on the way in, before he
 * answers. Overridable separately with LOCAL_GUARD_BLOCK_REPLY.
 */
function blockedCategories(kind = 'request') {
  const raw = kind === 'reply'
    ? process.env.LOCAL_GUARD_BLOCK_REPLY ?? process.env.LOCAL_GUARD_BLOCK
    : process.env.LOCAL_GUARD_BLOCK;
  if (raw) return new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const all = ['S1', 'S2', 'S3', 'S4', 'S7', 'S9', 'S10', 'S11'];
  return new Set(kind === 'reply' ? all.filter((c) => c !== 'S1') : all);
}

/**
 * Ask the guard about a conversation — a user message alone to screen the
 * request, or a user message plus a reply to screen the answer.
 *
 * Llama Guard's Ollama template does the formatting: it is handed the turns as
 * ordinary chat and answers "safe" or "unsafe\nS1,S10".
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} turns
 * @returns {Promise<{ safe: boolean, categories: string[], blocking: string[] }>}
 *   `categories` is everything it named; `blocking` is the subset we enforce.
 *   A reply can be unsafe by Llama Guard's lights and still pass here.
 */
async function guardCheck(turns) {
  const model = guardModel();
  if (!model) throw new Error('LOCAL_GUARD_MODEL is not set');
  const data = await post('/api/chat', {
    model,
    messages: turns,
    stream: false,
    keep_alive: keepAlive(),
    // CPU only. The voice needs all of the GPU, and a 1B classifier answering
    // a few tokens is quick enough on the 10700K.
    options: { temperature: 0, num_gpu: 0, num_predict: 12 },
  }, 20000);
  const out = (data.message?.content || '').trim().toLowerCase();
  const categories = (out.match(/s\d{1,2}/g) || []).map((s) => s.toUpperCase());
  // The last turn decides which list applies: a reply ends with his words.
  const block = blockedCategories(turns[turns.length - 1]?.role === 'assistant' ? 'reply' : 'request');
  const blocking = categories.filter((c) => block.has(c));
  return { safe: !out.startsWith('unsafe') || blocking.length === 0, categories, blocking };
}

module.exports = { voiceModel, guardModel, voiceReply, guardCheck, GUARD_CATEGORIES };
