const axios = require('axios');
require('dotenv').config();

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_API_KEY = process.env.GROK_API_KEY;

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
      timeout: 15000, // 15 second timeout
    });

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Grok API Error:', error.response?.data || error.message);
    console.error('Status Code:', error.response?.status);
    console.error('Full Error Response:', error.response);

    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('AI response timed out. The Mad King is... contemplating too deeply.');
    }

    throw new Error(`Grok API Error: ${error.response?.status || 'Unknown'} - ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * Direct AI response without system instructions (for voice commands)
 * @param {string} prompt - User's question/command
 * @returns {Promise<string>} AI response
 */
async function askChatGPTDirect(prompt) {
  try {
    const response = await axios.post(GROK_API_URL, {
      model: 'grok-code-fast-1',
      messages: [
        { role: 'user', content: prompt }
      ],
      max_tokens: 300,
      temperature: 0.8,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Grok API Error (direct):', error.message);
    throw new Error('Failed to get AI response');
  }
}

module.exports = { getAIResponse, askChatGPTDirect };
