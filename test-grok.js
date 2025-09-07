const axios = require('axios');
require('dotenv').config();

console.log('Testing Grok API...');
console.log('API Key exists:', !!process.env.GROK_API_KEY);
console.log('API Key length:', process.env.GROK_API_KEY?.length);

async function testGrok() {
  try {
    console.log('Making API call...');
    const response = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-code-fast-1',
      messages: [
        { role: 'user', content: 'Hello' }
      ],
      max_tokens: 500,
      temperature: 0.7,
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('Full Response:', JSON.stringify(response.data, null, 2));
    console.log('Choices length:', response.data.choices?.length);
    console.log('First choice:', response.data.choices?.[0]);
    console.log('Message content:', response.data.choices?.[0]?.message?.content);

    if (response.data.choices?.[0]?.message?.content) {
      console.log('SUCCESS:', response.data.choices[0].message.content);
    } else {
      console.log('Response structure issue - no content found');
    }
  } catch (error) {
    console.log('ERROR Status:', error.response?.status);
    console.log('ERROR Data:', JSON.stringify(error.response?.data, null, 2));
    console.log('ERROR Message:', error.message);
  }
}

testGrok();
