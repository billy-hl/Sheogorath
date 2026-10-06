'use strict';
/**
 * The Wabbajack, pointed at a clip: it comes back as something else.
 *
 * Which something is chosen at random, as the staff would have it, from the
 * effects below. Each is an ffmpeg filter recipe and nothing more — no model
 * call, no cost but a minute of the server's time — so it is the thing in this
 * bot people can use as often as they like.
 *
 * Every effect works from at most the last `TAKE_SECONDS` of the clip: a clip is
 * saved after the moment, so the end is where the moment is.
 */
const path = require('path');

const TAKE_SECONDS = 40;

/**
 * What the staff can do.
 *
 *   video   filters after the picture is scaled to at most 720p. May branch with
 *           labels of its own, so long as it ends on a single stream.
 *   audio   filters for the sound. `SR` is replaced with its sample rate.
 *   speed   how much longer (>1) or shorter (<1) it plays than the source.
 *   fps     the frame rate it comes out at, when the effect needs a particular one.
 *   take    seconds of source to use, when it needs fewer than the default.
 *   kbps    a video bitrate to hold it to, when it is meant to look bad.
 */
const EFFECTS = [
  {
    name: 'Skooma Dreams',
    blurb: 'everything trails, the colours will not sit still, and the sound comes back from somewhere it should not',
    video: 'lagfun=decay=0.94,hue=H=2*PI*t/3:s=2',
    audio: 'aecho=0.8:0.85:140|280:0.5|0.3,vibrato=f=2.5:d=0.35',
  },
  {
    name: 'The Greymarch',
    blurb: 'Jyggalag has tidied it. No colour, perfect symmetry, and a voice with nothing left in it',
    video: 'hue=s=0,crop=trunc(iw/4)*2:ih:0:0,split[gl][gr];[gr]hflip[gf];[gl][gf]hstack',
    audio: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
  },
  {
    name: 'Mania',
    blurb: 'faster, brighter, higher, and very pleased about all of it',
    video: 'setpts=PTS/1.6,eq=saturation=2.6:contrast=1.15',
    audio: 'asetrate=SR*1.6,aresample=SR',
    speed: 1 / 1.6,
  },
  {
    name: 'Dementia',
    blurb: 'the picture is inside out and the sound is running the other way',
    video: 'negate,eq=saturation=0.6',
    audio: 'areverse,aecho=0.8:0.8:400:0.3',
  },
  {
    name: 'Cooked by Mehrunes Dagon',
    blurb: 'deep-fried in the Deadlands until crisp',
    video: 'eq=saturation=3.2:contrast=1.9:brightness=0.07,unsharp=7:7:3,noise=alls=30:allf=t',
    audio: 'volume=8,acrusher=bits=5:mode=log:aa=1,alimiter=limit=0.8',
    kbps: 700,
  },
  {
    name: 'Time, Wound Back',
    blurb: 'played backwards, so whatever happened has now un-happened',
    video: 'fps=30,reverse',
    audio: 'areverse',
    fps: 30,
    take: 25,
  },
  {
    name: 'Cyrodilic Brandy',
    blurb: 'three bottles in: the floor is moving and so is everyone\'s voice',
    video: 'setpts=PTS*1.15,rotate=a=0.07*sin(2*PI*t/1.8):fillcolor=black,crop=trunc(iw*0.43)*2:trunc(ih*0.43)*2',
    audio: 'asetrate=SR/1.15,aresample=SR,vibrato=f=1.3:d=0.7,aecho=0.8:0.7:90:0.35',
    speed: 1.15,
  },
  {
    name: 'Arena, 1994',
    blurb: 'remastered for a machine with four megabytes of memory',
    video: 'scale=320:-2:flags=neighbor,fps=15,scale=1280:-2:flags=neighbor',
    audio: 'acrusher=bits=8:samples=8:mode=lin:aa=0,highpass=f=300,lowpass=f=3500',
    fps: 15,
  },
  {
    name: "Molag Bal's Tantrum",
    blurb: 'the ground will not stop shaking and the bass will not stop either',
    video: 'crop=iw-80:ih-80:40+38*sin(t*41):40+38*cos(t*29)',
    audio: 'bass=g=18:f=90,volume=2,alimiter=limit=0.85',
  },
  {
    name: 'Cheese for Everyone',
    blurb: 'the world is cheese now, and everyone in it is rather squeaky',
    video: 'colorchannelmixer=rr=1:rg=0.25:gr=0.2:gg=0.9:br=0:bg=0.05:bb=0.15,vignette=PI/4',
    audio: 'asetrate=SR*1.4,aresample=SR,atempo=0.714',
  },
];

/**
 * The effect last used on each person's clips, so pointing the staff at the
 * same person twice never does the same thing twice running.
 */
const lastUsed = new Map();

function pick(personId) {
  const options = EFFECTS.filter((e) => e.name !== lastUsed.get(personId));
  const effect = options[Math.floor(Math.random() * options.length)];
  lastUsed.set(personId, effect.name);
  return effect;
}

/** The filter graph for one effect on one clip. */
function graph(effect, info) {
  const fps = effect.fps || Math.min(60, Math.round(info.fps / (effect.speed || 1)) || 30);
  const video = `[0:v]scale=w='min(1280,iw)':h=-2,setsar=1,${effect.video},fps=${fps},format=yuv420p[v]`;
  if (!info.hasAudio) return { filter: video, audio: false };
  const audio = `[0:a]${effect.audio.replace(/SR/g, String(info.sampleRate))}[a]`;
  return { filter: `${video};${audio}`, audio: true };
}

/**
 * Wabbajack one clip. Called by services/clips.js with the clip already on disk.
 * `effectName` forces a particular effect, for testing them one by one.
 */
async function make({ source, info, dir, poster, posterId, by, budgetMB, effectName = null }) {
  const { encode } = require('./clips');
  const effect = effectName ? EFFECTS.find((e) => e.name === effectName) : pick(posterId);
  if (!effect) throw new Error(`no effect called ${effectName}`);

  const take = Math.min(info.duration, effect.take || TAKE_SECONDS);
  const start = Math.max(0, info.duration - take);
  const seconds = take * (effect.speed || 1);
  const { filter, audio } = graph(effect, info);

  const out = path.join(dir, 'wabbajacked.mp4');
  await encode({
    inputs: ['-ss', start.toFixed(3), '-t', take.toFixed(3), '-i', source],
    filter, audio, seconds, budgetMB, out,
    videoKbps: effect.kbps || null,
    maxVideoKbps: 6000,
  });

  const whose = by && by !== posterId ? `${poster}'s clip, at <@${by}>'s hand` : `${poster}'s clip`;
  return {
    file: out,
    name: 'wabbajacked.mp4',
    content: `🌀 **${effect.name}**: ${effect.blurb}.\n-# The Wabbajack, pointed at ${whose}`,
    effect: effect.name,
  };
}

module.exports = { make, EFFECTS, graph };
