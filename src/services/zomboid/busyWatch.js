'use strict';
/**
 * Pings staff when the Project Zomboid server declares itself overloaded.
 *
 * PZ has its own overload guard, and when it trips it says so in the debug log:
 *
 *   Server is too busy. Server will drop updates of vehicle's physics.
 *   Server is closed for new connections..
 *
 * That is not a warning about the future — by the time it prints, the server is
 * already shedding vehicle physics and refusing logins. Players experience it as
 * desync and as "I can't join", and until now the only way to find it was to
 * notice complaints and go read logs by hand.
 *
 * This is deliberately built on PZ's own signal rather than a threshold of our
 * own. A homemade rule ("alert if the sim thread is over 80%") needs constant
 * retuning as the world, mod list and player count change; the engine's guard
 * defines overload the way the engine actually acts on it. On the day this was
 * written the count sat at 0 all afternoon and then fired 11 times inside twenty
 * minutes when a zombie clump built up — silent when healthy, loud when not.
 *
 * Alerts are rate-limited: a sustained incident prints this line repeatedly, and
 * staff need one ping with a count, not one ping every poll for an hour.
 */
const { getGuildConfig } = require('../../config/guilds');
const { linesSince } = require('./logs');
const { players: rconPlayers } = require('./rcon');

// PZ writes this into `<date>_<time>_DebugLog-server.txt`.
const LOG_KIND = 'DebugLog-server';
const TOO_BUSY = /Server is too busy/;

const DEFAULTS = {
  pollMinutes: 2,
  // Don't ping again inside this window; the follow-up count covers the gap.
  cooldownMinutes: 15,
  // Quiet for this long after an incident before saying it has passed.
  recoveryMinutes: 10,
};

function busyConfig(guildId) {
  const guild = getGuildConfig(guildId);
  const zomboid = guild?.zomboid;
  if (!zomboid?.logDir) return null;
  // Staff-facing, so prefer the private staff log. Note commandLog sits on the
  // guild's own channels, not under zomboid.channels — reading it from the wrong
  // one silently falls through to raidAlerts, which players can see.
  const channelId = guild?.channels?.commandLog || zomboid.channels?.raidAlerts;
  if (!channelId) return null;
  return {
    logDir: zomboid.logDir,
    channelId,
    staffRoleId: guild?.roles?.staff || null,
    ...DEFAULTS,
    ...(zomboid.busyWatch || {}),
  };
}

// In-memory, like the raid watcher: the watermark starts at process start, so a
// restart can never replay this morning's overload into the channel.
const state = new Map(); // guildId -> { watermark, lastAlertAt, alerting, seen }

/** How many times PZ declared itself too busy since `sinceMs`. */
function countBusy(logDir, sinceMs) {
  let n = 0;
  let latest = sinceMs;
  for (const { at, line } of linesSince(logDir, LOG_KIND, sinceMs)) {
    if (!TOO_BUSY.test(line)) continue;
    n++;
    if (at > latest) latest = at;
  }
  return { count: n, latest };
}

function formatAlert(count, minutes, online) {
  const who = online === null ? '' : ` with **${online}** online`;
  return (
    `⚠️ **The server is overloaded.**\n` +
    `PZ tripped its own overload guard **${count}×** in the last ${minutes} minute` +
    `${minutes === 1 ? '' : 's'}${who}.\n\n` +
    `While this is happening the server **drops vehicle physics and refuses new ` +
    `connections** — players will report desync, rubber-banding, and being unable ` +
    `to join.\n\n` +
    `Most often this is something concentrated: a large clump of zombies, a pile ` +
    `of corpses, or a lot of vehicles in one place. Finding *where* is the job — ` +
    `ask in-game who is lagging and roughly where they are.`
  );
}

/** Run one pass for a guild. Returns what it did, for tests and logging. */
async function checkOnce(client, guildId, now = Date.now()) {
  const cfg = busyConfig(guildId);
  if (!cfg) return { skipped: true };

  const st = state.get(guildId) || { watermark: now, lastAlertAt: 0, alerting: false, seen: 0 };
  const { count } = countBusy(cfg.logDir, st.watermark);
  st.watermark = now;

  let action = 'quiet';

  if (count > 0) {
    st.seen += count;
    const cooledDown = now - st.lastAlertAt >= cfg.cooldownMinutes * 60 * 1000;
    if (!st.alerting || cooledDown) {
      let online = null;
      try {
        ({ count: online } = await rconPlayers(guildId));
      } catch {
        // Server may be too busy to answer RCON — which is itself the point.
      }

      const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
      if (channel) {
        const ping = cfg.staffRoleId ? `<@&${cfg.staffRoleId}> ` : '';
        const minutes = Math.max(1, Math.round((now - (st.lastAlertAt || now - cfg.pollMinutes * 60000)) / 60000));
        await channel.send({
          content: ping + formatAlert(st.seen, st.alerting ? minutes : cfg.pollMinutes, online),
          allowedMentions: { roles: cfg.staffRoleId ? [cfg.staffRoleId] : [] },
        });
        console.log(`[Zomboid] Overload alert for ${guildId}: ${st.seen} event(s).`);
      }
      st.lastAlertAt = now;
      st.alerting = true;
      st.seen = 0;
      action = 'alerted';
    } else {
      action = 'suppressed';
    }
  } else if (st.alerting && now - st.lastAlertAt >= cfg.recoveryMinutes * 60 * 1000) {
    const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
    if (channel) {
      await channel.send(
        `✅ **Server load has settled.** No overload events for ` +
        `${cfg.recoveryMinutes} minutes — vehicle physics and new connections are ` +
        `back to normal.`,
      );
    }
    st.alerting = false;
    st.seen = 0;
    action = 'recovered';
  }

  state.set(guildId, st);
  return { action, count };
}

/** Start polling for every guild with a Zomboid log dir and a staff channel. */
function scheduleBusyWatch(client) {
  const { guildIds, hasFeature } = require('../../config/guilds');

  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'zomboid')) continue;
    const cfg = busyConfig(guildId);
    if (!cfg) continue;

    state.set(guildId, { watermark: Date.now(), lastAlertAt: 0, alerting: false, seen: 0 });

    setInterval(() => {
      checkOnce(client, guildId).catch((err) =>
        console.error('[Zomboid] Overload watch failed:', err?.message || err));
    }, cfg.pollMinutes * 60 * 1000);

    console.log(`[Zomboid] Overload watch armed for ${guildId} every ${cfg.pollMinutes}m.`);
  }
}

module.exports = {
  countBusy,
  formatAlert,
  busyConfig,
  checkOnce,
  scheduleBusyWatch,
  DEFAULTS,
  LOG_KIND,
  TOO_BUSY,
};
