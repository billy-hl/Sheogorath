'use strict';
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { GuildPremiumTier } = require('discord.js');

const COOKIES_FILE = path.join(__dirname, '..', '..', 'www.instagram.com_cookies.txt');
const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');

/**
 * Discord's per-message attachment cap, by boost tier.
 *
 * This used to be a flat 24MB, which was right back when unboosted guilds got
 * 25MB. Discord since cut the free tier to 10MB, so every reel between 10 and
 * 24MB sailed past the compression check and was then rejected on upload with
 * "Request entity too large" — the download worked, nothing was ever posted,
 * and the failure only showed up in the console.
 */
const UPLOAD_LIMIT_MB = {
  [GuildPremiumTier.None]: 10,
  [GuildPremiumTier.Tier1]: 10,
  [GuildPremiumTier.Tier2]: 50,
  [GuildPremiumTier.Tier3]: 100,
};

/**
 * Bytes we can actually spend on the file. The cap covers the whole multipart
 * body, not just the attachment, so keep half a megabyte back for the envelope
 * rather than aiming at the limit exactly and losing the odd upload to it.
 */
function uploadBudgetMB(guild) {
  const limit = UPLOAD_LIMIT_MB[guild?.premiumTier] || UPLOAD_LIMIT_MB[GuildPremiumTier.None];
  return limit - 0.5;
}

// Rate limit: max 3 downloads per channel per 60 seconds
const channelCooldowns = new Map();
const MAX_DOWNLOADS = 3;
const COOLDOWN_MS = 60000;

function checkRateLimit(channelId) {
  const now = Date.now();
  if (!channelCooldowns.has(channelId)) channelCooldowns.set(channelId, []);
  const timestamps = channelCooldowns.get(channelId).filter(t => now - t < COOLDOWN_MS);
  channelCooldowns.set(channelId, timestamps);
  if (timestamps.length >= MAX_DOWNLOADS) return false;
  timestamps.push(now);
  return true;
}

/**
 * Download Instagram post (photo or video) using gallery-dl.
 */
