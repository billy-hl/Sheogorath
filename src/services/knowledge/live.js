'use strict';
/**
 * Facts about the game server as it is right now.
 *
 * These are the questions #help actually gets — is it up, who's on, when does it
 * restart, what mods are we running — and they are the ones a language model is
 * worst at, because the honest answer changes every few minutes and nothing in
 * its training has it. Everything here is measured, never recalled.
 *
 * Cached for a minute. A busy help channel would otherwise open an RCON socket
 * and shell out to systemd once per message, and none of these answers change
 * fast enough to be worth that.
 */
const { getGuildConfig } = require('../../config/guilds');

const TTL_MS = 60 * 1000;
const cache = new Map(); // guildId -> { at, facts }

/** Round a millisecond gap into something a person would say out loud. */
function humanizeUntil(timestamp) {
  const mins = Math.round((timestamp - Date.now()) / 60000);
  if (mins < 1) return 'any moment now';
  if (mins < 60) return `in about ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `in about ${hours}h${rem ? ` ${rem}m` : ''}`;
}

/**
 * Every live fact worth knowing, as `{ label: value }`.
 *
 * Each source is isolated: the server being unreachable must still leave the
 * mod list answerable, and a host without systemd (a laptop running the bot for
 * development) must not cost us the player count. A fact that can't be
 * established is left out rather than guessed at — an absent line reads as "he
 * didn't say", where a wrong one reads as an answer.
 */
async function gather(guildId) {
  const config = getGuildConfig(guildId);
  const zomboid = config?.zomboid;
  if (!zomboid) return {};

  const facts = {};

  // --- Is it up, and who is on it? ---
  try {
    const { players } = require('../zomboid/rcon');
    const { count, names } = await players(guildId);
    facts['Server status'] = 'up and accepting players';
    facts['Players online'] = count === 0
      ? 'nobody right now'
      : `${count} — ${names.join(', ')}`;
  } catch {
    facts['Server status'] = 'not answering right now — it may be restarting, or down';
  }

  // --- When does it go down next? ---
  try {
    const { activeRestart, pendingRestart } = require('../zomboid/restart');
    const active = await activeRestart();
    if (active) {
      facts['Restart'] = 'a restart is running right now — it will be back shortly';
    } else {
      const pending = await pendingRestart();
      if (pending?.at) {
        facts['Next restart'] = `${humanizeUntil(pending.at)} (${new Date(pending.at).toISOString()})`;
      }
    }
  } catch {
    // No systemd, or the units aren't there. Silence is the right answer.
  }

  // --- What is it running? ---
  try {
    const { readServerConfig } = require('../zomboid/modCheck');
    const server = readServerConfig(
      zomboid.serverIni,
      zomboid.gameBuild,
      zomboid.logDir,
      zomboid.workshopDir,
    );
    if (server.version) facts['Game version'] = server.version;
    if (zomboid.gameBuild) facts['Build'] = `B${zomboid.gameBuild}`;
    if (server.installedMods?.length) {
      // The count only. This server runs 85 mods, and the names are 1400
      // characters that would ride along on every message including "tell me a
      // joke" — the full list is served as a retrievable document instead, so
      // it costs nothing until somebody actually asks about mods.
      facts['Mods loaded'] = `${server.installedMods.length} mods (ask for the list if you need it)`;
    }
  } catch {
    // Ini unreadable. Same reasoning as above.
  }

  return facts;
}

/** Live facts for a guild, cached for a minute. */
async function liveFacts(guildId) {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.facts;

  let facts = {};
  try {
    facts = await gather(guildId);
  } catch (err) {
    console.warn('[Knowledge] Could not gather live facts:', err?.message || err);
    // Serve the stale copy rather than nothing — a two-minute-old player count
    // is worth more than him inventing one.
    if (hit) return hit.facts;
  }

  cache.set(guildId, { at: Date.now(), facts });
  return facts;
}

/**
 * The full mod list, shaped as a retrievable document.
 *
 * A document rather than a fact so it goes through the same keyword matching
 * and budget as everything else written down: pulled in when the question is
 * about mods, absent when it isn't, and truncated rather than dropped if it
 * won't fit. Reads the ini directly rather than going through the fact cache,
 * because it is wanted rarely and the ini read is cheap.
 */
function modsDoc(guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  if (!zomboid?.serverIni) return null;

  try {
    const { readServerConfig } = require('../zomboid/modCheck');
    const server = readServerConfig(zomboid.serverIni, zomboid.gameBuild, zomboid.logDir, zomboid.workshopDir);
    if (!server.installedMods?.length) return null;

    return {
      id: 'live:mods',
      title: 'Mods installed on the server',
      tags: ['mod', 'mods', 'modlist', 'workshop', 'addon', 'addons', 'installed', 'running'],
      body: `The server runs these ${server.installedMods.length} mods, in load order:\n` +
        server.installedMods.join(', '),
      source: 'the server ini',
    };
  } catch {
    return null;
  }
}

/** Drop the cache — used after a restart, when everything here has moved. */
function clearLiveCache(guildId = null) {
  guildId ? cache.delete(guildId) : cache.clear();
}

module.exports = { liveFacts, modsDoc, clearLiveCache, TTL_MS };
