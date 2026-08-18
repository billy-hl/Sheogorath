'use strict';
/**
 * Welcomes people the first time they join the Discord guild.
 *
 * **First time ever, not first time this session.** Discord fires
 * `guildMemberAdd` on every join, and people leave and come back — after a
 * ban appeal, a purge, or just a rage-quit. Greeting a returning member as if
 * they were new is worse than saying nothing, so the greeting is recorded
 * against the user in `state.json` and never repeats.
 *
 * That record is the reason this doesn't use `member.joinedAt`: that field is
 * the *current* membership, so it resets on a rejoin and would make every
 * returning member look brand new.
 *
 * Guilds opt in by setting `channels.welcome`. Without it the handler is inert,
 * which is deliberate — a bot that starts posting in a guessed channel is worse
 * than one that stays quiet until it's pointed somewhere.
 */
const { getGuildConfig } = require('../config/guilds');
const { getUserActivity, setUserActivity } = require('../storage/state');

/**
 * No emoji, by standing instruction — the server's public voice is plain, and
 * emoji headers read as generic bot output rather than the server's own.
 */
const DEFAULT_MESSAGE =
  'Welcome, {mention}. Check **#server-info** for how to connect and **#rules** ' +
  'before you head out. Ask in here if you get stuck.';

/**
 * Has this user ever been welcomed in this guild?
 *
 * Read from the same per-user record the activity tracker uses, so a member
 * carries one row rather than one per feature.
 */
function alreadyWelcomed(guildId, userId) {
  return !!getUserActivity(guildId, userId)?.welcomedAt;
}

/**
 * Greet a new member, if they're new and the guild has a welcome channel.
 *
 * Errors are swallowed and logged: a failed greeting must never take down the
 * event handler, and there is nothing useful to retry — the person is already
 * in the door.
 *
 * @returns {Promise<boolean>} whether a greeting was actually sent
 */
async function welcomeMember(client, member) {
  try {
    // Bots are added by staff, not welcomed.
    if (member.user?.bot) return false;

    const guildId = member.guild?.id;
    const userId = member.user?.id;
    if (!guildId || !userId) return false;

    const channelId = getGuildConfig(guildId)?.channels?.welcome;
    if (!channelId) return false;

    if (alreadyWelcomed(guildId, userId)) {
      console.log(`[Welcome] ${member.user.tag} has been welcomed before — skipping.`);
      return false;
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      console.warn(`[Welcome] Channel ${channelId} for guild ${guildId} is missing or not text.`);
      return false;
    }

    const template = getGuildConfig(guildId)?.welcomeMessage || DEFAULT_MESSAGE;
    await channel.send(template.replace('{mention}', `<@${userId}>`));

    // Written only after the send succeeds. If the post failed, the next join
    // event is still allowed to greet them.
    setUserActivity(guildId, userId, { welcomedAt: new Date().toISOString() });
    console.log(`[Welcome] Greeted ${member.user.tag} in ${member.guild.name}.`);
    return true;
  } catch (err) {
    console.error('[Welcome] Failed to welcome member:', err?.message || err);
    return false;
  }
}

module.exports = { welcomeMember, alreadyWelcomed, DEFAULT_MESSAGE };
