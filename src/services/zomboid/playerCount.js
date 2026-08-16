'use strict';
/**
 * Live player count in the channel list — `🧟 12/40 online`.
 *
 * A voice channel is used rather than a text one: it sits at the top of the
 * sidebar, shows its name to everyone without being opened, and nobody expects
 * to be able to talk in it. Deny Connect on it and it reads as a label.
 *
 * The whole design is shaped by one Discord limit: **a channel may be renamed
 * twice per 10 minutes**. Exceed it and the rename is not rejected loudly — the
 * request simply queues behind a very long rate-limit window, so the counter
 * appears to freeze while the bot looks healthy. That is why the poll interval
 * floors at 5 minutes and why an unchanged count skips the call entirely: the
 * budget is spent only when the number people can see has actually moved.
 */
const { getGuildConfig, guildIds, hasFeature } = require('../../config/guilds');
const { players: rconPlayers } = require('./rcon');

const DEFAULTS = {
  // Two renames per 10 minutes is the cap; 6 leaves headroom for a retry
  // without ever queueing.
  pollMinutes: 6,
  // Shown when the server is unreachable, so a dead server reads as dead
  // rather than as an empty one.
  offlineLabel: '⚫ server offline',
  template: '🧟 {count}/{max} online',
};

/** Discord's cap on a channel name. */
const NAME_LIMIT = 100;
/** Discord's floor on renames: 2 per 10 minutes. Never poll faster than this. */
const MIN_POLL_MINUTES = 5;

/** Resolve config for a guild, or null when it isn't set up. */
function countConfig(guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  const channelId = zomboid?.channels?.playerCount;
  if (!channelId) return null;
  const cfg = { ...DEFAULTS, ...(zomboid.playerCount || {}), channelId, serverIni: zomboid.serverIni };
  cfg.pollMinutes = Math.max(MIN_POLL_MINUTES, cfg.pollMinutes);
  return cfg;
}

/**
 * The server's player cap, read from the ini.
 *
 * Read fresh rather than cached: `MaxPlayers` is one of the settings that can
 * change on a restart, and a counter reading `12/40` against a server that now
 * allows 60 is worse than no counter.
 */
function maxPlayers(serverIni) {
  if (!serverIni) return null;
  try {
    const text = require('fs').readFileSync(serverIni, 'utf8');
    const m = /^MaxPlayers=(\d+)/m.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** `🧟 12/40 online`, or the offline label. */
function renderName(cfg, count, max) {
  if (count === null) return cfg.offlineLabel.slice(0, NAME_LIMIT);
  const name = cfg.template
    .replace('{count}', String(count).padStart(2, '0'))
    .replace('{max}', max === null ? '?' : String(max));
  return name.slice(0, NAME_LIMIT);
}

// Last name written per channel, so an unchanged count costs no API call and no
// rate-limit budget. In memory on purpose: on boot the first pass always writes,
// which also repairs a name left stale by a crash mid-rename.
const lastName = new Map();

/**
 * One pass for a guild.
 *
 * @returns {Promise<{name: string, changed: boolean}|null>}
 */
async function updateOnce(client, guildId) {
  const cfg = countConfig(guildId);
  if (!cfg) return null;

  let count = null;
  try {
    const result = await rconPlayers(guildId);
    count = result.count;
  } catch (err) {
    // Server down, restarting, or RCON not up yet. The offline label is the
    // honest answer; it is also what a player wants to know.
    console.warn('[Zomboid] Player count RCON failed:', err?.message || err);
  }

  const name = renderName(cfg, count, maxPlayers(cfg.serverIni));
  if (lastName.get(cfg.channelId) === name) return { name, changed: false };

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) {
    console.warn(`[Zomboid] Player count channel ${cfg.channelId} not found.`);
    return null;
  }

  try {
    await channel.setName(name, 'Live player count');
    lastName.set(cfg.channelId, name);
    return { name, changed: true };
  } catch (err) {
    // A 429 here means the budget was spent; the next pass will retry with
    // whatever the count is then, which is more useful than replaying this one.
    console.warn('[Zomboid] Could not rename player count channel:', err?.message || err);
    return { name, changed: false };
  }
}

/** Start polling for every guild that has a player-count channel configured. */
function schedulePlayerCount(client) {
  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'zomboid')) continue;
    const cfg = countConfig(guildId);
    if (!cfg) continue;

    const run = () => {
      updateOnce(client, guildId).catch((err) =>
        console.error('[Zomboid] Player count update failed:', err?.message || err));
    };

    run(); // paint it immediately on boot rather than after the first interval
    setInterval(run, cfg.pollMinutes * 60 * 1000);
    console.log(`[Zomboid] Player count armed for ${guildId} every ${cfg.pollMinutes}m.`);
  }
}

module.exports = {
  DEFAULTS,
  MIN_POLL_MINUTES,
  countConfig,
  maxPlayers,
  renderName,
  updateOnce,
  schedulePlayerCount,
};
