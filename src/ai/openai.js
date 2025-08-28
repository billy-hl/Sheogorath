const { OpenAI } = require('openai');
require('dotenv').config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getAIResponse(prompt) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: 200,
    temperature: 0.7,
  });
  return completion.choices[0].message.content.trim();
}

module.exports = { getAIResponse };
