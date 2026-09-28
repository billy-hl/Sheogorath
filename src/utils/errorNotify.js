'use strict';

let client = null;

function setClient(discordClient) {
  client = discordClient;
}

/**
 * Where errors go: the operator channel when ERROR_CHANNEL_ID names one that
 * still exists, otherwise the bot owner's DMs. Falling back rather than going
 * quiet means deleting the channel never silences the errors.
 */
async function destination() {
  if (process.env.ERROR_CHANNEL_ID) {
    const channel = await client.channels.fetch(process.env.ERROR_CHANNEL_ID).catch(() => null);
    if (channel?.isTextBased()) return channel;
  }
  if (process.env.ADMIN_USER_ID) return client.users.fetch(process.env.ADMIN_USER_ID).catch(() => null);
  return null;
}

/**
 * Send critical error to error notification channel, or the owner by DM
 * @param {string} errorMessage - Error message
 * @param {Error} [error] - Error object (optional)
 */
async function notifyError(errorMessage, error = null) {
  if (!client) return;
  
  try {
    const target = await destination();
    if (!target) return;
    
    let message = `🚨 **Error:** ${errorMessage}`;
    if (error) {
      message += `\n\`\`\`\n${error.stack || error.message}\n\`\`\``;
    }
    
    // Truncate if too long
    if (message.length > 2000) {
      message = message.slice(0, 1997) + '...';
    }
    
    await target.send(message);
  } catch (err) {
    console.error('[ErrorNotify] Failed to send error notification:', err.message);
  }
}

module.exports = { setClient, notifyError };
