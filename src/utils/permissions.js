'use strict';
const { PermissionFlagsBits } = require('discord.js');
const { getGuildConfig, hasFeature } = require('../config/guilds');

/**
 * Which feature each command belongs to. Commands absent from this map are
 * unconditional and register everywhere.
 *
 * One map drives both halves of the policy — which commands a guild gets
 * registered, and whether an invocation is allowed — so registration and the
 * runtime gate can't drift apart.
 */
const COMMAND_FEATURES = {
  play: 'music',
  pause: 'music',
  resume: 'music',
  skip: 'music',
  stop: 'music',
  queue: 'music',
  clear: 'music',
  remove: 'music',
  nowplaying: 'music',
  playlist: 'music',
  radio: 'music',
  autoplay: 'music',

  mod: 'moderation',
  stats: 'moderation',
  automod: 'automod',

  leaderboard: 'zomboid',
  pz: 'zomboid',
  character: 'zomboid',
};

/** Music additionally requires admin, not just the feature. */
const MUSIC_COMMANDS = new Set(
  Object.keys(COMMAND_FEATURES).filter((name) => COMMAND_FEATURES[name] === 'music')
);

/**
 * Commands that need the in-game staff tier (Sheriff) rather than full bot
 * admin. Admins pass these too — isStaff() subsumes isAdmin().
 */
const STAFF_COMMANDS = new Set(['pz']);

/**
 * Subcommands that need full admin even though their parent command doesn't.
 *
 * `/pz access` hands out in-game power rather than using it: a Sheriff who could
 * run it could make themselves `admin`, which would turn the whole staff tier
 * into a formality. Everything else under `/pz` is bounded — a Sheriff can
 * teleport a player, not change who is allowed to.
 */
const ADMIN_SUBCOMMANDS = {
  pz: new Set(['access']),
};

/**
 * Whether a member counts as an admin in their guild.
 *
 * Three independent grants, any of which is enough: Discord's own Administrator
 * permission, the bot owner, or a per-guild role named in config/guilds.json.
 * The configured role exists so a guild can hand out bot admin without handing
 * out Administrator on the whole server — a guild whose admin roles already
 * carry Administrator doesn't need to set it.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isAdmin(member) {
  if (!member || !member.guild) return false;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.id === process.env.ADMIN_USER_ID) return true;

  const adminRoleId = getGuildConfig(member.guild.id)?.roles.admin;
  return !!adminRoleId && member.roles.cache.has(adminRoleId);
}

/**
 * Whether a member holds the in-game staff tier — the rung between admin and
 * VIP that carries the Project Zomboid admin commands.
 *
 * Admins are staff by definition, so the ladder stays a ladder: anything a
 * Sheriff can do, an Owner can do. Kept separate from isAdmin() because the
 * grants are different in kind — a Sheriff is trusted with the game server, not
 * with the bot's moderation and automod surfaces.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isStaff(member) {
  if (isAdmin(member)) return true;
  if (!member || !member.guild) return false;

  const staffRoleId = getGuildConfig(member.guild.id)?.roles.staff;
  return !!staffRoleId && member.roles.cache.has(staffRoleId);
}

/**
 * Gate for the music surfaces that aren't slash commands — the now-playing
 * buttons and reactions, which anyone who can see the card can trigger.
 * @returns {string|null} a refusal message, or null when allowed.
 */
function musicDenialReason(guildId, member) {
  if (!hasFeature(guildId, 'music')) return '❌ Music is not enabled in this server.';
  if (!isAdmin(member)) return '❌ Music controls are admin-only.';
  return null;
}

/**
 * Gate for slash commands. Filtering at registration should mean a disabled
 * command is never invokable, so the feature branch here is defence in depth
 * against a stale registration.
 *
 * @param {string|null} [subcommand] the invoked subcommand, for the entries in
 *   ADMIN_SUBCOMMANDS. Checked here rather than inside the command so a refusal
 *   is still recorded as one in the audit log.
 * @returns {string|null} a refusal message, or null when allowed.
 */
function commandDenialReason(commandName, guildId, member, subcommand = null) {
  const required = COMMAND_FEATURES[commandName];
  if (required && !hasFeature(guildId, required)) {
    return '❌ That command is not enabled in this server.';
  }
  if (MUSIC_COMMANDS.has(commandName) && !isAdmin(member)) {
    return '❌ Music controls are admin-only.';
  }
  if (STAFF_COMMANDS.has(commandName) && !isStaff(member)) {
    return '❌ Server admin commands are limited to Sheriffs and Owners.';
  }
  if (subcommand && ADMIN_SUBCOMMANDS[commandName]?.has(subcommand) && !isAdmin(member)) {
    return `❌ \`/${commandName} ${subcommand}\` is Owners-only — it grants in-game power rather than using it.`;
  }
  return null;
}

/**
 * The command list a given guild should have registered. Feature-gated commands
 * are withheld entirely from guilds without the feature, so they don't clutter
 * the picker with entries that would only ever be refused.
 *
 * @param {Array<{name: string}>} allCommands
 * @param {string} guildId
 */
function commandsForGuild(allCommands, guildId) {
  return allCommands.filter((c) => {
    const required = COMMAND_FEATURES[c.name];
    return !required || hasFeature(guildId, required);
  });
}

module.exports = {
  isAdmin,
  isStaff,
  COMMAND_FEATURES,
  MUSIC_COMMANDS,
  STAFF_COMMANDS,
  ADMIN_SUBCOMMANDS,
  musicDenialReason,
  commandDenialReason,
  commandsForGuild,
};
