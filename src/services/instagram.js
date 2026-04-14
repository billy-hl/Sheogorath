const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');

// Rate limit: max 3 downloads per channel per 60 seconds
const channelCooldowns = new Map();
const MAX_DOWNLOADS = 3;
const COOLDOWN_MS = 60000;

function checkRateLimit(channelId) {
  const now = Date.now();
  if (!channelCooldowns.has(channelId)) {
    channelCooldowns.set(channelId, []);
  }
  const timestamps = channelCooldowns.get(channelId).filter(t => now - t < COOLDOWN_MS);
  channelCooldowns.set(channelId, timestamps);
  if (timestamps.length >= MAX_DOWNLOADS) return false;
  timestamps.push(now);
  return true;
}

/**
 * Download and send an Instagram video from a message containing an Instagram URL.
 * Handles compression if the video exceeds Discord's 24MB upload limit.
 * @param {import('discord.js').Message} message - The Discord message containing Instagram URLs
 */
async function handleInstagramLinks(message) {
  const instagramRegex = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/gi;
  const matches = message.content.match(instagramRegex);
  if (!matches) return;

  // Create temp directory if it doesn't exist
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  for (const url of matches) {
    // Check rate limit before downloading
    if (!checkRateLimit(message.channel.id)) {
      console.log(`Instagram rate limit hit in channel ${message.channel.id}`);
      return;
    }

    try {
      await message.channel.sendTyping();

      const outputPath = path.join(TEMP_DIR, `instagram_${Date.now()}.mp4`);

      console.log(`Downloading Instagram video from: ${url}`);

      const { stdout, stderr } = await exec(
        `yt-dlp --no-check-certificate --age-limit 99 --cookies-from-browser chrome -o "${outputPath}" "${url}"`
      );

      if (stdout) console.log('yt-dlp stdout:', stdout);
      if (stderr) console.log('yt-dlp stderr:', stderr);

      if (!fs.existsSync(outputPath)) {
        console.error('Video file not found after download');
        continue;
      }

      const fileSizeMB = fs.statSync(outputPath).size / (1024 * 1024);
      let finalPath = outputPath;

      // Compress if over Discord's 24MB limit
      if (fileSizeMB > 24) {
        const compressedPath = outputPath.replace('.mp4', '_compressed.mp4');
        finalPath = await compressVideo(outputPath, compressedPath, message);
        if (!finalPath) {
          cleanup(outputPath, compressedPath);
          continue;
        }
      }

      // Send the video
      try {
        await message.reply({
          content: `🎬 Here's the Instagram video from ${message.author}:`,
          files: [finalPath],
        });
        console.log('✅ Instagram video sent successfully');
      } catch (sendError) {
        console.log('❌ Failed to send video:', sendError.message);
        const perms = message.channel.permissionsFor(message.guild.members.me);
        if (!perms.has('AttachFiles')) {
          try {
            await message.reply('❌ I need the **Attach Files** permission to send videos here!');
          } catch (e) { /* ignore */ }
        }
      }

      // Clean up temp files
      cleanup(outputPath, outputPath.replace('.mp4', '_compressed.mp4'));
    } catch (error) {
      console.error('Instagram download error:', error.message || error);
    }
  }
}

/**
 * Compress a video to fit under Discord's upload limit.
 * @returns {string|null} Path to the compressed file, or null on failure
 */
async function compressVideo(inputPath, outputPath, message) {
  try {
    await message.channel.send('⏳ Video is large, compressing...');
  } catch (e) { /* ignore */ }

  try {
    // Get video duration
    const { stdout: probeOut } = await exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    );
    const duration = parseFloat(probeOut.trim()) || 60;

    // Calculate bitrate to fit in ~23MB
    const targetSizeKbits = 23 * 8 * 1024;
    const audioBitrate = 128;
    const videoBitrate = Math.floor(targetSizeKbits / duration - audioBitrate);

    if (videoBitrate < 100) {
      try { await message.reply('❌ Video is too long to compress under 24MB.'); } catch (e) { /* ignore */ }
      return null;
    }

    console.log(`Compressing: duration=${duration}s, target video bitrate=${videoBitrate}k`);

    await exec(
      `ffmpeg -i "${inputPath}" -b:v ${videoBitrate}k -b:a ${audioBitrate}k ` +
      `-vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2" ` +
      `-y "${outputPath}"`,
      { timeout: 120000 }
    );

    if (!fs.existsSync(outputPath)) return null;

    const compressedSizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    console.log(`Compressed: ${(fs.statSync(inputPath).size / (1024 * 1024)).toFixed(2)}MB → ${compressedSizeMB.toFixed(2)}MB`);

    if (compressedSizeMB > 24) {
      try { await message.reply('❌ Video is still too large after compression.'); } catch (e) { /* ignore */ }
      return null;
    }

    return outputPath;
  } catch (err) {
    console.error('Compression failed:', err.message);
    try { await message.reply('❌ Failed to compress the video.'); } catch (e) { /* ignore */ }
    return null;
  }
}

function cleanup(...paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
}

module.exports = { handleInstagramLinks };
