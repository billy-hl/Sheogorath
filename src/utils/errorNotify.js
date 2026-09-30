'use strict';

let client = null;

/**
 * Notices raised before the client is ready — a damaged data file is found on
 * the first read, well before login — are held here and sent once it is.
 */
const pending = [];
const MAX_PENDING = 20;

function setClient(discordClient) {
  client = discordClient;
  for (const send of pending.splice(0)) send();
}

/** Run `send` now if the client is up, or once it is. */
function whenReady(send) {
  if (client) return send();
  if (pending.length < MAX_PENDING) pending.push(() => { send().catch(() => {}); });
  return Promise.resolve();
}

/** The bot owner, as a DM target, or null. */
function owner() {
  if (!process.env.ADMIN_USER_ID) return null;
  return client.users.fetch(process.env.ADMIN_USER_ID).catch(() => null);
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
  return owner();
}

/**
 * Send critical error to error notification channel, or the owner by DM
 * @param {string} errorMessage - Error message
 * @param {Error} [error] - Error object (optional)
 */
function notifyError(errorMessage, error = null) {
  return whenReady(async () => {
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
  });
}

/**
 * Something only the owner needs to hear: by DM, and nowhere else — not the
 * error channel, not any server's staff channel. The spend warnings go this way.
 * @param {string} content
 */
function notifyOwner(content) {
  return whenReady(async () => {
    try {
      const target = await owner();
      if (!target) {
        console.warn('[ErrorNotify] No ADMIN_USER_ID to tell:', content);
        return;
      }
      await target.send({ content: content.slice(0, 2000), allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[ErrorNotify] Failed to DM the owner:', err.message);
    }
  });
}

module.exports = { setClient, notifyError, notifyOwner };
