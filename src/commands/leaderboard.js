'use strict';
/**
 * `/leaderboard` — server records for the Project Zomboid guild.
 *
 * Skill, survival and death figures come from the PerkLog (see
 * services/zomboid/leaderboard.js). Skill boards only count *living*
 * characters, because skills reset on death and the newest dump for a dead
 * player describes the character they just lost. Survival and death counts are
 * all-time and include the fallen.
 *
 * The kill board comes from a different log entirely — the pvp log (see
 * services/zomboid/kills.js) — and is keyed by name rather than Steam ID, so the
 * two sets of records are reported side by side but never joined.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const {
  collectPlayers,
  isAlive,
  totalLevels,
  knownSkills,
  rank,
  skillChampions,
} = require('../services/zomboid/leaderboard');
const {
  collectKills,
  fmtKd,
  topEntry,
  rank: rankKills,
  rivalries,
  recent,
} = require('../services/zomboid/kills');

const COLOR = 0x8b1a1a;
const MEDALS = ['🥇', '🥈', '🥉'];

/** In-game hours, with the day count that players actually think in. */
function fmtHours(h) {
  return `${h.toLocaleString()}h · ${Math.floor(h / 24)}d`;
}

function place(i) {
  return MEDALS[i] || `\`${i + 1}.\``;
}

function listing(rows, fmt) {
  if (!rows.length) return '_no data yet_';
  return rows.map((r, i) => `${place(i)} **${r.name}** — ${fmt(r)}`).join('\n');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {Map} players PerkLog records
 * @param {?{players: Map}} killData pvp-log records, or null if that log
 *   couldn't be read — the rest of the board is still worth showing without it.
 */
function overallEmbed(players, killData) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🏆 Wabbajack Records')
    .addFields(
      {
        name: '⏳ Longest Survival (living)',
        value: listing(rank(players, (p) => p.hours, { aliveOnly: true }), (r) => fmtHours(r.value)),
        inline: true,
      },
      {
        name: '🕯️ Longest Ever (incl. fallen)',
        value: listing(rank(players, (p) => p.bestHours), (r) => fmtHours(r.value)),
        inline: true,
      },
      {
        name: '📚 Most Skill Levels (living)',
        value: listing(rank(players, totalLevels, { aliveOnly: true }), (r) => `${r.value} levels`),
        inline: false,
      },
      {
        name: '⚰️ Most Deaths',
        value: listing(rank(players, (p) => p.deaths), (r) => `${r.value} deaths`),
        inline: true,
      },
    );

  if (killData) {
    embed.addFields({
      name: '🔪 Most Player Kills',
      value: listing(
        rankKills(killData.players, (p) => p.kills, { limit: 5 }),
        (r) => `${r.value} kills · K/D ${fmtKd(r.rec)}`,
      ),
      inline: true,
    });
  }

  return embed;
}

function championsEmbed(players) {
  const champs = skillChampions(players);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🥇 Skill Champions')
    .setDescription(
      champs.length
        ? 'Highest level in every skill, among living characters.'
        : 'No living characters with skills on record yet.',
    );

  const lines = champs.map(
    (c) =>
      `**${c.skill}** ${c.value} — ${c.names.join(', ')}` +
      (c.tied > c.names.length ? ` _+${c.tied - c.names.length} tied_` : ''),
  );
  // Embed fields cap at 1024 chars; 12 lines stays comfortably under.
  for (const [i, group] of chunk(lines, 12).entries()) {
    embed.addFields({ name: i === 0 ? 'Skills' : '​', value: group.join('\n'), inline: true });
  }
  return embed;
}

function singleSkillEmbed(players, skill) {
  const rows = rank(players, (p) => p.skills[skill] || 0, { aliveOnly: true, limit: 10 });
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`🥇 Top ${skill}`)
    .setDescription(listing(rows, (r) => `level ${r.value}`))
    .setFooter({ text: 'Living characters only — skills reset on death.' });
}

function survivalEmbed(players) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('⏳ Survival Records')
    .addFields(
      {
        name: 'Still standing',
        value: listing(
          rank(players, (p) => p.hours, { aliveOnly: true, limit: 10 }),
          (r) => fmtHours(r.value),
        ),
        inline: true,
      },
      {
        name: 'All-time, including the fallen',
        value: listing(
          rank(players, (p) => p.bestHours, { limit: 10 }),
          (r) => fmtHours(r.value) + (isAlive(r.rec) ? '' : ' ☠'),
        ),
        inline: true,
      },
    );
}

/**
 * The PvP kill board.
 *
 * Every label says *players* explicitly. The server records no zombie kills at
 * all, and "kills" unqualified on a Project Zomboid board will be read as
 * zombies by anyone who hasn't been told otherwise.
 */
