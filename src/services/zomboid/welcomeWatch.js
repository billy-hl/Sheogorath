'use strict';
/**
 * Greets players in-game as they connect.
 *
 * The join is taken from the game's own `user` log rather than from RCON: the
 * `players` command tells you who is connected *now*, so polling it can only
 * ever infer an arrival by diffing two snapshots, and a player who joins and
 * leaves between ticks is missed entirely. The log line is the event itself.
 *
 * The greeting goes out over `servermsg`, which is a **broadcast** — everyone
 * online sees it, not just the arriving player. PZ has no per-player message
 * command, so this is addressed to the joiner but read by the room, which is
 * why the copy stays short.
 *
 * The name is the **account username**, which is what the log carries and what
 * the game shows in chat. The roleplay character name lives only in
 * `players.db` and is absent for anyone who has connected but never spawned,
 * so it would make the greeting fail exactly when someone is brand new.
 *
 * Every join is greeted, by design — no first-time-only bookkeeping here.
 */
const { getGuildConfig, guildIds, hasFeature } = require('../../config/guilds');
const { linesSince, JOINED } = require('./logs');
const { serverMessage } = require('./rcon');

const DEFAULTS = {
  // Someone is walking into the world as this fires, so it runs warm — but not
  // as hot as linkWatch, where a person is actively waiting at a prompt. A
  // greeting that lands a few seconds after the loading screen clears reads
  // better than one that races it.
  pollSeconds: 20,
  // `{name}` is the account username. Guild-specific wording belongs in
  // guilds.json; this default is deliberately plain.
  template: 'Welcome to the server, {name}.',
  // A crash-looping client can reconnect several times a minute. Greeting each
  // one would turn a bad connection into a broadcast spam. Well under a normal
  // session, well over a reconnect storm.
  regreetSeconds: 300,
};

/** Bound the per-guild recent-greeting map so a long uptime can't grow it. */
const MAX_TRACKED = 500;

/** Resolve watcher config for a guild, or null when it can't run. */
function welcomeConfig(guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  if (!zomboid?.logDir) return null;
  const cfg = { logDir: zomboid.logDir, ...DEFAULTS, ...(zomboid.welcomeWatch || {}) };
  if (cfg.enabled === false) return null;
  return cfg;
}

const watermark = new Map();      // guildId -> epoch ms already processed
const lastGreeted = new Map();    // guildId -> Map(name -> epoch ms)

function recentlyGreeted(guildId, name, now, regreetMs) {
  const seen = lastGreeted.get(guildId);
  if (!seen) return false;
  const at = seen.get(name);
  return at !== undefined && now - at < regreetMs;
}

function noteGreeted(guildId, name, now) {
  let seen = lastGreeted.get(guildId);
  if (!seen) {
    seen = new Map();
    lastGreeted.set(guildId, seen);
  }
  if (seen.size >= MAX_TRACKED) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  seen.set(name, now);
}

/**
 * One pass for a guild.
 *
 * @returns {Promise<string[]>} the usernames greeted this pass
 */
async function checkOnce(guildId, now = Date.now()) {
  const cfg = welcomeConfig(guildId);
  if (!cfg) return [];

  const floor = watermark.get(guildId) ?? now;
  // Enough overlap to survive a missed tick without re-reading the whole log.
  const since = Math.min(floor, now - cfg.pollSeconds * 1000 * 3);
  let highest = floor;

  const greeted = [];

  for (const { at, line } of linesSince(cfg.logDir, 'user', since)) {
    // A second of slack under the watermark: log stamps have one-second
    // granularity, so a join in the same second as an already-processed line
    // would otherwise fall behind the mark and never be seen. The re-greet
    // guard below is what makes reading a line twice harmless.
    if (at < floor - 1000) continue;
    if (at > highest) highest = at;

    const m = JOINED.exec(line);
    if (!m) continue;
    const name = m[2];
    if (!name) continue;

    if (recentlyGreeted(guildId, name, now, cfg.regreetSeconds * 1000)) continue;
    noteGreeted(guildId, name, now);

    try {
      await serverMessage(guildId, cfg.template.replace('{name}', name));
      greeted.push(name);
      console.log(`[Zomboid] Welcomed ${name}.`);
    } catch (err) {
      // The usual cause is the server being down or mid-restart, in which case
      // there is nobody in-game to read the greeting anyway. Not worth an
      // error notification — the arrival is simply not announced.
      console.warn(`[Zomboid] Could not welcome ${name}:`, err?.message || err);
    }
  }

  watermark.set(guildId, Math.max(floor, highest + 1));
  return greeted;
}

/**
 * Start polling for every guild with a Zomboid server configured.
 *
 * Takes no client: the greeting is delivered in-game over RCON and never
 * touches Discord.
 */
function scheduleWelcomeWatch() {
  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'zomboid')) continue;
    const cfg = welcomeConfig(guildId);
    if (!cfg) continue;

    // Only ever look forward. Everyone already in the world when the bot
    // restarts was greeted on their way in — or joined while it was down, in
    // which case a greeting now would arrive long after they stopped arriving.
    watermark.set(guildId, Date.now());

    setInterval(() => {
      checkOnce(guildId).catch((err) =>
        console.error('[Zomboid] Welcome watch failed:', err?.message || err));
    }, cfg.pollSeconds * 1000);

    console.log(`[Zomboid] Join welcome armed for ${guildId} every ${cfg.pollSeconds}s.`);
  }
}

module.exports = { welcomeConfig, checkOnce, scheduleWelcomeWatch, DEFAULTS };
