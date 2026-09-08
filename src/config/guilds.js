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
  'forums',       // suggestion / mod-request forum channels, /forums
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
      // Forum channel for general server suggestions. Guild-level rather than
      // under `zomboid` because nothing about it is game-specific — only the
      // mod-request forum needs Workshop knowledge.
      suggestions: channels.suggestions || null,
      // Forum channel for in-character trading offers.
      trading: channels.trading || null,
      // Forum channel for safehouse claims.
      safehouseClaims: channels.safehouseClaims || null,
      // Forum channel holding one roleplay character sheet per thread. Guild
      // level like the rest — the sheets are written in Discord; only the stats
      // on them come from the game.
      characters: channels.characters || null,
      // Where privileged command invocations are mirrored, so admins can see
      // what staff did without reading logs/commands.jsonl on the host. Every
      // command is recorded to that file regardless of this setting.
      commandLog: channels.commandLog || null,
      // Where Sheogorath posts what he wants permission to do, and what he did
      // on his own. Falls back to `commandLog` when unset — a guild that
      // already has one private staff channel shouldn't be made to create a
      // second just to turn the moderator on.
      modApprovals: channels.modApprovals || null,
      // The one channel he answers in without being called by name. Unset means
      // he waits to be addressed there like anywhere else.
      help: channels.help || null,
      // Reference channels Sheogorath reads before answering questions, so the
      // rules and the connection details he quotes are the ones players can see
      // rather than a second copy that drifts. Left unset, he looks for
      // channels literally named `rules` and `server-info`.
      //
      // Whatever is posted in these becomes what he tells people, so they
      // should be channels only staff can write to.
      rules: channels.rules || null,
      serverInfo: channels.serverInfo || null,
      // The Mad God's parlour: the one room where the persona's "1-2 sentences"
      // cap is lifted and he carries a real conversation. Created by
      // `/sheo parlour`, which writes this key itself.
      parlour: channels.parlour || null,
    },
    roles: {
      // The guild's role ladder, highest first. Only `admin` and `staff` gate
      // anything; `veteran` and `member` are recorded so the rename tooling and
      // any future perk checks have one place to look rather than re-deriving
      // IDs from role names, which people rename.

      // Grants bot admin without granting Discord Administrator.
      admin: roles.admin || null,
      // One rung below admin: the in-game staff tier (Sheriff). Carries the
      // Project Zomboid admin commands — /pz — and nothing else, so a game
      // moderator doesn't also get music, automod and the moderation suite.
      staff: roles.staff || null,
      veteran: roles.veteran || null,
      member: roles.member || null,
    },
    // How much rope the AI moderator gets in this guild. See ai/capabilities.js
    // for what each mode means. Absent means `shadow`: a guild that has never
    // been thought about should watch rather than act.
    ai: {
      mode: typeof raw.ai?.mode === 'string' ? raw.ai.mode : null,
      // One sentence about what he *is* in this guild, handed to him verbatim.
      // The same bot is a warden on the game server and a mascot in the social
      // hall, and nothing else in this file says so — features describe what
      // the bot runs, not what he is to the people in the room.
      standing: typeof raw.ai?.standing === 'string' ? raw.ai.standing.trim() : null,
      // Which of his powers this guild wants him to have, by capability name
      // (see ai/capabilities.js). Absent means all of them that this guild's
      // features support — the existing behaviour — so only a guild that wants
      // him narrower has to say anything.
      powers: Array.isArray(raw.ai?.powers) ? raw.ai.powers.filter(p => typeof p === 'string') : null,
      // What this guild calls its two tiers. Defaults live in aiTitles() rather
      // than here so a guild that has never set them still reads correctly.
      titles: {
        admin: typeof raw.ai?.titles?.admin === 'string' ? raw.ai.titles.admin.trim() : null,
        staff: typeof raw.ai?.titles?.staff === 'string' ? raw.ai.titles.staff.trim() : null,
      },
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
 * "a Sheriff" / "an Owner". The tier names are per-guild configuration, so the
 * article has to be worked out rather than written into the sentence.
 * @param {string} word
 * @returns {string}
 */
function withArticle(word) {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

/**
 * What this guild calls the people above Sheogorath.
 *
 * Written against the *role ladder that actually exists here*, not against the
 * vocabulary the bot grew up with. The Zomboid guild has a staff role between
 * its owners and its members and calls them Sheriffs; the social guild has no
 * such rung at all, and telling its members that something has "gone to the
 * Sheriffs" names a tier they have never heard of and cannot go and find. Where
 * there is no staff role, `isStaff()` already collapses to `isAdmin()`, so the
 * words collapse the same way.
 *
 * @param {object|null} guildConfig
 * @returns {{admin: string, staff: string|null, approver: string, approvers: string}}
 */
function aiTitles(guildConfig) {
  const admin = guildConfig?.ai?.titles?.admin || 'Owner';
  // A staff title is only real when a staff role is configured to hold it.
  const staff = guildConfig?.roles?.staff
    ? (guildConfig?.ai?.titles?.staff || 'Sheriff')
    : null;
  return {
    admin,
    staff,
    // Who a held action is waiting on, singular and plural.
    approver: staff || admin,
    approvers: staff ? `${staff}s and ${admin}s` : `${admin}s`,
  };
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

/** Plain-object deep merge. Arrays and scalars in `patch` replace wholesale. */
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v)
      ? merge(out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? out[k] : {}, v)
      : v;
  }
  return out;
}

/**
 * Persist a patch into one guild's entry in config/guilds.json.
 *
 * Written against the raw file rather than the normalized cache so that keys
 * this module doesn't know about — and the placeholder entries the file keeps
 * on purpose — survive the round-trip. Used by the forum setup routine to
 * record the channel IDs it creates, which otherwise would have to be
 * copy-pasted in by hand.
 *
 * @param {string} guildId
 * @param {object} patch deep-merged into the existing entry
 * @throws if the file cannot be read or written — callers report it rather
 *   than silently leaving created channels unwired.
 */
function updateGuildConfig(guildId, patch) {
  if (!SNOWFLAKE.test(guildId)) throw new Error(`"${guildId}" is not a guild ID.`);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${CONFIG_FILE}: ${err.message}`);
    raw = {};
  }

  raw[guildId] = merge(raw[guildId] || {}, patch);

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  reload();
  return getGuildConfig(guildId);
}

module.exports = {
  FEATURES,
  CONFIG_FILE,
  getGuildConfig,
  guildIds,
  hasFeature,
  aiTitles,
  withArticle,
  channelId,
  primaryGuildId,
  reload,
  updateGuildConfig,
};
