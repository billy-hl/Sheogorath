#!/usr/bin/env node
'use strict';
/**
 * Rename the guild's role ladder to the Project Zomboid theme and add the
 * Sheriff tier below the Owners.
 *
 *   Owner                stays Owner — full bot admin, unchanged grants
 *   (new)  -> Sheriff    the PZ admin commands, /pz
 *   vip    -> Veteran    unchanged grants
 *   member -> Survivor   unchanged grants
 *
 * Owner keeps its name by choice. It also sits above the bot in the role list,
 * so the bot could not rename it anyway — Discord refuses edits to roles at or
 * above its own highest. Its ID is still recorded as roles.admin.
 *
 * Sheriff is created with **no Discord permissions of its own**. That's the
 * point of it: the bot recognises the role by ID (roles.staff in
 * config/guilds.json) and lets holders run /pz, without Discord itself granting
 * them anything server-wide. A Sheriff can teleport a player in-game and cannot
 * delete a channel.
 *
 * Run it twice — once to see the plan, once to commit:
 *
 *   node scripts/pz-roles.js            # dry run, changes nothing
 *   node scripts/pz-roles.js --apply
 *
 * Renames are by role ID once known, and matched case-insensitively by name on
 * the first run. Re-running after a successful apply is a no-op: the script
 * looks for the new names too, so it won't create a second Sheriff.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');

// This reads and writes config/guilds.json itself rather than going through
// src/config/guilds.js. The script has to be runnable on the deployment host,
// where the checked-out bot code may predate the roles.staff key — and a
// normalizer that doesn't know the key would drop it on the way back out.
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'guilds.json');

function recordRoleIds(guildId, roles) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!raw[guildId]) throw new Error(`${guildId} is not in config/guilds.json`);
  raw[guildId].roles = { ...(raw[guildId].roles || {}), ...roles };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return raw[guildId].roles;
}

const APPLY = process.argv.includes('--apply');
const GUILD_ID = process.argv.find((a) => /^\d{17,20}$/.test(a)) || '444601986160263189';

// Colour is cosmetic and easy to change in Discord afterwards; these just make
// the new ladder legible at a glance in the member list.
const SHERIFF_COLOR = 0xb8860b;

/**
 * oldName -> { to, configKey } — configKey is where the ID is recorded.
 * `to` equal to `from` means "record the ID, leave the name alone".
 */
const RENAMES = [
  { from: 'owner', to: 'Owner', configKey: 'admin' },
  { from: 'vip', to: 'Veteran', configKey: 'veteran' },
  { from: 'member', to: 'Survivor', configKey: 'member' },
];

const SHERIFF = { name: 'Sheriff', configKey: 'staff' };

function findRole(guild, ...names) {
  const wanted = names.map((n) => n.toLowerCase());
  return guild.roles.cache.find((r) => wanted.includes(r.name.toLowerCase())) || null;
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set — add it to .env.');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  await new Promise((resolve) => client.once('ready', resolve));

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.roles.fetch();
  const me = await guild.members.fetchMe();

  console.log(`\nGuild: ${guild.name} (${guild.id})`);
  console.log(`Mode:  ${APPLY ? 'APPLY — changes will be made' : 'DRY RUN — nothing will change'}\n`);

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("The bot lacks Manage Roles in this guild — grant it, then re-run.");
  }
  const ceiling = me.roles.highest.position;
  console.log(`Bot's highest role: ${me.roles.highest.name} (position ${ceiling})`);
  console.log('Discord only lets it edit roles *below* that line.\n');

  const patch = { roles: {} };
  let blocked = false;

  // --- renames ------------------------------------------------------------
  for (const { from, to, configKey } of RENAMES) {
    const role = findRole(guild, from, to);
    if (!role) {
      console.log(`  ?  no role named "${from}" (or "${to}") — skipping`);
      continue;
    }

    patch.roles[configKey] = role.id;

    if (role.name === to) {
      console.log(`  =  ${to} already named correctly (${role.id})`);
      continue;
    }
    if (role.position >= ceiling) {
      console.log(`  !  "${role.name}" sits at or above the bot's own role — Discord will refuse`);
      blocked = true;
      continue;
    }

    console.log(`  ~  "${role.name}" -> "${to}" (${role.id})`);
    if (APPLY) await role.setName(to, 'PZ role theming');
  }

  // --- the new tier -------------------------------------------------------
  const veteran = findRole(guild, 'vip', 'Veteran');
  const existing = findRole(guild, SHERIFF.name);

  if (existing) {
    console.log(`  =  ${SHERIFF.name} already exists (${existing.id})`);
    patch.roles[SHERIFF.configKey] = existing.id;
  } else {
    // One above Veteran puts it between Veteran and whatever is next up.
    const position = veteran ? veteran.position + 1 : 1;
    console.log(`  +  create "${SHERIFF.name}" at position ${position}, no Discord permissions`);
    if (APPLY) {
      const role = await guild.roles.create({
        name: SHERIFF.name,
        color: SHERIFF_COLOR,
        hoist: true,
        mentionable: false,
        permissions: [], // Deliberately none — /pz access comes from the bot.
        position,
        reason: 'PZ staff tier — grants /pz via the bot, not via Discord',
      });
      console.log(`     created ${role.id} at position ${role.position}`);
      patch.roles[SHERIFF.configKey] = role.id;
    }
  }

  // --- record the IDs -----------------------------------------------------
  console.log('\nconfig/guilds.json roles ->');
  for (const [k, v] of Object.entries(patch.roles)) console.log(`  ${k}: ${v}`);

  if (APPLY) {
    const saved = recordRoleIds(GUILD_ID, patch.roles);
    console.log('\nWritten to config/guilds.json:');
    console.log(JSON.stringify(saved, null, 2));
  } else {
    console.log('\nDry run — re-run with --apply to commit.');
  }

  if (blocked) {
    console.log(
      '\n⚠ One or more roles sit above the bot in the role list. Drag the bot’s\n' +
      '  own role above them in Server Settings → Roles, then re-run.',
    );
  }

  await client.destroy();
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
