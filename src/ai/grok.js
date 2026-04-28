const axios = require('axios');

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

async function getAIResponse(prompt, { systemPrompt, maxTokens } = {}) {
  try {
    const response = await axios.post(GROK_API_URL, {
      model: 'grok-code-fast-1',
      messages: [
        { role: 'system', content: buildSystemPrompt(systemPrompt) },
        { role: 'user', content: prompt }
      ],
      max_tokens: 500,
      temperature: 0.7,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    });

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Grok API Error:', error.response?.data || error.message);
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('AI response timed out.');
    }
    throw new Error(`Grok API Error: ${error.response?.status || 'Unknown'} - ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * Get AI response with conversation history for multi-turn chat.
 * @param {Array<{role: string, content: string}>} messages - Conversation history
 * @param {number} [maxTokens=500] - Max response tokens
 * @returns {Promise<string>} AI response
 */
async function getAIResponseWithHistory(messages, maxTokens = 500) {
  const makeRequest = async (msgs, timeout) => {
    const response = await axios.post(GROK_API_URL, {
      model: 'grok-code-fast-1',
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        ...msgs
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout,
    });
    return response.data.choices[0].message.content.trim();
  };

  try {
    // Try with full history (2 minute timeout)
    return await makeRequest(messages, 120000);
  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
    
    if (isTimeout && messages.length > 1) {
      console.log('Grok timed out with history, retrying with last message only...');
      try {
        // Retry with just the latest message (no history)
        return await makeRequest(messages.slice(-1), 120000);
      } catch (retryError) {
        console.error('Grok API retry also failed:', retryError.message);
        throw new Error('AI response timed out after retry.');
      }
    }
    
    console.error('Grok API Error (history):', error.response?.data || error.message);
    throw new Error(`Grok API Error: ${error.response?.status || 'Unknown'}`);
  }
}

module.exports = { getAIResponse, getAIResponseWithHistory };
