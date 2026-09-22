'use strict';
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { mirrorLinks } = require('./mediaMirror');

const COOKIES_FILE = path.join(__dirname, '..', '..', 'www.instagram.com_cookies.txt');

/**
 * Download Instagram post (photo or video) using gallery-dl.
 */
async function handleInstagramLinks(message) {
  const instagramRegex = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/gi;
  const matches = message.content.match(instagramRegex);
  if (!matches) return;

  console.log(`[Instagram] Detected ${matches.length} Instagram link(s) in message from ${message.author.username}`);

  await mirrorLinks(message, {
    tag: 'Instagram',
    urls: matches,
    labels: { video: '🎬 Instagram video', photo: '📸 Instagram photo' },
    download: downloadPost,
  });
}

async function downloadPost(url, dlDir) {
  const cookieArg = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
  try {
    await exec(`gallery-dl ${cookieArg} -D "${dlDir}" "${url}"`, { timeout: 60000 });
  } catch (dlErr) {
    // gallery-dl may exit non-zero even on partial success; the caller checks
    // whether files landed and only uses this message if none did.
    console.error('[Instagram] gallery-dl failed:', dlErr.message.split('\n')[0]);
    return '❌ Instagram download failed — the post may be private or cookies need refreshing.';
  }
  return '❌ Nothing was downloaded from that Instagram link.';
}

module.exports = { handleInstagramLinks };