function killsEmbed({ events, players }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('☠️ Blood Ledger')
    .setDescription(
      `**${events.length}** player kills on record. Zombie kills aren't logged by the server — ` +
        'these are survivors killed by other survivors.',
    );

  const top = rankKills(players, (p) => p.kills, { limit: 10 });
  embed.addFields({
    name: '🔪 Most Player Kills',
    value: listing(top, (r) => {
      const prey = topEntry(r.rec.victims);
      const deaths = `${r.rec.deaths} death${r.rec.deaths === 1 ? '' : 's'}`;
      // A "favourite" victim killed exactly once is just their only victim —
      // noise dressed up as a pattern, so it only earns a mention at two.
      const favourite = prey && prey.count > 1 ? ` · preys on ${prey.name} ×${prey.count}` : '';
      return `${r.value} kills · ${deaths} · K/D ${fmtKd(r.rec)}${favourite}`;
    }),
    inline: false,
  });

  const streaks = rankKills(players, (p) => p.bestStreak, { limit: 5 }).filter((r) => r.value > 1);
  if (streaks.length) {
    embed.addFields({
      name: '🔥 Longest Kill Streaks',
      value: listing(streaks, (r) => `${r.value} kills without dying`),
      inline: true,
    });
  }

  const feuds = rivalries(players);
  if (feuds.length) {
    embed.addFields({
      name: '⚔️ One-Sided Feuds',
      value: feuds.map((f) => `**${f.killer}** → ${f.victim} ×${f.count}`).join('\n'),
      inline: true,
    });
  }

  const latest = recent(events);
  if (latest.length) {
    embed.addFields({
      name: '🩸 Most Recent',
      value: latest
        .map(
          (e) =>
            `**${e.killer}** killed ${e.victim} · <t:${Math.floor(e.at / 1000)}:R>`,
        )
        .join('\n'),
      inline: false,
    });
  }

  embed.setFooter({ text: `${players.size} survivors have taken part in PvP` });
  return embed;
}

/** The other side of the kill board: who dies to other players most. */
function victimsEmbed({ players }) {
  const rows = rankKills(players, (p) => p.deaths, { limit: 10 });
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🎯 Most Hunted')
    .setDescription(
      rows.length
        ? listing(rows, (r) => {
            const nem = topEntry(r.rec.killers);
            const deaths = `${r.value} death${r.value === 1 ? '' : 's'} to players`;
            return `${deaths}${nem && nem.count > 1 ? ` · nemesis **${nem.name}** ×${nem.count}` : ''}`;
          })
        : '_nobody has been killed by another player yet_',
    )
    .setFooter({ text: 'Deaths at another player’s hands only — not all-cause deaths.' });
}

function deathsEmbed(players) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('⚰️ Hall of the Unlucky')
    .setDescription(
      listing(
        rank(players, (p) => p.deaths, { limit: 10 }),
        (r) => `${r.value} deaths · best run ${fmtHours(r.rec.bestHours)}`,
      ),
    );
}

/** Resolve user input to a real skill name: exact, then case-insensitive, then prefix. */
function resolveSkill(input, names) {
  const q = input.trim().toLowerCase();
  return (
    names.find((n) => n.toLowerCase() === q) ||
    names.find((n) => n.toLowerCase().startsWith(q)) ||
    null
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Project Zomboid server records — kills, skills, survival and deaths')
    .addStringOption((o) =>
      o
        .setName('board')
        .setDescription('Which board to show (default: overall)')
        .addChoices(
          { name: 'Overall', value: 'overall' },
          { name: 'PvP kills', value: 'kills' },
          { name: 'Most hunted', value: 'hunted' },
          { name: 'Skill champions', value: 'champions' },
          { name: 'Survival', value: 'survival' },
          { name: 'Deaths', value: 'deaths' },
        ),
    )
    .addStringOption((o) =>
      o
        .setName('skill')
        .setDescription('Top 10 for a single skill, e.g. Woodwork (overrides board)'),
    ),

  async execute(interaction) {
    const logDir = getGuildConfig(interaction.guild.id)?.zomboid?.logDir;
    if (!logDir) {
      await interaction.reply({
        content: 'No Project Zomboid server is configured for this guild.',
        flags: 64,
      });
      return;
    }

    await interaction.deferReply();

    let players;
    try {
      players = collectPlayers(logDir);
    } catch (err) {
      console.error('[Leaderboard] Failed to read PerkLog:', err?.message || err);
      await interaction.editReply("Couldn't read the server logs just now — try again shortly.");
      return;
    }

    const wanted = interaction.options.getString('skill');
    const board = wanted ? null : interaction.options.getString('board') || 'overall';
    const needsKills = board === 'kills' || board === 'hunted' || board === 'overall';

    let killData = null;
    if (needsKills) {
      try {
        killData = collectKills(logDir);
      } catch (err) {
        // Overall drops its kill field and carries on; a dedicated kill board
        // has nothing left, and says so below.
        console.error('[Leaderboard] Failed to read pvp log:', err?.message || err);
      }
    }

    // The kill boards read a different log, so they survive an empty PerkLog.
    if (board === 'kills' || board === 'hunted') {
      if (!killData) {
        await interaction.editReply("Couldn't read the PvP log just now — try again shortly.");
        return;
      }
      if (!killData.events.length) {
        await interaction.editReply('No player has killed another player on this server yet.');
        return;
      }
    } else if (!players.size && !killData?.events.length) {
      // Every other board is PerkLog-only; overall can still carry a kill field,
      // so it only counts as empty when neither log has anything.
      await interaction.editReply('No player records in the server logs yet.');
      return;
    }

    let embed;

    if (wanted) {
      const names = knownSkills(players);
      const skill = resolveSkill(wanted, names);
      if (!skill) {
        await interaction.editReply({
          content: `No skill matching **${wanted}**. Known skills:\n${names.join(', ')}`,
        });
        return;
      }
      embed = singleSkillEmbed(players, skill);
    } else {
      switch (board) {
        case 'kills':
          embed = killsEmbed(killData);
          break;
        case 'hunted':
          embed = victimsEmbed(killData);
          break;
        case 'champions':
          embed = championsEmbed(players);
          break;
        case 'survival':
          embed = survivalEmbed(players);
          break;
        case 'deaths':
          embed = deathsEmbed(players);
          break;
        default:
          embed = overallEmbed(players, killData);
      }
    }

    const living = [...players.values()].filter(isAlive).length;
    if (!embed.data.footer) {
      embed.setFooter({ text: `${living} living of ${players.size} characters on record` });
    }
    embed.setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
