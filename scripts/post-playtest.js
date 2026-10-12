#!/usr/bin/env node
'use strict';
/**
 * Posts the playtest agreement (services/playtest.js) in the guild's
 * `playtest.post` channel and pins it.
 *
 * Once is enough: the button carries no message ID and nothing is kept in
 * memory, so the posted message keeps working across restarts. Run it again
 * only to replace a deleted post, or after changing its wording (then delete
 * the old one by hand).
 *
 * REST only, no gateway login: posting needs nothing the live bot is doing.
 *
 *   node scripts/post-playtest.js <guildId>            # what would be posted, and where
 *   node scripts/post-playtest.js <guildId> --apply
 */
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { getGuildConfig } = require('../src/config/guilds');
const { buildMessage } = require('../src/services/playtest');

const GUILD = process.argv.find((a) => /^\d{17,20}$/.test(a));
const APPLY = process.argv.includes('--apply');

(async () => {
  if (!GUILD) return console.log('Which guild? node scripts/post-playtest.js <guildId> [--apply]');
  const cfg = getGuildConfig(GUILD)?.playtest;
  if (!cfg) return console.log(`No playtest block for ${GUILD} in config/guilds.json.`);
  if (!cfg.post) return console.log('No playtest.post channel to post in.');

  const msg = buildMessage(GUILD);
  const body = { embeds: msg.embeds.map((e) => e.toJSON()), components: msg.components.map((c) => c.toJSON()) };
  console.log(`Posting in ${cfg.post}:\n${JSON.stringify(body.embeds[0], null, 2)}`);
  if (!APPLY) return console.log('\n(Dry run. Add --apply to post it.)');

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const posted = await rest.post(Routes.channelMessages(cfg.post), { body });
  console.log(`Posted: ${posted.id}`);
  try {
    await rest.put(Routes.channelPin(cfg.post, posted.id), { reason: 'The playtest agreement' });
    console.log('Pinned.');
  } catch (err) {
    console.log(`Not pinned (${err.message}): pin it by hand.`);
  }
})().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
