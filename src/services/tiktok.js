'use strict';
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { mirrorLinks } = require('./mediaMirror');

// vxtiktok/tnktok/tiktxk are left alone for the same reason fxtwitter is: they
// exist to make Discord embed the clip, so mirroring one would post it twice.
// yt-dlp's TikTok extractor only matches the www host, so bare and m. links
// are rewritten onto it.
const VIDEO_REGEX = /https?:\/\/(?:(?:www|m)\.)?tiktok\.com\/@([\w.-]+)\/video\/(\d+)/gi;
// App share links. yt-dlp follows these itself.
const SHORT_REGEX = /https?:\/\/(?:(vm|vt)\.tiktok\.com|(?:www\.)?tiktok\.com\/t)\/(\w+)/gi;

/**
 * Download video from posted TikTok links with yt-dlp.
 *
 * Discord's TikTok embed shows a thumbnail at best and never plays the clip.
 * Photo slideshows aren't mirrored; yt-dlp can't fetch them.
 */
async function handleTikTokLinks(message) {
  const urls = new Map();
  for (const [, user, id] of message.content.matchAll(VIDEO_REGEX)) {
    if (!urls.has(id)) urls.set(id, `https://www.tiktok.com/@${user}/video/${id}`);
  }
  for (const [, sub, code] of message.content.matchAll(SHORT_REGEX)) {
    if (!urls.has(code)) urls.set(code, sub ? `https://${sub}.tiktok.com/${code}` : `https://www.tiktok.com/t/${code}`);
  }
  if (urls.size === 0) return;

  console.log(`[TikTok] Detected ${urls.size} TikTok link(s) in message from ${message.author.username}`);

  await mirrorLinks(message, {
    tag: 'TikTok',
    urls: [...urls.values()],
    labels: { video: '🎬 TikTok video', photo: '📸 TikTok photo' },
    download: downloadVideo,
  });
}

async function downloadVideo(url, dlDir) {
  const args = [
    '--no-warnings',
    // TikTok serves the same clip as H.264 and H.265. Discord's desktop and
    // Android clients won't play H.265, and a file under the size cap goes out
    // untouched, so pick H.264 here rather than rely on the compressor.
    '-S', 'vcodec:h264',
    '-f', 'b[vcodec!=none]',
    '-o', path.join(dlDir, '%(id)s.%(ext)s'),
    url,
  ];

  try {
    await execFile('yt-dlp', args, { timeout: 90000 });
    return '❌ Nothing was downloaded from that TikTok link.';
  } catch (err) {
    const detail = String(err.stderr || err.message);
    // Slideshows, and short links to deleted posts (which redirect to the
    // home page). Neither has a video to mirror.
    if (/Unsupported URL|Requested format is not available/i.test(detail)) return null;
    console.error('[TikTok] yt-dlp failed:', detail.trim().split('\n').pop());
    return '❌ TikTok download failed — the post may be private, removed, or yt-dlp needs updating.';
  }
}

module.exports = { handleTikTokLinks };
