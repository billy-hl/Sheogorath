'use strict';
/**
 * Sheogorath does commentary over a gameplay clip.
 *
 * He cannot watch video — Grok takes pictures, not footage — so he is shown a
 * handful of stills with the second each was taken at, and writes what he would
 * say over it as timed lines. Each line is spoken by ElevenLabs in his voice,
 * laid onto the clip at its time, and the game's own sound is pushed down under
 * him while he talks and comes back up when he stops. If he has more to say than
 * the clip has length, the last frame holds while he finishes.
 *
 * Cost per clip: one Grok call with the stills (metered by ai/budget.js like
 * every other) and a few hundred characters of ElevenLabs (capped per day in
 * ai/elevenlabs.js).
 */
const fs = require('fs');
const path = require('path');
const { getAIResponseWithImages } = require('../ai/grok');
const { speech, remaining } = require('../ai/elevenlabs');
const { withoutLengthRules, LORE } = require('../ai/persona');
const { scrub } = require('../ai/actions');

/** Longest clip worth narrating. Past this it is a VOD, not a clip. */
const MAX_SECONDS = 120;

/**
 * How far past the end he may keep talking, over a frozen last frame.
 *
 * More for a short clip than a long one: four seconds of someone dying is over
 * before a sentence about it is, and the freeze on the moment is the joke.
 */
function overrun(duration) {
  return duration < 12 ? 6 : 4;
}

/** How much he may say over a clip this long, in words. */
function wordBudget(duration) {
  return Math.min(110, Math.max(16, Math.round(duration * 1.8)));
}

/** Characters he may say over one clip, so one long clip cannot spend a day. */
const MAX_CHARACTERS = 700;

/** A pause between two of his lines, so they read as separate thoughts. */
const LINE_GAP = 0.25;

/**
 * When to take the stills, as fractions of the clip.
 *
 * Bunched toward the end, because a clip is what someone saved *after* the
 * moment happened: the button is pressed when the kill lands, so the first
 * half is usually the walk there and the last few seconds are the point.
 */
function stillTimes(duration) {
  const n = duration < 8 ? 4 : duration < 20 ? 6 : 8;
  return Array.from({ length: n }, (_, i) => {
    const x = 1 - Math.pow(1 - i / (n - 1), 1.6);
    return Math.min(duration - 0.1, Math.max(0, duration * (0.03 + 0.94 * x)));
  });
}

async function stills(source, duration, dir, run) {
  const out = [];
  for (const [i, at] of stillTimes(duration).entries()) {
    const file = path.join(dir, `still${i}.jpg`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', source,
      '-frames:v', '1', '-vf', "scale=w='min(1024,iw)':h=-2", '-q:v', '4', file], { timeout: 60000 });
    if (fs.existsSync(file)) out.push({ at, jpeg: fs.readFileSync(file) });
  }
  if (!out.length) throw new Error('could not take a single still from it');
  return out;
}

function brief({ poster, game, about, duration, words }) {
  const what = game ? `a ${game} clip` : 'a gameplay clip';
  return {
    system: `${withoutLengthRules()}\n\n${LORE}\n\nCOMMENTARY\n\n`
      + `You are doing commentary over ${what} that ${poster} posted in the server: the way a sports `
      + 'commentator, a nature documentary narrator, or a drill sergeant who has seen too much would, '
      + 'whichever suits what you see. What you write is spoken aloud in your own voice over the footage, '
      + "with the game's sound turned down underneath you.",
    prompt: 'Those are stills from the clip, in order. '
      + `It lasts ${duration.toFixed(1)} seconds.${about ? ` About the game: ${about}` : ''}\n\n`
      + 'First work out what happened. Read the screen the way a player would: a red or bloody screen '
      + 'is the player being hit, a screen telling them to call for help or bleed out means they went down, '
      + 'a menu or inventory means they stopped to rummage, a kill feed or hit marker means they hit someone, '
      + 'a scope means they were aiming at something, so say what. Never invent a kill, an enemy, a name '
      + 'or a scoreline you cannot see; when it is unclear what happened, that is the joke.\n\n'
      + 'Then write the commentary. This is you being entertaining, not captions: whole sentences, with '
      + `opinions, mockery or praise for ${poster}, who is the player, and your own madness in it.\n`
      + `- Between ${Math.round(words * 0.6)} and ${words} words in all. Usually a setup early on, something `
      + 'as it builds, and your verdict on the outcome at the end; a short clip can be one or two lines. '
      + 'Each line has a start time in seconds and takes about 0.4 seconds per word to say. Lines '
      + `must not overlap, and the last may run up to ${overrun(duration)} seconds past the end, where the `
      + 'picture freezes on the final moment.\n'
      + "- Leave some gaps. The game's own sound is half of it.\n"
      + '- Everything is spoken: no emoji, no asterisks, no stage directions, no action tags, no markdown. '
      + 'Write numbers and abbreviations the way they are said.\n'
      + '- Also a title for the post: six words at most, no quotation marks.\n\n'
      + 'Reply with only JSON: {"title": "...", "lines": [{"at": 0.5, "text": "..."}]}',
  };
}

