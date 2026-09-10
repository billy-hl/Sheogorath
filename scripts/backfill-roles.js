#!/usr/bin/env node
'use strict';
/**
 * Gives existing members the roles that new arrivals now get on the way in.
 *
 * Onboarding only runs for people joining, and Discord will not send an
 * existing member back through it — so everyone already here when the faction
 * prompt went up has no team, and no way to acquire one now that the buttons
 * are gone. This hands them the default.
 *
 * Note what that means with sticky factions: a team assigned here is the team
 * that member is on, permanently, unless somebody with Manage Roles moves them.
 * It is not a nudge, it is a decision made on their behalf.
 *
 *   node scripts/backfill-roles.js                        # plan
 *   node scripts/backfill-roles.js --apply
 *   node scripts/backfill-roles.js --team Valkyra --apply
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { getGuildConfig } = require('../src/config/guilds');

const GUILD = process.argv.find((a) => /^\d{17,20}$/.test(a)) || '1547233037765578822';
const APPLY = process.argv.includes('--apply');
const teamArg = process.argv.indexOf('--team');
const DEFAULT_TEAM = teamArg > -1 ? process.argv[teamArg + 1] : 'Manticore';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(GUILD);
    await guild.roles.fetch();
    const cfg = getGuildConfig(GUILD);

    const baseId = cfg.roles.onJoin || cfg.roles.member;
    const base = baseId && guild.roles.cache.get(baseId);
    const teams = (cfg.selfRoles || []).filter((r) => r.group === 'team');
    const team = teams.find((t) => t.label.toLowerCase() === DEFAULT_TEAM.toLowerCase());
    if (!base) return console.log('No onJoin/member role configured.');
    if (!team) return console.log(`No team called "${DEFAULT_TEAM}". Have: ${teams.map((t) => t.label).join(', ')}`);
    const teamRole = guild.roles.cache.get(team.role);

    const members = await guild.members.fetch();
    const humans = members.filter((m) => !m.user.bot);
    const needBase = humans.filter((m) => !m.roles.cache.has(base.id));
    const needTeam = humans.filter((m) => !teams.some((t) => m.roles.cache.has(t.role)));

    console.log(`${humans.size} humans.`);
    console.log(`  missing ${base.name}: ${needBase.size}${needBase.size ? ' — ' + needBase.map((m) => m.user.username).join(', ') : ''}`);
    console.log(`  no faction: ${needTeam.size}${needTeam.size ? ' — ' + needTeam.map((m) => m.user.username).join(', ') : ''}`);
    for (const t of teams) {
      console.log(`    ${t.label}: ${humans.filter((m) => m.roles.cache.has(t.role)).size}`);
    }
    if (!APPLY) return console.log(`\n(plan — pass --apply to grant ${base.name} and ${teamRole.name})`);

    let granted = 0;
    for (const m of needBase.values()) {
      await m.roles.add(base, 'backfill: role every member holds');
      granted++;
    }
    for (const m of needTeam.values()) {
      await m.roles.add(teamRole, `backfill: default faction ${teamRole.name}`);
      granted++;
    }
    console.log(`\ngranted ${granted} role(s): ${needBase.size} × ${base.name}, ${needTeam.size} × ${teamRole.name}.`);
  } catch (err) {
    console.error(err); process.exitCode = 1;
  } finally { await client.destroy(); }
});

client.login(process.env.DISCORD_TOKEN);
