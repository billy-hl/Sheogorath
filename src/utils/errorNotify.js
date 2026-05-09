'use strict';

let client = null;

function setClient(discordClient) {
  client = discordClient;
}

/**
 * Send critical error to error notification channel
 * @param {string} errorMessage - Error message
 * @param {Error} [error] - Error object (optional)
 */
async function notifyError(errorMessage, error = null) {
  if (!client || !process.env.ERROR_CHANNEL_ID) return;
  
  try {
    const channel = await client.channels.fetch(process.env.ERROR_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;
    
    let message = `🚨 **Error:** ${errorMessage}`;
    if (error) {
      message += `\n\`\`\`\n${error.stack || error.message}\n\`\`\``;
    }
    
    // Truncate if too long
    if (message.length > 2000) {
      message = message.slice(0, 1997) + '...';
    }
    
    await channel.send(message);
  } catch (err) {
    console.error('[ErrorNotify] Failed to send error notification:', err.message);
  }
}

module.exports = { setClient, notifyError };