/** Make a model's line safe to read aloud. */
function speakable(text) {
  return scrub(text)
    .replace(/\*[^*]*\*/g, ' ')                       // *stage directions*
    .replace(/\([^)]*\)/g, ' ')                       // (asides)
    .replace(/[\p{Extended_Pictographic}️]/gu, '') // emoji
    .replace(/[`#_~>|]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The model's JSON, checked and trimmed to what we will actually say. */
function parseScript(raw, duration) {
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('he had nothing to say about it');
  const data = JSON.parse(match[0]);

  const lines = [];
  let chars = 0;
  for (const line of Array.isArray(data.lines) ? data.lines : []) {
    const text = speakable(line?.text || '');
    const at = Number(line?.at);
    if (!text || !Number.isFinite(at)) continue;
    if (chars + text.length > MAX_CHARACTERS) break;
    chars += text.length;
    lines.push({ at: Math.min(Math.max(0, at), duration), text });
  }
  if (!lines.length) throw new Error('he had nothing to say about it');
  lines.sort((a, b) => a.at - b.at);

  const title = speakable(data.title || '').replace(/["“”]/g, '').slice(0, 80) || 'Commentary';
  return { title, lines, chars };
}

/**
 * Speak each line, then place it: at its own time, or straight after the line
 * before if that one is still going. Real speech never runs to the model's
 * 0.4-seconds-a-word guess, so the times are a request, not a schedule.
 */
async function voice(lines, dir, probe) {
  const placed = [];
  let free = 0;
  for (const [i, line] of lines.entries()) {
    const file = path.join(dir, `line${i}.mp3`);
    fs.writeFileSync(file, await speech(line.text));
    const { duration } = await probe(file).catch(() => ({ duration: line.text.split(/\s+/).length * 0.4 }));
    const at = Math.max(line.at, free);
    placed.push({ ...line, file, at, seconds: duration });
    free = at + duration + LINE_GAP;
  }
  return placed;
}

/** How long a spoken line runs. clips.probe() insists on a picture; an mp3 has none. */
function audioProbe(run) {
  return async (file) => {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeout: 30000 });
    return { duration: Number(stdout.trim()) || 0 };
  };
}

/**
 * The filter graph: picture scaled to at most 1080p and frozen at the end if he
 * runs over; his lines delayed to their times and mixed into one track; the
 * game's sound padded to length and compressed whenever that track is speaking.
 */
function graph({ info, placed, seconds }) {
  const freeze = Math.max(0, seconds - info.duration);
  const fps = info.fps > 61 ? ',fps=60' : '';
  const video = `[0:v]scale=w='min(1920,iw)':h=-2,setsar=1${fps}`
    + `${freeze > 0 ? `,tpad=stop_mode=clone:stop_duration=${freeze.toFixed(3)}` : ''}[v]`;

  const lines = placed.map((l, i) =>
    `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=1.6,adelay=${Math.round(l.at * 1000)}:all=1[l${i}]`);
  const together = placed.length > 1
    ? `${placed.map((_, i) => `[l${i}]`).join('')}amix=inputs=${placed.length}:normalize=0:duration=longest,`
    : '[l0]';
  const narration = `${together}apad,atrim=0:${seconds.toFixed(3)},asplit=2[nsc][nmix]`;

  const game = info.hasAudio
    ? `[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${seconds.toFixed(3)}[g]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${seconds.toFixed(3)}[g]`;
  const duck = '[g][nsc]sidechaincompress=threshold=0.015:ratio=14:attack=15:release=450[duck]';
  const mix = '[duck][nmix]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]';

  return [video, ...lines, narration, game, duck, mix].join(';');
}

/**
 * Narrate one clip. Called by services/clips.js with the clip already on disk.
 * @returns {Promise<{file: string, name: string, content: string, script: object}>}
 */
async function make({ source, info, dir, poster, game, about, budgetMB }) {
  const { run, encode } = require('./clips');
  if (info.duration > MAX_SECONDS) throw new Error(`that runs over ${MAX_SECONDS / 60} minutes; he only narrates clips`);
  if (remaining() < 120) throw new Error('his voice is spent for today; try again tomorrow');

  const words = wordBudget(info.duration);
  const shots = await stills(source, info.duration, dir, run);
  const { system, prompt } = brief({ poster, game, about, duration: info.duration, words });
  const raw = await getAIResponseWithImages(prompt, shots.map(({ at, jpeg }) => ({
    caption: `Still at ${at.toFixed(1)}s:`, jpeg,
  })), { rawSystemPrompt: system, maxTokens: 900 });

  const script = parseScript(raw, info.duration);
  console.log(`[Commentary] "${script.title}": ${script.lines.length} line(s), ${script.chars} characters`);

  const placed = await voice(script.lines, dir, audioProbe(run));
  const spoken = placed[placed.length - 1].at + placed[placed.length - 1].seconds;
  const seconds = Math.max(info.duration, Math.min(spoken + 0.6, info.duration + overrun(info.duration) + 3));

  const out = path.join(dir, 'commentary.mp4');
  await encode({
    inputs: ['-i', source, ...placed.flatMap((l) => ['-i', l.file])],
    filter: graph({ info, placed, seconds }),
    audio: true,
    seconds,
    budgetMB,
    out,
  });

  return {
    file: out,
    name: 'sheogorath-commentary.mp4',
    content: `🎙️ **${script.title}**\n-# Sheogorath on ${poster}'s clip`,
    script,
  };
}

module.exports = { make, parseScript, stillTimes, speakable, graph };
