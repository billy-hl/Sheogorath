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
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const { players: rconPlayers, serverMessage } = require('../services/zomboid/rcon');
const admin = require('../services/zomboid/admin');
const items = require('../services/zomboid/items');
const { characterName, playersDbPath } = require('../services/zomboid/players');
const { collectPlayers, isAlive, knownSkills } = require('../services/zomboid/leaderboard');
const restarts = require('../services/zomboid/restart');

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
      s.setName('restart-status').setDescription('Is a restart running or scheduled?')),

  /**
   * Autocomplete for the player / item / skill options.
   *
   * Never throws and never awaits anything slow: an unanswered autocomplete
   * shows the user a broken picker, so every path ends in a respond() call.
   */
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const guildId = interaction.guildId;
    let choices = [];

    try {
      if (focused.name === 'player' || focused.name === 'target') {
        const query = focused.value.toLowerCase();
        choices = (await onlineNames(guildId))
          .filter((n) => n.toLowerCase().includes(query))
          .slice(0, 25)
          .map((n) => ({ name: n, value: n }));
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
      // A missing player and a restart already in flight are both operator
      // error with a message worth showing verbatim; anything else is ours.
      const expected = err.notFound || err.alreadyRunning;
      if (!expected) {
        console.error(`[PZ] /pz ${sub} failed:`, err?.message || err);
      }
      await interaction.editReply(
        expected ? `❌ ${err.message}` : `❌ That didn't work — the server may be down or restarting.`,
      );
    }
  },
};
