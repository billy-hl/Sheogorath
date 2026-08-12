'use strict';
/**
 * Skill level → XP maths for `/pz setlevel`.
 *
 * RCON only offers `addxp`, which *adds* raw XP; there is no "set this skill to
 * level 6". So to land someone on a level we need two things the console won't
 * give us: the curve, and where they currently sit on it.
 *
 * **The curve** is compiled into projectzomboid.jar — `PerkFactory` builds it in
 * Java and nothing in media/lua carries a readable copy (the Lua UI just calls
 * `perk:getTotalXpForLevel()`). The table below is therefore the standard
 * progression, entered by hand, and is the one part of this file that has not
 * been verified against the running build. Sanity-check it on one skill before
 * trusting it wholesale, and correct it here if the build disagrees.
 *
 * **Fitness and Strength are deliberately unsupported.** They run on their own
 * curve, and an unverified guess at a *different* curve is how you accidentally
 * hand someone Strength 10. They fall through to `/pz addxp` instead.
 */

/**
 * Cost to climb *into* each level, for a standard skill. Index = target level,
 * so LEVEL_COST[3] is the XP for level 2 → 3.
 */
const LEVEL_COST = [0, 75, 150, 300, 750, 1500, 3000, 4500, 6000, 7500, 9000];

/** Vanilla ceiling. `XpUpdate.lua` bounds its own level checks at 10 too. */
const MAX_LEVEL = LEVEL_COST.length - 1;

const UNSUPPORTED = new Set(['Fitness', 'Strength']);

/** Cumulative XP required to hold `level` from a standing start. */
function totalXpForLevel(level) {
  let total = 0;
  for (let i = 1; i <= level; i++) total += LEVEL_COST[i];
  return total;
}

/**
 * Work out the grant that takes `from` up to `target`.
 *
 * The number is the gap between the two thresholds, which means a player part
 * way through their current level lands slightly *past* the target rather than
 * short of it. That asymmetry is on purpose: overshooting into a bit of extra
 * progress is recoverable, arriving one XP short of the level the staff member
 * just promised is not.
 *
 * @param {string} skill
 * @param {number} from current level
 * @param {number} target wanted level
 * @returns {{ grant: number, from: number, target: number }}
 * @throws {Error} with a player-safe `.message` when the request can't be met
 */
function plan(skill, from, target) {
  if (UNSUPPORTED.has(skill)) {
    const err = new Error(
      `**${skill}** runs on its own XP curve that isn't readable from the server files, ` +
        `so this command won't guess at it. Use \`/pz addxp\` to grant it by hand.`,
    );
    err.userFacing = true;
    throw err;
  }

  if (!Number.isInteger(target) || target < 1 || target > MAX_LEVEL) {
    const err = new Error(`Target level must be between 1 and ${MAX_LEVEL}.`);
    err.userFacing = true;
    throw err;
  }

  if (from >= target) {
    const err = new Error(
      `They're already **${skill} ${from}** — XP can only be added, never taken away.`,
    );
    err.userFacing = true;
    throw err;
  }

  return { grant: totalXpForLevel(target) - totalXpForLevel(from), from, target };
}

module.exports = {
  LEVEL_COST,
  MAX_LEVEL,
  UNSUPPORTED,
  totalXpForLevel,
  plan,
};