async function handleInstagramLinks(message) {
  const instagramRegex = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/gi;
  const matches = message.content.match(instagramRegex);
  if (!matches) return;

  console.log(`[Instagram] Detected ${matches.length} Instagram link(s) in message from ${message.author.username}`);

  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  for (const url of matches) {
    if (!checkRateLimit(message.channel.id)) {
      console.log(`[Instagram] Rate limit hit in channel ${message.channel.id} — skipping ${url}`);
      try { await message.reply('⏳ Instagram rate limit: max 3 downloads per minute in this channel.'); } catch { /* ignore */ }
      return;
    }

    try {
      await message.channel.sendTyping();

      const cookieArg = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
      const dlDir = path.join(TEMP_DIR, `ig_${Date.now()}`);
      fs.mkdirSync(dlDir, { recursive: true });

      console.log(`[Instagram] Downloading: ${url}`);

      try {
        await exec(`gallery-dl ${cookieArg} -D "${dlDir}" "${url}"`, { timeout: 60000 });
      } catch (dlErr) {
        // gallery-dl may exit non-zero even on partial success; check if files landed
        const files = fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : [];
        if (files.length === 0) {
          console.error('[Instagram] gallery-dl failed:', dlErr.message.split('\n')[0]);
          try { await message.reply('❌ Instagram download failed — the post may be private or cookies need refreshing.'); } catch { /* ignore */ }
          fs.rmSync(dlDir, { recursive: true, force: true });
          continue;
        }
      }

      const files = fs.readdirSync(dlDir).map(f => path.join(dlDir, f));
      if (files.length === 0) {
        try { await message.reply('❌ Nothing was downloaded from that Instagram link.'); } catch { /* ignore */ }
        fs.rmSync(dlDir, { recursive: true, force: true });
        continue;
      }

      // Send each file (Discord accepts images + videos)
      const videoExts = ['.mp4', '.mov', '.webm', '.mkv'];
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      const budgetMB = uploadBudgetMB(message.guild);

      for (const filePath of files) {
        const ext = path.extname(filePath).toLowerCase();
        const sizeMB = fs.statSync(filePath).size / (1024 * 1024);
        const isVideo = videoExts.includes(ext);
        const isImage = imageExts.includes(ext);

        if (!isVideo && !isImage) {
          console.log(`[Instagram] Skipping unknown file type: ${ext}`);
          continue;
        }

        let finalPath = filePath;

        if (sizeMB > budgetMB && isVideo) {
          const compressedPath = filePath.replace(ext, '_c.mp4');
          finalPath = await compressVideo(filePath, compressedPath, message, budgetMB) || null;
          if (!finalPath) continue;
        } else if (sizeMB > budgetMB) {
          try {
            await message.reply(`❌ File too large to send (${sizeMB.toFixed(1)}MB, limit is ${budgetMB.toFixed(1)}MB here).`);
          } catch { /* ignore */ }
          continue;
        }

        const label = isVideo ? `🎬 Instagram video from ${message.author}:` : `📸 Instagram photo from ${message.author}:`;

        try {
          await message.reply({ content: label, files: [finalPath] });
          console.log(`[Instagram] Sent ${isVideo ? 'video' : 'photo'}: ${path.basename(finalPath)}`);
        } catch (sendErr) {
          const finalSizeMB = fs.statSync(finalPath).size / (1024 * 1024);
          console.error(`[Instagram] Send failed (${finalSizeMB.toFixed(1)}MB):`, sendErr.message);
          // Say something in-channel. A silent console-only failure is how the
          // 24MB/10MB mismatch went unnoticed for weeks.
          try { await message.reply('❌ Grabbed that one, but Discord refused the upload.'); } catch { /* ignore */ }
        }
      }

      fs.rmSync(dlDir, { recursive: true, force: true });
    } catch (error) {
      console.error('[Instagram] Unexpected error:', error.message);
    }
  }
}

async function compressVideo(inputPath, outputPath, message, budgetMB) {
  try { await message.channel.send('⏳ Video is large, compressing...'); } catch { /* ignore */ }
  try {
    const { stdout: probeOut } = await exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    );
    const duration = parseFloat(probeOut.trim()) || 60;
    const targetSizeKbits = budgetMB * 8 * 1024;
    // A 10MB budget doesn't leave much for audio on a long reel; spend less on
    // it there so the video track keeps a usable share.
    const audioBitrate = budgetMB > 24 ? 128 : 96;
    const videoBitrate = Math.floor(targetSizeKbits / duration - audioBitrate);
    if (videoBitrate < 100) {
      try {
        await message.reply(`❌ Video is too long to compress under ${budgetMB.toFixed(1)}MB.`);
      } catch { /* ignore */ }
      return null;
    }
    // At the bitrates a 10MB budget implies, 720p just smears; drop to 480p
    // rather than spending every bit on blocking artifacts.
    const maxDim = videoBitrate < 600 ? [854, 480] : [1280, 720];
    await exec(
      `ffmpeg -i "${inputPath}" -b:v ${videoBitrate}k -b:a ${audioBitrate}k ` +
      `-vf "scale='min(${maxDim[0]},iw)':'min(${maxDim[1]},ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2" ` +
      `-y "${outputPath}"`,
      { timeout: 120000 }
    );
    if (!fs.existsSync(outputPath)) return null;
    const compressedSizeMB = fs.statSync(outputPath).size / (1024 * 1024);
    if (compressedSizeMB > budgetMB) {
      try { await message.reply('❌ Video still too large after compression.'); } catch { /* ignore */ }
      return null;
    }
    return outputPath;
  } catch (err) {
    console.error('[Instagram] Compression failed:', err.message);
    return null;
  }
}

module.exports = { handleInstagramLinks };
