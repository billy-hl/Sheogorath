'use strict';
/**
 * `/pz` — Project Zomboid server administration, for the Sheriff tier and above.
 *
 * Everything here goes out over RCON (services/zomboid/admin.js). The design
 * goal is that nobody needs to remember console syntax or internal IDs: player
 * names, item names and skill names are all autocompleted from what the server
 * actually has loaded, so `/pz giveitem` is "type axe, pick Fire Axe" rather
 * than "know that it's Base.Axe".
 *
 * Access is gated centrally in utils/permissions.js (STAFF_COMMANDS), not here,
 * so registration and the runtime check can't drift. The gate is deliberately
 * *not* mirrored into setDefaultMemberPermissions: that would hide the command
 * from anyone without Discord's Administrator flag, which is exactly the Sheriff
 * — a role that gets these commands *instead of* server-wide Discord power.
 *
 * One exception lives in the same place: `access` grants in-game power rather
 * than using it, so it's listed in ADMIN_SUBCOMMANDS and refused to Sheriffs.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const { players: rconPlayers, serverMessage } = require('../services/zomboid/rcon');
const admin = require('../services/zomboid/admin');
const access = require('../services/zomboid/access');
const items = require('../services/zomboid/items');
const { characterName, playersDbPath } = require('../services/zomboid/players');
const { collectPlayers, isAlive, knownSkills } = require('../services/zomboid/leaderboard');
const restarts = require('../services/zomboid/restart');
const xp = require('../services/zomboid/xp');
const raid = require('../services/zomboid/raid');
const siege = require('../services/zomboid/siege');
const baseRaid = require('../services/zomboid/baseRaid');

const COLOR = 0x8b1a1a;

// Autocomplete fires on every keystroke and Discord allows 3s to answer, so the
// online list is cached hard — an RCON round-trip per character typed would both
// lag the picker and hammer the server.
const ONLINE_TTL_MS = 10 * 1000;
const onlineCache = new Map(); // guildId -> { at, names }

// The PerkLog is large and only changes when someone logs in or dies; skill
// names change only when a mod is added.
const SKILLS_TTL_MS = 30 * 60 * 1000;
const skillsCache = new Map(); // logDir -> { at, names }

async function onlineNames(guildId) {
  const hit = onlineCache.get(guildId);
  if (hit && Date.now() - hit.at < ONLINE_TTL_MS) return hit.names;

  let names = [];
  try {
    ({ names } = await rconPlayers(guildId));
  } catch {
    // Server down or restarting — an empty picker is better than an error
    // toast, and the option is free-text so a name can still be typed.
    names = hit?.names || [];
  }
  onlineCache.set(guildId, { at: Date.now(), names });
  return names;
}

function skillNames(logDir) {
  if (!logDir) return [];
  const hit = skillsCache.get(logDir);
  if (hit && Date.now() - hit.at < SKILLS_TTL_MS) return hit.names;

  let names = [];
  try {
    names = knownSkills(collectPlayers(logDir));
  } catch (err) {
    console.warn('[PZ] Could not read skills from PerkLog:', err?.message || err);
  }
  skillsCache.set(logDir, { at: Date.now(), names });
  return names;
}

/**
 * The newest PerkLog record for a username, or null if they've never logged in.
 *
 * Records are keyed by Steam ID, so this matches on the last-seen display name —
 * the same lookup `/pz info` does.
 */
function skillRecord(logDir, username) {
  if (!logDir) return null;
  try {
    const all = collectPlayers(logDir);
    const hit = [...all.values()].find(
      (r) => r.name && r.name.toLowerCase() === username.toLowerCase(),
    );
    return hit && hit.skillsAt > -1 ? hit : null;
  } catch (err) {
    console.warn('[PZ] Could not read PerkLog:', err?.message || err);
    return null;
  }
}

