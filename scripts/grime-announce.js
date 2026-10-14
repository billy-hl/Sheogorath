#!/usr/bin/env node
'use strict';
/**
 * Posts a Grime & Punishment devlog's update notes in #announcements, as the
 * Town Crier: a heading, a few lines on what's new, and the video.
 *
 * The notes come from the game repo (devlog/make.py writes them to
 * build/devlog/SLUG/discord.json; devlog/announce.py there copies them over
 * and runs this). The YouTube watcher has usually posted the video itself by
 * then, so the link goes on the embed's title, not in the message, and Discord
 * doesn't show a second player.
 *
 * REST only, no gateway login.
 *
 *   node scripts/grime-announce.js NOTES.json --video=https://youtu.be/ID            # print what would be posted
 *   node scripts/grime-announce.js NOTES.json --video=https://youtu.be/ID --apply
 *
 * NOTES.json: { "title", "heading", "intro", "lines": [...], "outro" }
 */
require('dotenv').config();
const fs = require('fs');
const { REST, Routes, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../src/config/guilds');

const GUILD_ID = '1560039768845328394';
const APPLY = process.argv.includes('--apply');
const PARCHMENT_RED = 0xa8323e;

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const videoArg = process.argv.find((a) => a.startsWith('--video='))?.slice('--video='.length);

function videoId(url) {
  return /(?:youtu\.be\/|[?&]v=|\/shorts\/)([\w-]{11})/.exec(url || '')?.[1] || null;
}

(async () => {
  if (!file) return console.log('Usage: node scripts/grime-announce.js NOTES.json --video=URL [--apply]');
  const notes = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = videoId(videoArg);
  if (!id) return console.log(`Not a YouTube video link: ${videoArg || '(none: pass --video=URL)'}`);
  const url = `https://www.youtube.com/watch?v=${id}`;
  const where = getGuildConfig(GUILD_ID)?.youtube?.channel;
  if (!where) return console.log(`No youtube.channel (#announcements) in the config for ${GUILD_ID}.`);

  const lines = (notes.lines || []).map((l) => `• ${l}`).join('\n');
  const description = [notes.intro, lines, notes.outro, `▶ **[Watch it on YouTube](${url})**`]
    .filter(Boolean).join('\n\n');
  const embed = new EmbedBuilder()
    .setColor(PARCHMENT_RED)
    .setAuthor({ name: 'Hear ye! Hear ye!' })
    .setTitle(notes.heading || notes.title)
    .setURL(url)
    .setDescription(description)
    .setThumbnail(`https://img.youtube.com/vi/${id}/hqdefault.jpg`)
    .toJSON();

  console.log(`===== #announcements (${where}) =====\n${embed.author.name}\n${embed.title}\n${embed.url}\n\n${embed.description}`);
  if (embed.description.length > 4096) return console.log('\nToo long for an embed (4096 characters).');
  if (!APPLY) return console.log('\n(dry run: pass --apply to post)');
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const sent = await rest.post(Routes.channelMessages(where), {
    body: { embeds: [embed], allowed_mentions: { parse: [] } },
  });
  console.log(`\nPosted: https://discord.com/channels/${GUILD_ID}/${where}/${sent.id}`);
})().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
