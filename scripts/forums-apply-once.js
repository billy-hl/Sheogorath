'use strict';
/**
 * One-off runner for the forum setup that /forums normally drives.
 *
 * `plan()` is pure; `apply()` only runs when invoked with the literal argument
 * "apply". Same code path as the slash command, so nothing here can diverge
 * from what an admin running /forums apply would get.
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { plan, apply } = require('../src/services/forums/setup');
const { getGuildConfig } = require('../src/config/guilds');

const GUILD = process.env.FORUM_GUILD || '444601986160263189';
const DO_APPLY = process.argv[2] === 'apply';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(GUILD);
    await guild.channels.fetch();
    const config = getGuildConfig(GUILD);

    const p = plan(guild, config);
    console.log(`PLAN for ${guild.name}`);
    console.log('  blocked:', p.blocked.length ? p.blocked.join(' | ') : 'nothing');
    for (const s of p.steps) console.log(`  [${s.action}] ${s.spec.name} — ${s.detail}`);

    if (!DO_APPLY) {
      console.log('\n(dry run — pass "apply" to execute)');
      return;
    }
    if (p.blocked.length) {
      console.log('\nRefusing to apply while blocked.');
      return;
    }

    const r = await apply(guild, config);
    console.log('\nAPPLY');
    for (const line of r.results) console.log('  ' + line);
    for (const line of r.warnings) console.log('  WARN ' + line);
  } catch (err) {
    console.error('ERROR', err?.message || err);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
