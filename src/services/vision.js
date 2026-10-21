'use strict';
/**
 * The pictures in front of him, for the turns that have any.
 *
 * He used to be handed "[1 attachment(s)]" and nothing else, and he filled the
 * gap both ways a model does. Asked if he could see what people posted, he said
 * he had "beheld the images you and the others have shared" — he had not.
 * Shown somebody's photo another time, he broke character to explain that "as a
 * text-based AI" he could not view images, then guessed at what it was anyway.
 * Grok can see; the bytes simply never reached it.
 *
 * Which pictures count is the question this file answers. Not the room's — a
 * hundred messages of memes on every reply would cost more than the rest of the
 * prompt together, and most replies are not about them. Only the pictures the
 * person is plainly talking about:
 *
 *   1. the ones on the message he is answering
 *   2. the ones on the message they are replying to
 *   3. failing both, what they posted themselves just before naming him — the
 *      "post the screenshot, then ask" pattern, which arrives as two messages
 *   4. failing that, the picture somebody else posted just before, when their
 *      words point at something ("rate this", "what's that")
 *
 * Everything is fetched from Discord's own CDN and re-encoded through ffmpeg
 * before it is sent: Grok takes JPEG and PNG, and the room posts WebP, GIF and
 * phone photos four thousand pixels wide.
 */
const { spawn } = require('child_process');
const axios = require('axios');

/** More than this is a gallery, not a question, and every one is billed. */
const MAX_IMAGES = 4;

/** Long edge after scaling. Enough to read an error dialog in a screenshot. */
const MAX_EDGE = 1568;

/** Discord's own upload ceiling for an unboosted server is 10 MB; xAI's is 20. */
const MAX_BYTES = 20 * 1024 * 1024;

/** How far back "the thing they posted just before" may reach. */
const RECENT_MS = 3 * 60 * 1000;

/** Words that point at a picture rather than past one. */
const POINTING = /\b(this|that|these|those|pic|pics|picture|image|photo|screenshot|meme|look|rate)\b/i;

/**
 * Asking where a picture came from, rather than what is in it.
 *
 * Bought per question, the way the deep transcript is: a lookup is a web
 * search on top of the tokens, and most pictures are posted to be laughed at,
 * not traced.
 */
const LOOKUP_PATTERN =
  /\b(reverse (image )?(search|lookup|look ?up)|(sauce|source)\s*(\?|$|pls|please|plz|(on|of|for) (this|that|it))|what('?s| is) the (sauce|source)|where('?s| is| does| did)? (this|that|it)( \w+)? (from|come from|originally)|where (did|does) (this|that|it) come from|original (post|artist|image|pic)|who (made|drew|painted|took|created) (this|that|it)|find (where|the original)|what (game|film|movie|show|anime|meme) is (this|that))/i;

/** Whether the person is asking him to trace a picture. */
function wantsLookup(text) {
  return LOOKUP_PATTERN.test(text || '');
}

/** Only Discord's hosts are fetched — an embed's own URL can point anywhere. */
function isDiscordUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && /(^|\.)(discordapp\.(com|net)|discord\.com)$/.test(hostname);
  } catch {
    return false;
  }
}

/** What kind of thing an attachment is, from its type or, failing that, its name. */
function kindOf(att) {
  const type = att.contentType || '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(att.name || '')) return 'image';
  if (/\.(mp4|mov|webm|mkv)$/i.test(att.name || '')) return 'video';
  return 'file';
}

/**
 * Every picture on one message, plus what it carried that he cannot look at.
 *
 * Embeds count when they bring an image — a pasted link to one, a Tenor GIF's
 * still — but they are often added a moment after the message itself arrives,
 * so a fresh message's link may not have one yet. The replied-to message, being
 * older, nearly always does.
 */
function picturesOn(msg) {
  const pictures = [];
  const unseen = [];
  for (const att of msg.attachments?.values?.() || []) {
    const kind = kindOf(att);
    if (kind === 'image' && att.size <= MAX_BYTES && isDiscordUrl(att.url)) {
      pictures.push({ url: att.url, name: att.name, spoiler: !!att.spoiler });
    } else {
      unseen.push(`${kind === 'image' ? 'an image too large to open' : `a ${kind}`} (${att.name})`);
    }
  }
  for (const embed of msg.embeds || []) {
    const url = embed.image?.proxyURL || embed.thumbnail?.proxyURL;
    if (url && isDiscordUrl(url)) pictures.push({ url, name: embed.title || 'linked image', spoiler: false });
  }
  return { pictures, unseen };
}

