'use strict';
/**
 * The role everyone gets on the way in.
 *
 * Driven entirely by `roles.onJoin` in config/guilds.json. There is no entry in
 * FEATURES for this: "the guild has not named a role" is already the off
 * switch, and a second one would only be a way for the two to disagree.
 *
 * Membership screening is the wrinkle. A guild with a rules gate admits people
 * as `pending`, and Discord reports their acceptance as a member *update*, not
 * a second join — so a bot that only listens for joins silently stops working
 * the day someone turns screening on. Both events are handled here: the join
 * grants immediately when there is no gate, and the update catches the
 * pending -> accepted flip when there is one.
 */
const { getGuildConfig } = require('../config/guilds');

async function grant(member, why) {
  // A bot did not read the rules and does not need the badge for having done so.
  if (member.user.bot) return;

  const roleId = getGuildConfig(member.guild.id)?.roles?.onJoin;
  if (!roleId) return;
  if (member.roles.cache.has(roleId)) return;

  const role = member.guild.roles.cache.get(roleId)
    || await member.guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    console.warn(`[AutoRole] ${member.guild.name}: roles.onJoin ${roleId} is not a role in this guild.`);
    return;
  }

  // Discord refuses grants of a role at or above the bot's own highest, and the
  // failure reads as a bare 50013 — worth saying out loud, because the fix is
  // dragging one role in the guild settings, not anything in this file.
  const me = member.guild.members.me;
  if (!me || role.position >= me.roles.highest.position) {
    console.warn(`[AutoRole] ${member.guild.name}: cannot grant "${role.name}" — it sits at or above my own highest role.`);
    return;
  }

  try {
    await member.roles.add(role, `autorole on ${why}`);
    console.log(`[AutoRole] ${member.guild.name}: gave "${role.name}" to ${member.user.tag} (${why}).`);
  } catch (err) {
    console.warn(`[AutoRole] ${member.guild.name}: could not give "${role.name}" to ${member.user.tag}: ${err?.message || err}`);
  }
}

async function onGuildMemberAdd(member) {
  // Pending means a screening gate is up and they have not passed it yet.
  // The update handler picks them up when they do.
  if (member.pending) return;
  await grant(member, 'join');
}

async function onGuildMemberUpdate(oldMember, newMember) {
  if (oldMember?.pending && !newMember.pending) await grant(newMember, 'screening accepted');
}

module.exports = { onGuildMemberAdd, onGuildMemberUpdate };
