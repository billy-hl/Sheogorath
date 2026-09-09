#!/usr/bin/env node
'use strict';
/**
 * Asks the people who joined before the faction prompt existed to pick one.
 *
 * Onboarding only runs for new arrivals, and Discord has no way to send an
 * existing member back through it — so everyone already in the guild when the
 * faction question went up has no team and no prompt telling them to get one.
 *
 * Mentions rather than a broadcast: an @everyone would reach the people who
 * already picked, and the ones who need this are a shrinking list. Re-run it as
 * that list shrinks; it only ever names who is still missing.
 *
 *   node scripts/faction-nudge.js                # who would be pinged
 *   node scripts/faction-nudge.js --apply
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { getGuildConfig } = require('../src/config/guilds');

const GUILD = process.argv.find((a) => /^\d{17,20}$/.test(a)) || '1547233037765578822';
const APPLY = process.argv.includes('--apply');
const TARGET = 'general';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(GUILD);
    await guild.channels.fetch();
    await guild.roles.fetch();

    const cfg = getGuildConfig(GUILD);
    const teams = (cfg.selfRoles || []).filter((r) => r.group === 'team');
    if (!teams.length) return console.log('No team roles configured.');

    const members = await guild.members.fetch();
    const missing = members.filter((m) => !m.user.bot && !teams.some((t) => m.roles.cache.has(t.role)));
    const rolesChannel = cfg.channels.selfRoles;
    const channel = guild.channels.cache.find((c) => c.name === TARGET);
    if (!channel) return console.log(`No #${TARGET} channel.`);

    console.log(`${missing.size} of ${members.filter((m) => !m.user.bot).size} humans have no faction.`);
    for (const m of missing.values()) console.log(`   ${m.user.username}`);
    if (!missing.size) return console.log('Nothing to do.');

    const body =
      `**Pick a faction.** ${teams.map((t) => `<@&${t.role}>`).join(' · ')}\n` +
      `Buttons are in <#${rolesChannel}>. One each — taking a second drops the first — ` +
      `and each one opens that team's voice room.\n\n` +
      `Still unsorted: ${[...missing.values()].map((m) => `<@${m.id}>`).join(' ')}`;

    if (!APPLY) {
      console.log(`\n--- would post in #${channel.name} ---\n${body}`);
      return console.log('\n(plan — pass --apply to post)');
    }
    // Roles are named for legibility, not to ping them; only the members are.
    const sent = await channel.send({
      content: body,
      allowedMentions: { users: [...missing.keys()] },
    });
    console.log(`posted ${sent.id} in #${channel.name}, naming ${missing.size} member(s).`);
  } catch (err) {
    console.error(err); process.exitCode = 1;
  } finally { await client.destroy(); }
});

client.login(process.env.DISCORD_TOKEN);