/** Run ffmpeg over a buffer and collect what it writes. */
function ffmpeg(args, input, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').pop() || 'no output'}`));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}

/**
 * Bytes in, something Grok will take out: the first frame, no wider than
 * MAX_EDGE. A JPEG stays a JPEG. Everything else becomes a PNG, because a
 * transparent sticker or meme flattened to JPEG turns black-on-black.
 *
 * Animated WebP is the one format this ffmpeg cannot decode; it comes back as
 * null and is reported as a picture that would not open.
 */
async function normalise(data, contentType) {
  const jpeg = /jpe?g/i.test(contentType || '');
  const scale = `scale='min(${MAX_EDGE},iw)':'min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease`;
  try {
    const out = await ffmpeg([
      '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', scale,
      '-c:v', jpeg ? 'mjpeg' : 'png', ...(jpeg ? ['-q:v', '3'] : []), '-f', 'image2pipe', 'pipe:1',
    ], data);
    return { mime: jpeg ? 'image/jpeg' : 'image/png', data: out };
  } catch (err) {
    console.warn('[Vision] Could not re-encode an image:', err.message);
    return null;
  }
}

async function fetchPicture(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: MAX_BYTES,
  });
  return normalise(Buffer.from(res.data), res.headers['content-type']);
}

/**
 * The messages just before this one, from the cache the transcript fetch has
 * already filled — so looking back costs nothing extra on the ordinary turn.
 */
function recentBefore(message) {
  const cutoff = message.createdTimestamp - RECENT_MS;
  return [...(message.channel.messages?.cache?.values?.() || [])]
    .filter((m) => m.id !== message.id
      && m.createdTimestamp < message.createdTimestamp
      && m.createdTimestamp >= cutoff
      && !m.author?.bot)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
}

/**
 * The pictures this turn is about, ready to be shown.
 *
 * @param {import('discord.js').Message} message the message being answered
 * @param {object} opts
 * @param {import('discord.js').Message[]} [opts.sources] every message whose
 *   words make up the question — several, for a #help burst
 * @param {string} [opts.text] what was asked, for the pointing check
 * @returns {Promise<{ images: Array<{caption: string, mime: string, data: Buffer}>, note: string }>}
 */
async function picturesFor(message, { sources = [message], text = '' } = {}) {
  const found = [];
  const unseen = [];
  const take = (msg, where) => {
    const { pictures, unseen: missed } = picturesOn(msg);
    for (const p of pictures) found.push({ ...p, where });
    unseen.push(...missed);
    return pictures.length;
  };

  for (const msg of sources) take(msg, 'attached to their message');

  if (message.reference?.messageId) {
    const target = message.channel.messages.cache.get(message.reference.messageId)
      || await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (target) {
      const by = target.author?.id === message.client.user.id ? 'you' : (target.member?.displayName || target.author?.username);
      take(target, `on the message they are replying to (posted by ${by})`);
    }
  }

  if (!found.length && !message.reference?.messageId) {
    const recent = recentBefore(message);
    const own = recent.find((m) => m.author.id === message.author.id && picturesOn(m).pictures.length);
    if (own) {
      take(own, 'posted by them just before this message');
    } else if (POINTING.test(text)) {
      // Only the last few lines: "rate this" is about what is on screen, not
      // about a picture from two conversations ago.
      const other = recent.slice(0, 3).find((m) => picturesOn(m).pictures.length);
      if (other) {
        take(other, `posted by ${other.member?.displayName || other.author.username} just before — `
          + 'they may or may not mean this one');
      }
    }
  }

  const chosen = found.slice(0, MAX_IMAGES);
  const loaded = await Promise.all(chosen.map((p) => fetchPicture(p.url).catch((err) => {
    console.warn(`[Vision] Could not fetch ${p.name}:`, err.message);
    return null;
  })));

  const images = [];
  chosen.forEach((p, i) => {
    if (!loaded[i]) {
      unseen.push(`an image that would not open (${p.name})`);
      return;
    }
    images.push({
      caption: `[Image ${images.length + 1}, ${p.where}${p.spoiler ? ' — marked as a SPOILER, so do not give away what it shows unless they ask' : ''}]:`,
      ...loaded[i],
    });
  });
  if (found.length > MAX_IMAGES) unseen.push(`${found.length - MAX_IMAGES} more image(s) past the first ${MAX_IMAGES}`);

  if (images.length) console.log(`[Vision] Showing ${images.length} image(s) to him for ${message.author.username}`);

  const note = unseen.length
    ? `[Also attached, which you CANNOT see: ${unseen.join('; ')}. Do not describe or guess at what is in `
      + `them — say you could not look, if it matters]:\n`
    : '';
  return { images, note };
}

module.exports = { picturesFor, wantsLookup, normalise, MAX_IMAGES };
