const axios = require('axios');

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';

async function getAIResponse(prompt) {
  try {
    const response = await axios.post(GROK_API_URL, {
      model: 'grok-code-fast-1',
      messages: [
        { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
        { role: 'user', content: prompt }
      ],
      max_tokens: 500,
      temperature: 0.7,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Grok API Error:', error.response?.data || error.message);
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('AI response timed out. The Mad King is... contemplating too deeply.');
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
        { role: 'system', content: process.env.CLIENT_INSTRUCTIONS },
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
