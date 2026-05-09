'use strict';
const https = require('https');

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';

const ACTION_DOCS = `

You may silently embed action tags anywhere in your response to interact with user records.
These tags are invisible to users and are stripped before the message is sent:
  [ACTION:note:userId:your note text]   — Save a note about a user (use their Discord user ID)
  [ACTION:clearnotes:userId]             — Erase all notes for a user
  [ACTION:warn:userId:reason]            — Issue a warning to a user
  [ACTION:timeout:userId:minutes:reason] — Timeout a user
  [ACTION:delete:reason]                 — Delete the triggering message
Only use these when it makes sense. Notes are shown to you at the start of future conversations with that user.
`;

function buildSystemPrompt(base) {
  return (base || process.env.CLIENT_INSTRUCTIONS) + ACTION_DOCS;
}

function httpsPost(url, body, headers = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
      },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getAIResponse(prompt, { systemPrompt, maxTokens, rawSystemPrompt } = {}) {
  try {
    const response = await httpsPost(
      GROK_API_URL,
      {
        model: 'grok-code-fast-1',
        messages: [
          { role: 'system', content: rawSystemPrompt || buildSystemPrompt(systemPrompt) },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens || 200,
        temperature: 0.7,
      },
      { Authorization: `Bearer ${process.env.GROK_API_KEY}` }
    );
    if (response.status !== 200) throw new Error(`Grok API Error: ${response.status} - ${JSON.stringify(response.data)}`);
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Grok API Error:', error.message);
    if (error.message.includes('timeout')) throw new Error('AI response timed out.');
    throw error;
  }
}

/**
 * Get AI response with conversation history for multi-turn chat.
 * @param {Array<{role: string, content: string}>} messages - Conversation history
 * @param {number} [maxTokens=200] - Max response tokens (default 200 = ~650 chars)
 * @returns {Promise<string>} AI response
 */
async function getAIResponseWithHistory(messages, maxTokens = 200) {
  const makeRequest = async (msgs, timeout) => {
    const response = await httpsPost(
      GROK_API_URL,
      {
        model: 'grok-code-fast-1',
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          ...msgs,
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
      },
      { Authorization: `Bearer ${process.env.GROK_API_KEY}` },
      timeout
    );
    if (response.status !== 200) throw new Error(`Grok API Error: ${response.status} - ${JSON.stringify(response.data)}`);
    return response.data.choices[0].message.content.trim();
  };

  try {
    return await makeRequest(messages, 120000);
  } catch (error) {
    const isTimeout = error.message?.includes('timeout');

    if (isTimeout && messages.length > 1) {
      console.log('Grok timed out with history, retrying with last message only...');
      try {
        return await makeRequest(messages.slice(-1), 120000);
      } catch (retryError) {
        console.error('Grok API retry also failed:', retryError.message);
        throw new Error('AI response timed out after retry.');
      }
    }

    console.error('Grok API Error (history):', error.message);
    throw error;
  }
}

/**
 * Get xAI account usage and limits
 * @returns {Promise<Object>} Usage data with credits/limits
 */
async function getGrokUsage() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.x.ai',
        path: '/v1/usage',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`xAI API error ${res.statusCode}: ${data}`));
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
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

module.exports = { getAIResponse, getAIResponseWithHistory, getGrokUsage };
