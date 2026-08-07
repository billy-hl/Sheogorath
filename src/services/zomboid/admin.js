'use strict';
/**
 * Admin actions against the Project Zomboid server, behind `/pz`.
 *
 * These wrap RCON commands whose exact spelling was taken from the running
 * server's own `help` output — the in-game help text disagrees with the
 * registered command names in two places (`godmodplayer` is documented as
 * `/godmodeplayer`, `kick` as `/kickuser`), and both spellings are accepted, so
 * the names here are the ones verified to work rather than the documented ones.
 *
 * The bigger job is telling success from failure. PZ's RCON always exits 0 and
 * reports problems as English prose that differs per command — "No such user",
 * "User x not found.", "Can't find player x" — so every wrapper checks the reply
 * text. Without that, a `/pz giveitem` aimed at a misspelled name would report
 * cheerful success and hand over nothing.
 *
 * Note there is no admin *body* on the other end of RCON: the console isn't a
 * player. That rules out the self-targeted variants (`godmod`, `invisible`,
 * `teleport` with one argument) and is why everything here takes an explicit
 * target player.
 */
const { rcon, sanitizeArg } = require('./rcon');

/**
 * Replies that mean "that player isn't here". Matched case-insensitively
 * against the whole reply, since the wording varies by command.
 */
const NOT_FOUND = [
  'no such user',
  "doesn't exist",
  'not found',
  "can't find player",
  'unknown player',
];

/** Quote and flatten a value for PZ's quote-delimited console parser. */
function q(value) {
  return `"${sanitizeArg(value)}"`;
}

/**
 * Run an admin command and turn a "player missing" reply into a thrown error.
 *
 * @param {string} guildId
 * @param {string} command
 * @param {string} [subject] the player the command targeted, for the message
 * @returns {Promise<string>} the server's reply
 * @throws {Error} when the server reported the target doesn't exist
 */
async function act(guildId, command, subject) {
  const reply = await rcon(guildId, command);
  const lc = reply.toLowerCase();
  if (NOT_FOUND.some((needle) => lc.includes(needle))) {
    const who = subject ? `**${subject}**` : 'that player';
    const err = new Error(`${who} isn't on the server right now.`);
    err.notFound = true;
    throw err;
  }
  return reply;
}

/**
 * Move one player to another.
 *
 * `teleportplayer` rather than `teleport`: the two-argument form of `teleport`
 * does the same thing, but its one-argument form teleports *the caller*, which
 * from RCON has no meaning. Using the unambiguous command avoids a silent no-op
 * if an argument ever goes missing.
 */
function teleport(guildId, who, target) {
  return act(guildId, `teleportplayer ${q(who)} ${q(target)}`, who);
}

/** Kick a player, with an optional reason shown to them. */
function kick(guildId, who, reason) {
  const suffix = reason ? ` -r ${q(reason)}` : '';
  return act(guildId, `kickuser ${q(who)}${suffix}`, who);
}

/**
 * Give an item.
 *
 * @param {string} itemId internal ID, e.g. `Base.Axe` — resolve display names
 *   through services/zomboid/items.js before calling.
 */
function giveItem(guildId, who, itemId, count = 1) {
  return act(guildId, `additem ${q(who)} ${q(itemId)} ${Math.max(1, Math.floor(count))}`, who);
}

/**
 * Grant XP in one skill.
 *
 * The trailing `-true` would apply the server's XP multiplier; it's omitted so
 * the number granted is the number asked for.
 */
function addXp(guildId, who, perk, amount) {
  return act(guildId, `addxp ${q(who)} ${sanitizeArg(perk)}=${Math.floor(amount)}`, who);
}

/** Invincibility. */
function godMode(guildId, who, on) {
  return act(guildId, `godmodplayer ${q(who)} -${on ? 'true' : 'false'}`, who);
}

/** Invisibility to zombies. */
function invisible(guildId, who, on) {
  return act(guildId, `invisibleplayer ${q(who)} -${on ? 'true' : 'false'}`, who);
}

/** Walk through walls. */
function noclip(guildId, who, on) {
  return act(guildId, `noclip ${q(who)} -${on ? 'true' : 'false'}`, who);
}

module.exports = {
  teleport,
  kick,
  giveItem,
  addXp,
  godMode,
  invisible,
  noclip,
};
