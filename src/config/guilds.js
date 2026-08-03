'use strict';
/**
 * Per-guild configuration.
 *
 * Guild, channel and role IDs are not secrets, so they live in a committed
 * JSON file rather than .env. That keeps .env to credentials only, and makes
 * onboarding a second guild an edit to one file instead of a pile of new
 * env vars that would have had to be named per-guild anyway.
 *
 * On first run the file is seeded from the legacy env vars and the constants
 * that used to be inlined across the codebase, so an existing single-guild
 * deployment keeps behaving identically without anyone touching anything.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'guilds.json');

// Placeholder keys (e.g. "REPLACE_WITH_ZOMBOID_GUILD_ID") are intentionally
// tolerated in the file so the shape is self-documenting — they're skipped
// everywhere rather than being registered against or looked up.
const SNOWFLAKE = /^[0-9]{17,20}$/;

/**
 * Every feature that can be switched on per guild. A guild only runs what it
 * lists — a Zomboid server has no use for the stream watcher or the Instagram
 * downloader, and gating beats scattering null-checks through the handlers.
 */
const FEATURES = [
  'ai',           // mention/keyword replies from the persona
  'music',        // playback, queue, radio — admin-only wherever it's enabled
  'moderation',   // /mod and /stats
  'instagram',    // auto-download of posted Instagram links
  'textImageMod', // Ollama-backed ASCII/Unicode explicit-art filter
  'automod',      // Discord native AutoMod rule management, /automod
  'zomboid',      // Project Zomboid server integration
];

let cache = null;

function normalizeGuild(id, raw) {
  const channels = raw.channels || {};
  const roles = raw.roles || {};
  const features = Array.isArray(raw.features) ? raw.features.filter(f => FEATURES.includes(f)) : [];

  return {
    id,
    name: raw.name || id,
    features,
    channels: {
      // Where now-playing cards are posted.
      music: channels.music || null,
      // Voice channel the companion app joins when the bot isn't already
      // connected. Unused by the slash commands, which follow the caller.
      defaultVoice: channels.defaultVoice || null,
    },
    roles: {
      // Grants bot admin without granting Discord Administrator.
      admin: roles.admin || null,
    },
    zomboid: raw.zomboid || null,
  };
}

/**
 * Build a starting skeleton for the primary guild when no config file exists,
 * so a fresh install boots and registers commands. The channel and role IDs
 * still have to be filled in by hand afterwards.
 */
function seedFromEnv() {
  const primaryId = process.env.GUILD_ID;
  if (!primaryId || !SNOWFLAKE.test(primaryId)) return {};

  return {
    [primaryId]: {
      name: 'primary',
      features: ['ai', 'music', 'moderation', 'instagram', 'textImageMod', 'automod'],
      channels: { music: null, defaultVoice: null },
      roles: { admin: null },
      zomboid: null,
    },
  };
}

function load() {
  if (cache) return cache;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // A malformed config is worth shouting about — silently falling back to
      // a seed would quietly detach the bot from its real channel wiring.
      console.error(`[Config] ${CONFIG_FILE} is unreadable: ${err.message}`);
      console.error('[Config] Falling back to env-derived defaults.');
      raw = seedFromEnv();
      cache = normalizeAll(raw);
      return cache;
    }
    raw = seedFromEnv();
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      console.log(`[Config] Seeded ${CONFIG_FILE} from environment.`);
    } catch (writeErr) {
      console.warn('[Config] Could not write seed config:', writeErr.message);
    }
  }

  cache = normalizeAll(raw);

  const ids = Object.keys(cache);
  if (ids.length === 0) {
    console.warn('[Config] No guilds configured — the bot will ignore every message.');
  } else {
    console.log(`[Config] Loaded ${ids.length} guild(s): ${ids.map(id => cache[id].name).join(', ')}`);
  }

  return cache;
}

function normalizeAll(raw) {
  const out = {};
  for (const [id, entry] of Object.entries(raw || {})) {
    if (!SNOWFLAKE.test(id)) {
      // Template entries live in the file on purpose; don't treat them as real.
      console.log(`[Config] Skipping placeholder guild entry "${id}".`);
      continue;
    }
    out[id] = normalizeGuild(id, entry || {});
  }
  return out;
}

/** @returns {object|null} config for a guild, or null if it isn't configured. */
function getGuildConfig(guildId) {
  if (!guildId) return null;
  return load()[guildId] || null;
}

/** @returns {string[]} configured guild IDs, placeholders excluded. */
function guildIds() {
  return Object.keys(load());
}

/** @returns {boolean} whether `feature` is enabled for this guild. */
function hasFeature(guildId, feature) {
  const cfg = getGuildConfig(guildId);
  return !!cfg && cfg.features.includes(feature);
}

/**
 * Look up a configured channel ID.
 * @returns {string|null}
 */
function channelId(guildId, key) {
  const cfg = getGuildConfig(guildId);
  return cfg ? cfg.channels[key] || null : null;
}

/**
 * The guild the control API and other single-guild surfaces act on.
 * Explicit override first, then the legacy env var, then the only configured
 * guild if there happens to be exactly one.
 */
function primaryGuildId() {
  const explicit = process.env.CONTROL_API_GUILD_ID || process.env.GUILD_ID;
  if (explicit && SNOWFLAKE.test(explicit)) return explicit;
  const ids = guildIds();
  return ids.length === 1 ? ids[0] : null;
}

/** Drop the cache so the next read re-reads the file. */
function reload() {
  cache = null;
  return load();
}

module.exports = {
  FEATURES,
  CONFIG_FILE,
  getGuildConfig,
  guildIds,
  hasFeature,
  channelId,
  primaryGuildId,
  reload,
};
