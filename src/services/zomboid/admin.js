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

/**
 * Heal a player to full, by flicking god mode on and straight back off.
 *
 * WHY THIS WORKS, AND WHY IT NEEDS THE PAUSE
 * There is no heal command in PZ. `setGodMod` itself only sets a flag -- it does
 * not touch health. The healing happens in BodyDamage.Update(), which checks
 * isGodMod() and calls RestoreToFullHealth() on that pass. So the cure arrives
 * on the next body-damage tick WHILE the flag is set, not when the flag is set.
 *
 * Toggling on and off back-to-back is therefore a race: it heals only if an
 * update happens to land in the gap. At a healthy ~10 ticks/sec it usually does;
 * at the 3.5 ticks/sec this server saw on 2026-08-28 it often would not, and the
 * command would report success having done nothing. HOLD_MS is generous enough
 * that even a struggling server gets several passes.
 *
 * God mode is turned off again even if the wait is interrupted, because leaving
 * a player invincible on a PvP server is a far worse failure than not healing.
 */
const HEAL_HOLD_MS = 2500;

async function heal(guildId, who) {
  await act(guildId, `godmodplayer ${q(who)} -true`, who);
  try {
    await new Promise((resolve) => setTimeout(resolve, HEAL_HOLD_MS));
  } finally {
    // Not inside the try: this must run whatever happened above.
    await act(guildId, `godmodplayer ${q(who)} -false`, who);
  }
  return `Healed ${who}.`;
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
  heal,
  invisible,
  noclip,
};
