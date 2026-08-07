'use strict';
/**
 * Sweeps dead offers off the trading board.
 *
 * A trading forum is only useful if what's on it is still available, and
 * people reliably forget to close their own posts. So an offer with no
 * activity for `staleDays` is tagged Expired and archived — it stays readable
 * and searchable, it just stops occupying the live board.
 *
 * Idleness is measured from the last message in the thread, not from when it
 * was posted, so an offer people are still haggling over never expires. The
 * timestamp comes out of the message snowflake rather than a fetch, which
 * keeps a sweep of a hundred offers to a single API call.
 */
const { ChannelType, SnowflakeUtil } = require('discord.js');
const { TAG, TRADING } = require('./spec');
const { applyStatusTag } = require('./handler');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_HOURS = 6;

/** Statuses that mean "still on the board". Anything else is already resolved. */
const LIVE_STATUSES = new Set([TAG.OPEN, TAG.PENDING]);

/** When this thread last saw activity, in epoch ms. */
function lastActivityAt(thread) {
  if (thread.lastMessageId) {
    return Number(SnowflakeUtil.timestampFrom(thread.lastMessageId));
  }
  return thread.createdTimestamp || Date.now();
}

/**
 * One pass over a guild's trading forum.
 *
 * @returns {Promise<{checked:number, swept:string[]}>}
 */
async function sweepOnce(client, guildId, { staleDays = TRADING.staleDays, dryRun = false } = {}) {
  const { getGuildConfig } = require('../../config/guilds');
  const config = getGuildConfig(guildId);
  const channelId = config?.channels?.trading;
  if (!channelId) return { checked: 0, swept: [] };

  const guild = await client.guilds.fetch(guildId);
  const forum = await guild.channels.fetch(channelId).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) return { checked: 0, swept: [] };

  const tagName = new Map(forum.availableTags.map((t) => [t.id, t.name]));
  const cutoff = Date.now() - staleDays * 24 * HOUR_MS;

  // Only the moderated tags carry status. Category tags like WTS and Weapons
  // must not count here, or an offer tagged WTS but never given a status would
  // read as "already resolved" and sit on the board forever.
  const statusNames = new Set(TRADING.tags.filter((t) => t.moderated).map((t) => t.name));

  const { threads } = await forum.threads.fetchActive();
  const swept = [];

  for (const thread of threads.values()) {
    if (thread.archived) continue;

    const statuses = thread.appliedTags
      .map((id) => tagName.get(id))
      .filter((n) => statusNames.has(n));
    // An offer already marked Completed or Expired is done; leave it be. An
    // offer with no status at all is fair game.
    if (statuses.length && !statuses.some((s) => LIVE_STATUSES.has(s))) continue;
    if (lastActivityAt(thread) > cutoff) continue;

    if (dryRun) {
      swept.push(thread.name);
      continue;
    }

    try {
      await applyStatusTag(thread, TRADING, TAG.EXPIRED);
      await thread.send(
        `This offer has gone quiet for ${staleDays} days, so it's been taken off the board. ` +
        `Still available? Post a new offer — or say something here and a staff member can reopen it.`
      );
      // Archive last: a locked/archived thread can't be tagged or posted in.
      await thread.setArchived(true, 'Stale trading offer');
      swept.push(thread.name);
    } catch (err) {
      console.warn(`[Trading] Could not sweep "${thread.name}":`, err?.message || err);
    }
  }

  return { checked: threads.size, swept };
}

/**
 * Arm the periodic sweep for every guild that has a trading forum.
 *
 * Deliberately not run on boot — a restart shouldn't produce a burst of
 * expiries, and waiting one interval costs nothing on a multi-day threshold.
 */
function scheduleTradeSweep(client) {
  const { guildIds, getGuildConfig, hasFeature } = require('../../config/guilds');

  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'forums')) continue;
    const config = getGuildConfig(guildId);
    if (!config?.channels?.trading) continue;

    const staleDays = config.tradingStaleDays || TRADING.staleDays;
    const everyHours = config.tradingSweepHours || DEFAULT_SWEEP_HOURS;

    setInterval(() => {
      sweepOnce(client, guildId, { staleDays })
        .then(({ checked, swept }) => {
          if (swept.length) {
            console.log(`[Trading] Swept ${swept.length}/${checked} stale offer(s): ${swept.join('; ')}`);
          }
        })
        .catch((err) => console.error('[Trading] Sweep failed:', err?.message || err));
    }, everyHours * HOUR_MS);

    console.log(`[Trading] Stale sweep armed for ${guildId}: every ${everyHours}h, offers idle ${staleDays}d.`);
  }
}

module.exports = { sweepOnce, scheduleTradeSweep, lastActivityAt, LIVE_STATUSES };
