'use strict';
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { mirrorLinks } = require('./mediaMirror');

// Optional. X lets anonymous clients fetch most public video, but it tightens
// that from time to time and always gates NSFW posts; a Netscape-format
// cookies export from a logged-in browser gets around both.
const COOKIES_FILE = path.join(__dirname, '..', '..', 'x.com_cookies.txt');

// fxtwitter/vxtwitter/fixupx are left alone on purpose: people use them
// because Discord already embeds their video inline, so mirroring one would
// post the clip twice.
const STATUS_REGEX = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)(\/video\/\d+)?/gi;

/**
 * Download video from posted X/Twitter links with yt-dlp.
 *
 * Only video is mirrored. Discord's own embed already shows text and photos
 * fine; it's video it can't play inline.
 */
async function handleTwitterLinks(message) {
  const urls = new Map();
  for (const [, user, id, videoPath] of message.content.matchAll(STATUS_REGEX)) {
    // One download per post, however many times or ways it was linked.
    // `/video/N` is kept so a multi-video post yields the one that was shared.
    if (!urls.has(id)) urls.set(id, `https://x.com/${user}/status/${id}${videoPath || ''}`);
  }
  if (urls.size === 0) return;

  console.log(`[Twitter] Detected ${urls.size} X link(s) in message from ${message.author.username}`);

  await mirrorLinks(message, {
    tag: 'Twitter',
    urls: [...urls.values()],
    labels: { video: '🎬 X video', photo: '📸 X photo' },
    download: downloadVideo,
  });
}

async function downloadVideo(url, dlDir) {
  const args = [
    '--no-warnings',
    // X serves progressive MP4s with audio included; prefer those so there's
    // nothing to merge. Fall back to split streams only if that's all there is.
    '-f', 'b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(dlDir, '%(id)s_%(autonumber)s.%(ext)s'),
  ];
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  args.push(url);

  try {
    // The `yt-dlp` on PATH, same as the music player, so there's one binary
    // to keep current. X breaks old builds about as often as YouTube does.
    await execFile('yt-dlp', args, { timeout: 90000 });
    return '❌ Nothing was downloaded from that X link.';
  } catch (err) {
    const detail = String(err.stderr || err.message);
    // Text and photo posts land here. They're most X links, and there's
    // nothing to mirror, so stay quiet.
    if (/No video could be found/i.test(detail)) return null;
    console.error('[Twitter] yt-dlp failed:', detail.trim().split('\n').pop());
    return '❌ X download failed — the post may be private, age-gated, or yt-dlp needs updating.';
  }
}

module.exports = { handleTwitterLinks };
