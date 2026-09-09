#!/usr/bin/env node
'use strict';
/**
 * One-off runner for the AutoMod baseline that /automod baseline normally
 * drives. Same code path as the slash command, so nothing here can diverge from
 * what an admin running it in Discord would get.
 *
 *   node scripts/automod-apply-once.js <guildId>            # preview
 *   node scripts/automod-apply-once.js <guildId> --apply
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { applyBaseline } = require('../src/services/automod');

const GUILD = process.argv.find((a) => /^\d{17,20}$/.test(a)) || '1547233037765578822';
const APPLY = process.argv.includes('--apply');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(GUILD);
    const { results, alertChannel, exemptRoles } = await applyBaseline(guild, { dryRun: !APPLY });
    console.log(`AutoMod baseline for ${guild.name}${APPLY ? '' : ' (preview)'}`);
    for (const r of results) console.log(`  [${r.action}] ${r.name} — ${r.detail}`);
    console.log(`  alerts -> ${alertChannel || 'nowhere'}, exempt roles: ${exemptRoles.join(', ') || 'none'}`);
    if (!APPLY) console.log('\n(preview — pass --apply to execute)');
  } catch (err) {
    console.error(err); process.exitCode = 1;
  } finally { await client.destroy(); }
});

client.login(process.env.DISCORD_TOKEN);