/** "12 minutes ago" / "3 hours ago" — how stale a PerkLog reading is. */
function agoLabel(at) {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Display label for a player: character name when we have one, else username. */
function label(dbPath, username) {
  const character = characterName(dbPath, { username });
  return character && character !== username ? `${character} (${username})` : username;
}

/**
 * Where server-wide announcements go. Falls back through the channels a guild
 * is likely to already have, so a restart is never announced into the void.
 */
function announceChannelId(cfg) {
  return cfg.channels?.announcements || cfg.channels?.modUpdates || cfg.channels?.chatRelay || null;
}

/** "in 25 minutes" / "in 2h 10m" */
function humanDelay(minutes) {
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `in ${h}h${m ? ` ${m}m` : ''}`;
}

/** Wall-clock label in the host's zone — the same clock the nightly timer uses. */
function clockLabel(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const toggleOption = (o) =>
  o
    .setName('state')
    .setDescription('Turn it on or off')
    .setRequired(true)
    .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' });

const playerOption = (name, description) => (o) =>
  o.setName(name).setDescription(description).setRequired(true).setAutocomplete(true);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pz')
    .setDescription('Project Zomboid server admin (Sheriff+)')
    .addSubcommand((s) =>
      s.setName('players').setDescription("Who's online right now"))
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('Look up a player — character, survival time, deaths, skills')
        .addStringOption(playerOption('player', 'Player to look up')))
    .addSubcommand((s) =>
      s
        .setName('teleport')
        .setDescription('Teleport one player to another')
        .addStringOption(playerOption('player', 'Player to move'))
        .addStringOption(playerOption('target', 'Player to move them to')))
    .addSubcommand((s) =>
      s
        .setName('kick')
        .setDescription('Kick a player from the server')
        .addStringOption(playerOption('player', 'Player to kick'))
        .addStringOption((o) =>
          o.setName('reason').setDescription('Shown to the player').setRequired(false)))
    .addSubcommand((s) =>
      s
        .setName('giveitem')
        .setDescription('Give an item to a player')
        .addStringOption(playerOption('player', 'Who gets it'))
        .addStringOption((o) =>
          o
            .setName('item')
            .setDescription('Start typing an item name, e.g. "axe"')
            .setRequired(true)
            .setAutocomplete(true))
        .addIntegerOption((o) =>
          o
            .setName('count')
            .setDescription('How many (default 1)')
            .setMinValue(1)
            .setMaxValue(1000)
            .setRequired(false)))
    .addSubcommand((s) =>
      s
        .setName('addxp')
        .setDescription('Grant XP in one skill')
        .addStringOption(playerOption('player', 'Who gets the XP'))
        .addStringOption((o) =>
          o
            .setName('skill')
            .setDescription('Skill to raise, e.g. Woodwork')
            .setRequired(true)
            .setAutocomplete(true))
        .addIntegerOption((o) =>
          o
            .setName('amount')
            .setDescription('XP to grant')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(1000000)))
    .addSubcommand((s) =>
      s
        .setName('setlevel')
        .setDescription('Raise a skill to a level, working out the XP for you')
        .addStringOption(playerOption('player', 'Whose skill to raise'))
        .addStringOption((o) =>
          o
            .setName('skill')
            .setDescription('Skill to raise, e.g. Woodwork')
            .setRequired(true)
            .setAutocomplete(true))
        .addIntegerOption((o) =>
          o
            .setName('level')
            .setDescription('Level to bring them up to')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(xp.MAX_LEVEL)))
    .addSubcommand((s) =>
      s
        .setName('godmode')
        .setDescription('Make a player invincible')
        .addStringOption(playerOption('player', 'Player'))
        .addStringOption(toggleOption))
    .addSubcommand((s) =>
      s
        .setName('invisible')
        .setDescription('Hide a player from zombies')
        .addStringOption(playerOption('player', 'Player'))
        .addStringOption(toggleOption))
    .addSubcommand((s) =>
      s
        .setName('noclip')
        .setDescription('Let a player walk through walls')
        .addStringOption(playerOption('player', 'Player'))
        .addStringOption(toggleOption))
    .addSubcommand((s) =>
      s
        .setName('access')
        .setDescription("Set a player's in-game access level (Owners only)")
        .addStringOption(playerOption('player', 'Player to promote or demote'))
        .addStringOption((o) =>
          o
            .setName('level')
            .setDescription('Access level to give them, e.g. moderator')
            .setRequired(true)
            .setAutocomplete(true)))
    .addSubcommand((s) =>
      s
        .setName('say')
        .setDescription('Broadcast a message to everyone in-game')
        .addStringOption((o) =>
          o.setName('message').setDescription('What to broadcast').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('restart')
        .setDescription('Restart the server, announced in Discord and in-game')
        .addStringOption((o) =>
          o
            .setName('when')
            .setDescription('e.g. 20, 20m, 1h30m, 22:00, 10:30pm, now — default 5 minutes')
            .setRequired(false))
        .addStringOption((o) =>
          o
            .setName('reason')
            .setDescription('Told to players, e.g. "for scheduled maintenance"')
            .setRequired(false)))
    .addSubcommand((s) =>
      s.setName('restart-cancel').setDescription('Cancel a scheduled restart'))
    .addSubcommand((s) =>
      s.setName('restart-status').setDescription('Is a restart running or scheduled?'))
    .addSubcommand((s) =>
      s
        .setName('raid')
        .setDescription('Horde event: staged spawns around every online player')
        .addIntegerOption((o) =>
          o
            .setName('per-player')
            .setDescription('Zombies per player across the whole event (default 40)')
            .setMinValue(1)
            .setMaxValue(200)
            .setRequired(false))
        .addIntegerOption((o) =>
          o
            .setName('minutes')
            .setDescription('How long to spread the waves over (default 5)')
            .setMinValue(1)
            .setMaxValue(30)
            .setRequired(false))
        .addIntegerOption((o) =>
          o
            .setName('near')
            .setDescription('Closest spawn distance in tiles (default 45)')
            .setMinValue(20)
            .setMaxValue(95)
            .setRequired(false))
        .addIntegerOption((o) =>
          o
            .setName('far')
            .setDescription('Furthest spawn distance — keep under 100 (default 70)')
            .setMinValue(25)
            .setMaxValue(99)
            .setRequired(false))
        .addBooleanOption((o) =>
          o
            .setName('preview')
            .setDescription('Work out the spawns and report them without spawning anything')
            .setRequired(false))
        .addStringOption((o) =>
          o
            .setName('target')
            .setDescription('Where the horde goes (default: their safehouses)')
            .setRequired(false)
            .addChoices(
              { name: 'safehouse — armed at their base, fires when they get home', value: 'safehouse' },
              { name: 'players — spawned around them right now', value: 'players' },
            )))
    .addSubcommand((s) =>
      s
        .setName('siege')
        .setDescription('Stock a random survivor house with loot and ring it with zombies')
        .addStringOption((o) =>
          o
            .setName('town')
            .setDescription('Restrict to one town (default: anywhere)')
            .setRequired(false)
            .setAutocomplete(true))
        .addIntegerOption((o) =>
          o
            .setName('zombies')
            .setDescription('How many surround it (default 200)')
            .setMinValue(10)
            .setMaxValue(500)
            .setRequired(false))
        .addStringOption((o) =>
          o
            .setName('loot')
            .setDescription('Loot tier (default high)')
            .setRequired(false)
            .addChoices({ name: 'standard', value: 'standard' }, { name: 'high', value: 'high' }))
        .addBooleanOption((o) =>
          o
            .setName('silent')
            .setDescription('Place it with no announcement — players have to find it')
            .setRequired(false)))
    .addSubcommand((s) =>
      s.setName('siege-status').setDescription('How the current siege is going'))
    .addSubcommand((s) =>
      s.setName('raid-status').setDescription('How the current base raid is going'))
    .addSubcommand((s) =>
      s
        .setName('siege-cancel')
        .setDescription('Call off the running siege and clear its loot and horde')),

  /**
   * Autocomplete for the player / item / skill options.
   *
   * Never throws and never awaits anything slow: an unanswered autocomplete
   * shows the user a broken picker, so every path ends in a respond() call.
   */
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand(false);
    let choices = [];

    try {
      if (focused.name === 'town') {
        // Towns that actually have candidate houses in the map's spawnpoints —
        // offering one with none would arm a siege that can never place loot.
        const query = focused.value.toLowerCase();
        choices = siege
          .towns(guildId)
          .filter((t) => t.toLowerCase().includes(query))
          .slice(0, 25)
          .map((t) => ({ name: t.slice(0, 100), value: t.slice(0, 100) }));
      } else if (focused.name === 'player' && sub === 'access') {
        // The only subcommand that reaches players who aren't logged in:
        // promoting someone when they ask, rather than waiting for them to be
        // online, is the normal case. Their current level rides along in the
        // label so a demotion isn't aimed blind.
        const query = focused.value.toLowerCase();
        choices = access
          .accounts(guildId)
          .filter((a) => a.username.toLowerCase().includes(query))
          .slice(0, 25)
          .map((a) => ({
            name: `${a.username}${a.level ? ` — ${a.level}` : ''}`.slice(0, 100),
            value: a.username.slice(0, 100),
          }));
      } else if (focused.name === 'player' || focused.name === 'target') {
        const query = focused.value.toLowerCase();
        choices = (await onlineNames(guildId))
          .filter((n) => n.toLowerCase().includes(query))
          .slice(0, 25)
          .map((n) => ({ name: n, value: n }));
      } else if (focused.name === 'level') {
        // Read from the server's role table rather than hardcoded: this server
        // has custom roles beside the built-in ones, and the console's `help`
        // lists neither them nor the right set of built-ins.
        const query = focused.value.toLowerCase();
        choices = access
          .levels(guildId)
          .filter((l) => l.name.toLowerCase().includes(query))
          .slice(0, 25)
          .map((l) => ({
            name: `${l.name}${l.description ? ` — ${l.description}` : ''}`.slice(0, 100),
            value: l.name.slice(0, 100),
          }));
      } else if (focused.name === 'item') {
        choices = items.search(guildId, focused.value, 25).map((i) => ({
          // Both halves shown: the name is what they searched for, the ID is
          // what actually gets sent, and seeing it builds familiarity.
          name: `${i.name} — ${i.id}`.slice(0, 100),
          value: i.id.slice(0, 100),
        }));
      } else if (focused.name === 'skill') {
        const query = focused.value.toLowerCase();
        choices = skillNames(getGuildConfig(guildId)?.zomboid?.logDir)
          .filter((n) => n.toLowerCase().includes(query))
          .slice(0, 25)
          .map((n) => ({ name: n, value: n }));
      }
    } catch (err) {
      console.warn('[PZ] Autocomplete failed:', err?.message || err);
    }

    await interaction.respond(choices).catch(() => {});
  },

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const cfg = getGuildConfig(guildId)?.zomboid;
    if (!cfg) {
      await interaction.reply({
        content: 'No Project Zomboid server is configured for this guild.',
        flags: 64,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const player = interaction.options.getString('player');
    const on = interaction.options.getString('state') === 'on';
    const dbPath = playersDbPath(guildId);

    // Public for the read-only views, quiet for the actions — the actions are
    // already recorded in the command log channel, so echoing them here too
    // would just be noise in whatever channel the Sheriff happened to use.
    const quiet = !['players', 'info', 'restart-status'].includes(sub);
    await interaction.deferReply(quiet ? { flags: 64 } : {});

    try {
      switch (sub) {
        case 'players': {
          const { count, names } = await rconPlayers(guildId);
          const embed = new EmbedBuilder()
            .setColor(COLOR)
            .setTitle(`🧟 ${count} online`)
            .setDescription(
              names.length ? names.map((n) => `• ${label(dbPath, n)}`).join('\n') : '_Nobody._',
            )
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        case 'info': {
          const online = (await onlineNames(guildId)).some(
            (n) => n.toLowerCase() === player.toLowerCase(),
          );

          let record = null;
          if (cfg.logDir) {
            try {
              const all = collectPlayers(cfg.logDir);
              record = [...all.values()].find(
                (r) => r.name && r.name.toLowerCase() === player.toLowerCase(),
              );
            } catch (err) {
              console.warn('[PZ] Could not read PerkLog:', err?.message || err);
            }
          }

          const embed = new EmbedBuilder()
            .setColor(COLOR)
            .setTitle(`🔎 ${label(dbPath, player)}`)
            .addFields({ name: 'Status', value: online ? '🟢 Online' : '⚫ Offline', inline: true });

          if (record) {
            const top = Object.entries(record.skills)
              .filter(([, lvl]) => lvl > 0)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([skill, lvl]) => `${skill} ${lvl}`)
              .join(', ');

            embed.addFields(
              { name: 'Alive', value: isAlive(record) ? 'Yes' : '☠ No', inline: true },
              { name: 'Deaths', value: String(record.deaths), inline: true },
              {
                name: 'Hours survived',
                value: `${record.hours.toLocaleString()}h · ${Math.floor(record.hours / 24)}d`,
                inline: true,
              },
              {
                name: 'Best run',
                value: `${record.bestHours.toLocaleString()}h · ${Math.floor(record.bestHours / 24)}d`,
                inline: true,
              },
              { name: 'Sessions', value: String(record.sessions), inline: true },
              { name: 'Top skills', value: top || '_none recorded_', inline: false },
            );
            if (record.steamid) embed.setFooter({ text: `Steam ID ${record.steamid}` });
          } else {
            embed.setDescription('_No record in the server logs for that name._');
          }

          await interaction.editReply({ embeds: [embed] });
          return;
        }

        case 'teleport': {
          const target = interaction.options.getString('target');
          if (player.toLowerCase() === target.toLowerCase()) {
            await interaction.editReply("That's the same player.");
            return;
          }
          await admin.teleport(guildId, player, target);
          await interaction.editReply(
            `✅ Teleported **${label(dbPath, player)}** to **${label(dbPath, target)}**.`,
          );
          return;
        }

        case 'kick': {
          const reason = interaction.options.getString('reason');
          await admin.kick(guildId, player, reason);
          await interaction.editReply(
            `✅ Kicked **${label(dbPath, player)}**${reason ? ` — ${reason}` : ''}.`,
          );
          return;
        }

        case 'giveitem': {
          const raw = interaction.options.getString('item');
          const count = interaction.options.getInteger('count') || 1;
          const item = items.resolve(guildId, raw);
          if (!item) {
            await interaction.editReply(
              `No item matching **${raw}**. Start typing and pick from the list.`,
            );
            return;
          }
          await admin.giveItem(guildId, player, item.id, count);
          await interaction.editReply(
            `✅ Gave **${label(dbPath, player)}** ${count}× **${item.name}** (\`${item.id}\`).`,
          );
          return;
        }

        case 'addxp': {
          const skill = interaction.options.getString('skill');
          const amount = interaction.options.getInteger('amount');
          await admin.addXp(guildId, player, skill, amount);
          await interaction.editReply(
            `✅ Gave **${label(dbPath, player)}** ${amount.toLocaleString()} XP in **${skill}**.`,
          );
          return;
        }

        case 'setlevel': {
          const skill = interaction.options.getString('skill');
          const target = interaction.options.getInteger('level');

          // The PerkLog only dumps skills on login, death and character
          // creation — never on level-up. So this is where they stood when they
          // last connected, which is the freshest figure the server records
          // anywhere. Without it we'd be adding XP to an unknown starting
          // point, so refuse rather than guess.
          const record = skillRecord(cfg.logDir, player);
          if (!record) {
            await interaction.editReply(
              `❌ No PerkLog entry for **${player}** yet, so I can't tell what level they're ` +
                `starting from. Once they've logged in at least once this will work; until ` +
                `then use \`/pz addxp\`.`,
            );
            return;
          }

          const from = record.skills[skill] || 0;
          const { grant } = xp.plan(skill, from, target);
          await admin.addXp(guildId, player, skill, grant);

          const stale = agoLabel(record.skillsAt);
          await interaction.editReply(
            `✅ Gave **${label(dbPath, player)}** ${grant.toLocaleString()} XP in **${skill}** — ` +
              `enough to go from **${from}** to **${target}**.\n` +
              `_Starting level read from their last login (${stale}). If they've levelled ` +
              `since, they'll land a little above ${target}._`,
          );
          return;
        }

        case 'godmode':
          await admin.godMode(guildId, player, on);
          await interaction.editReply(
            `✅ God mode **${on ? 'on' : 'off'}** for **${label(dbPath, player)}**.`,
          );
          return;

        case 'invisible':
          await admin.invisible(guildId, player, on);
          await interaction.editReply(
            `✅ **${label(dbPath, player)}** is now **${on ? 'invisible to' : 'visible to'}** zombies.`,
          );
          return;

        case 'noclip':
          await admin.noclip(guildId, player, on);
          await interaction.editReply(
            `✅ Noclip **${on ? 'on' : 'off'}** for **${label(dbPath, player)}**.`,
          );
          return;

        case 'access': {
          const level = interaction.options.getString('level');
          const result = await access.setLevel(guildId, player, level);
          const who = label(dbPath, result.username);

          if (!result.changed) {
            await interaction.editReply(
              `**${who}** is already **${result.to}** — nothing to change.`,
            );
            return;
          }

          const online = (await onlineNames(guildId)).some(
            (n) => n.toLowerCase() === result.username.toLowerCase(),
          );

          await interaction.editReply(
            `✅ **${who}** is now **${result.to}** — was **${result.from || 'unset'}**.\n` +
              (online
                ? '_They have it right now; no need to relog._'
                : '_They are offline, so it applies when they next log in._') +
              (result.verified
                ? ''
                : "\n⚠️ The server accepted it, but I couldn't read the whitelist back to " +
                  'confirm it stuck — worth spot-checking.'),
          );
          return;
        }

        case 'say': {
          const message = interaction.options.getString('message');
          await serverMessage(guildId, message);
          await interaction.editReply(`📢 Broadcast: ${message}`);
          return;
        }

        case 'restart': {
          const parsed = restarts.parseWhen(interaction.options.getString('when'));
          if (parsed.error) {
            await interaction.editReply(`❌ ${parsed.error}`);
            return;
          }

          const reason = interaction.options.getString('reason');
          const result = await restarts.startRestart(guildId, parsed.minutes, reason);
          const when = result.minutes <= 0
            ? 'now'
            : `${humanDelay(result.minutes)} (${clockLabel(result.at)})`;
          const because = result.reason ? ` — ${result.reason}` : '';

          // In-game immediately. For a scheduled restart the script's own
          // countdown doesn't start for a while, so without this players get no
          // notice until ten minutes before.
          await serverMessage(
            guildId,
            `SERVER RESTART ${result.minutes <= 0 ? 'STARTING NOW' : `${when}`}${because}`,
          ).catch((err) => console.warn('[PZ] In-game restart notice failed:', err?.message || err));

          // And in Discord, where the people who aren't logged in will see it.
          const targetId = announceChannelId(cfg);
          let announcedTo = null;
          if (targetId) {
            try {
              const channel = await interaction.client.channels.fetch(targetId);
              if (channel?.isTextBased()) {
                await channel.send({
                  embeds: [
                    new EmbedBuilder()
                      .setColor(COLOR)
                      .setTitle('🔄 Server restart')
                      .setDescription(
                        result.minutes <= 0
                          ? 'The server is restarting now.'
                          : `The server will restart **${when}**.`,
                      )
                      .addFields(
                        ...(result.reason
                          ? [{ name: 'Reason', value: result.reason, inline: false }]
                          : []),
                        { name: 'Called by', value: `<@${interaction.user.id}>`, inline: true },
                        {
                          name: 'In-game warning',
                          value: `${result.warnMinutes} min before`,
                          inline: true,
                        },
                      )
                      .setTimestamp(),
                  ],
                  allowedMentions: { parse: [] },
                });
                announcedTo = channel.id;
              }
            } catch (err) {
              console.warn('[PZ] Restart announcement failed:', err?.message || err);
            }
          }

          await interaction.editReply(
            `✅ Restart ${result.scheduled ? 'scheduled' : 'starting'} ${when}${because}.\n` +
              (result.scheduled
                ? `Players get a ${result.warnMinutes}-minute in-game countdown. ` +
                  'Cancel with `/pz restart-cancel`.\n'
                : '') +
              (announcedTo
                ? `Announced in <#${announcedTo}> and in-game.`
                : '⚠️ Announced in-game only — no announcement channel is configured.'),
          );
          return;
        }

        case 'raid': {
          // Two different mechanisms behind one command.
          //
          // `safehouse` cannot go through RCON at all: createhorde2 needs the
          // target chunk streamed, and a base nobody is standing near is by
          // definition not. It is armed in the mod and fires on stream-in.
          // `players` is the original engine, kept because it is the only thing
          // that works when you want the horde to land NOW.
          if ((interaction.options.getString('target') ?? 'safehouse') === 'safehouse') {
            if (!siege.modEnabled(guildId)) {
              await interaction.editReply(
                '❌ The `WabbajackSiege` server mod is not enabled — base raids run inside it.\n' +
                  'Add it to `MOD_IDS` in the server `.env` and restart.',
              );
              return;
            }
            if (!baseRaid.moduleInstalled(guildId)) {
              await interaction.editReply(
                '❌ The installed `WabbajackSiege` build has no base-raid module, so arming one ' +
                  'would write a request nothing reads.\n' +
                  'Publish the Workshop update and restart, or use `target: players`.',
              );
              return;
            }
            const perPlayerSh =
              interaction.options.getInteger('per-player') ?? baseRaid.DEFAULTS.perPlayer;
            const online = await onlineNames(guildId);
            if (!online.length) {
              await interaction.editReply('Nobody is online — there is nothing to arm.');
              return;
            }
            if (interaction.options.getBoolean('preview')) {
              await interaction.editReply(
                `🔍 Would arm **${perPlayerSh}** zombies at the safehouse of each of ` +
                  `**${online.length}** online players. Players with no claim are skipped.`,
              );
              return;
            }
            const ev = baseRaid.arm(guildId, { perPlayer: perPlayerSh });
            await interaction.editReply(
              `🏠 Armed base raid \`${ev.id}\` — **${ev.perPlayer}** zombies ringing the ` +
                `safehouse of each of **${online.length}** online players.\n` +
                '_Placed on the claim perimeter, never inside it. Each one materialises when ' +
                'somebody streams that area, so they come home to it rather than watching it ' +
                'appear. Players with no claim are skipped._\n' +
                '**These are permanent** — nothing removes them but players. ' +
                'Track it with `/pz raid-status`.',
            );
            return;
          }

          const perPlayer = interaction.options.getInteger('per-player') ?? raid.DEFAULTS.perPlayer;
          const minutes = interaction.options.getInteger('minutes') ?? 5;
          const near = interaction.options.getInteger('near') ?? raid.DEFAULTS.near;
          const far = interaction.options.getInteger('far') ?? raid.DEFAULTS.far;
          const preview = interaction.options.getBoolean('preview') ?? false;

          if (far <= near) {
            await interaction.editReply('`far` has to be greater than `near`.');
            return;
          }

          const online = await onlineNames(guildId);
          if (!online.length) {
            await interaction.editReply('Nobody is online — there is nothing to spawn around.');
            return;
          }

          // Spawns are permanent (ZombieRespawn=None, and no RCON command
          // removes zombies), so the worst case is stated up front rather than
          // discovered afterwards in the command log.
          const worstCase = perPlayer * online.length;
          await interaction.editReply(
            `${preview ? '🔍 Previewing' : '🧟 Starting'} a horde event over **${minutes} min** — ` +
              `**${perPlayer}** per player across **${online.length}** online ` +
              `(up to **${worstCase}** zombies, ${near}-${far} tiles).` +
              (preview ? '' : '\n_These are permanent; nothing removes them but players._'),
          );

          const misses = [];
          const summary = await raid.runRaid(
            guildId,
            { perPlayer, duration: minutes * 60, near, far, dryRun: preview },
            (e) => {
              if (e.kind === 'miss') misses.push(`${e.player} (${e.d}t)`);
              if (e.kind === 'skip') misses.push(`${e.player} — ${e.reason}`);
            },
          );

          const embed = new EmbedBuilder()
            .setColor(COLOR)
            .setTitle(preview ? '🔍 Horde preview' : '🧟 Horde event finished')
            .addFields(
              { name: 'Spawned', value: `${summary.spawned}`, inline: true },
              { name: 'Landed', value: `${summary.ok}`, inline: true },
              { name: 'Missed', value: `${summary.miss + summary.skipped}`, inline: true },
            )
            .setTimestamp();

          const hit = Object.entries(summary.perPlayer).filter(([, n]) => n > 0);
          if (hit.length) {
            embed.addFields({
              name: 'Per player',
              value: hit.map(([u, n]) => `• ${label(dbPath, u)} — ${n}`).join('\n').slice(0, 1024),
            });
          }
          if (misses.length) {
            // A miss is `invalid location`: that player's client was not
            // streaming the square, so they got less than everyone else.
            embed.addFields({
              name: 'Not delivered',
              value: misses.join('\n').slice(0, 1024),
            });
          }
          await interaction.followUp({ embeds: [embed], flags: 64 });
          return;
        }

        case 'siege': {
          if (!siege.modEnabled(guildId)) {
            await interaction.editReply(
              '❌ The `WabbajackSiege` server mod is not enabled — a siege would do nothing.\n' +
                'Add it to `MOD_IDS` in the server `.env` and restart.',
            );
            return;
          }
          const town = interaction.options.getString('town');
          const zombies = interaction.options.getInteger('zombies') ?? 200;
          const loot = interaction.options.getString('loot') ?? 'high';
          const silent = interaction.options.getBoolean('silent') ?? false;

          let ev;
          try {
            ev = siege.arm(guildId, { town, zombies, loot, silent });
          } catch (err) {
            await interaction.editReply(`❌ ${err.message}`);
            return;
          }

          // Announced in the open: the coordinates ARE the event. Travelling
          // there through the world is the first half of the risk, and a siege
          // nobody is told about is just a horde nobody finds.
          //
          // Unless silent, which is the other legitimate mode: seed the house
          // and let somebody stumble on it, with no race and no crowd.
          // Town, not coordinates. Players have no coordinate readout, so the
          // one concrete detail in the old announcement was the one they could
          // not act on.
          const where = `**${ev.town.replace(/, KY$/, '')}**`;
          // No in-game message from here any more. The mod announces when the
          // siege actually FIRES; this fired at ARM time, which on an armed
          // event that nobody is near could be a long time before it exists.

          const announceId = silent ? null : announceChannelId(cfg);
          if (announceId) {
            const ch = await interaction.client.channels.fetch(announceId).catch(() => null);
            if (ch) {
              await ch.send({
                embeds: [new EmbedBuilder()
                  .setColor(COLOR)
                  .setTitle('A survivor holdout has been found')
                  .setDescription(
                    `Somebody was holed up at ${where} — and did not make it.\n\n` +
                      'There are supplies still inside. There are also **' + ev.zombies +
                      '** of them around it.\n\n' +
                      '**Five minutes** from the moment the first person steps through the door, ' +
                      'whatever has not been carried out is gone.',
                  )
                  .setTimestamp()],
              }).catch(() => null);
            }
          }

          await interaction.editReply(
            `🏚️ Armed ${silent ? '**silent** ' : ''}siege \`${ev.id}\` in ` +
              `**${ev.town.replace(/, KY$/, '')}** (${ev.x},${ev.y}) — ` +
              `${ev.zombies} zombies, ${ev.loot} loot.\n` +
              '_The mod places it the moment the area streams in — before anyone can see it. ' +
              'Track it with `/pz siege-status`._',
          );
          return;
        }

        case 'raid-status': {
          const st = baseRaid.status(guildId);
          if (!st) {
            await interaction.editReply('No base raid has reported yet.');
            return;
          }
          const pending = Number(st.pending || 0);
          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(COLOR)
              .setTitle('Base raid status')
              .setDescription(pending > 0
                ? `⏳ ${pending} cluster(s) still waiting for somebody to go near that claim`
                : '✅ Every cluster has fired')
              .addFields(
                { name: 'Claims armed', value: `${st.armed || 0}`, inline: true },
                { name: 'Clusters fired', value: `${st.fired || 0}`, inline: true },
                { name: 'Zombies placed', value: `${st.spawned || 0}`, inline: true },
              )
              .setTimestamp()],
          });
          return;
        }

        case 'siege-cancel': {
          if (!siege.modEnabled(guildId)) {
            await interaction.editReply('❌ The `WabbajackSiege` server mod is not enabled.');
            return;
          }
          const st = siege.status(guildId);
          if (!st || st.phase === 'done') {
            await interaction.editReply('Nothing to cancel — no siege is running.');
            return;
          }
          const ev = siege.cancel(guildId);
          await interaction.editReply(
            `🛑 Cancel sent for the siege at **${st.x},${st.y}** (request \`${ev.id}\`).\n` +
              '_The mod picks this up within a minute: it removes the horde, strips the house ' +
              'and clears loose loot around it. Anything already carried out is kept._',
          );
          return;
        }

        case 'siege-status': {
          const st = siege.status(guildId);
          if (!st) {
            await interaction.editReply('No siege has reported yet.');
            return;
          }
          const phase = {
            armed: '⏳ Armed — waiting for someone to get close enough to load the area',
            active: '🔥 Active — loot and horde are placed',
            broken: '🩸 Broken — the horde is beaten, cleanup pending',
            done: '✅ Done — site cleaned up',
          }[st.phase] || st.phase;
          const embed = new EmbedBuilder()
            .setColor(COLOR)
            .setTitle('Siege status')
            .setDescription(phase)
            .addFields(
              { name: 'Location', value: `${st.x}, ${st.y}`, inline: true },
              { name: 'Spawned', value: `${st.spawned || 0}`, inline: true },
              { name: 'Still alive', value: `${st.alive || 0}`, inline: true },
            )
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        case 'restart-cancel': {
          const cancelled = await restarts.cancelRestart();
          if (!cancelled) {
            await interaction.editReply(
              'Nothing to cancel — no restart is scheduled. ' +
                'A restart already counting down cannot be called off from here.',
            );
            return;
          }
          await serverMessage(guildId, 'The scheduled server restart has been called off.').catch(
            () => {},
          );
          await interaction.editReply('✅ Scheduled restart cancelled, and players told in-game.');
          return;
        }

        case 'restart-status': {
          const [running, pending] = await Promise.all([
            restarts.activeRestart(),
            restarts.pendingRestart(),
          ]);
          const embed = new EmbedBuilder().setColor(COLOR).setTitle('🔄 Restart status');
          if (running) {
            embed.setDescription(`A restart is **in progress** right now (\`${running}\`).`);
          } else if (pending) {
            embed.setDescription(
              pending.at
                ? `A restart is **scheduled** for **${clockLabel(pending.at)}**.`
                : 'A restart is **scheduled**.',
            );
          } else {
            embed.setDescription('No restart running or scheduled. The nightly one still applies.');
          }
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        default:
          await interaction.editReply('Unknown subcommand.');
      }
    } catch (err) {
      // A missing player, a restart already in flight and an unmeetable level
      // request are all operator error with a message worth showing verbatim;
      // anything else is ours.
      const expected = err.notFound || err.alreadyRunning || err.userFacing;
      if (!expected) {
        console.error(`[PZ] /pz ${sub} failed:`, err?.message || err);
      }
      await interaction.editReply(
        expected ? `❌ ${err.message}` : `❌ That didn't work — the server may be down or restarting.`,
      );
    }
  },
};
