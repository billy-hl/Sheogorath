'use strict';
/**
 * Roleplay character sheets: one forum thread per character.
 *
 * A sheet has two halves and the split is the whole point.
 *
 * The player writes who their survivor is — where they came from, what they did
 * before, how to approach them in the world. The server writes what they have
 * actually done: the character name the save holds, hours survived, the skills
 * the PerkLog recorded at their last login, how many characters this account has
 * buried. The bot owns the starter message so the second half can't be edited
 * away, which is what stops a Doctor 0 from writing themselves up as a surgeon.
 *
 * Sheets are filed under Steam ID, and a death retires one rather than deleting
 * it. The thread stays as the character's record, tagged Deceased, with the
 * eulogy linked from it; the player writes a new sheet for their next life.
 * Characters are mortal here, so the board reads as who is out there now.
 */
const { getGuildConfig } = require('../../config/guilds');
const { CHARACTERS, TAG } = require('../forums/spec');
const { applyStatusTag, fetchStarter } = require('../forums/handler');
const { skillsAtDeath, countDeaths } = require('./eulogy');
const { lookupPlayer } = require('./players');
const identity = require('./identity');

/** Discord's hard cap on a message; the starter post is one message. */
const MESSAGE_LIMIT = 2000;
/** Discord's hard cap on a thread name. */
const NAME_LIMIT = 100;

/**
 * How far back to look for the last PerkLog login dump.
 *
 * A dump is written every login, so this only has to cover the gap since the
 * player last played. Two weeks keeps the read bounded on a server that rotates
 * logs daily while still covering anyone who plays at all regularly.
 */
const SKILL_LOOKBACK_DAYS = 14;

/**
 * The authored half, as modal inputs.
 *
 * Five, because Discord allows a modal exactly five. That constraint is doing
 * useful work — it forces the sheet down to what another player actually needs
 * before walking up to a stranger, instead of a wiki page nobody reads.
 *
 * `maxLength` is set so a full sheet plus the derived block still fits in one
 * message; see MESSAGE_LIMIT.
 */
const FIELDS = [
  {
    id: 'age',
    label: 'Age and where they\'re from',
    placeholder: 'e.g. 34, out of Louisville',
    style: 'short',
    maxLength: 100,
    required: true,
  },
  {
    id: 'before',
    label: 'What they did before the outbreak',
    placeholder: 'e.g. worked nights at a tyre shop',
    style: 'short',
    maxLength: 150,
    required: true,
  },
  {
    id: 'faction',
    label: 'Group or affiliation (or "none")',
    placeholder: 'e.g. the Riverside crew — or none',
    style: 'short',
    maxLength: 100,
    required: false,
  },
  {
    id: 'bio',
    label: 'Their story so far',
    placeholder: 'How they got here, what they lost, what they want.',
    style: 'paragraph',
    maxLength: 700,
    required: true,
  },
  {
    id: 'approach',
    label: 'How to approach them in-game',
    placeholder: 'Do they shoot first? Trade? Where might you run into them?',
    style: 'paragraph',
    maxLength: 350,
    required: true,
  },
];

/**
 * Which occupation tag a character earns, from the skill they are best at.
 *
 * Derived rather than chosen: the bot owns the thread, so a player cannot set
 * their own tags anyway, and tagging off the PerkLog means the board answers
 * "who can actually fix a car" honestly.
 */
const SKILL_TAGS = [
  ['Medic', ['Doctor']],
  ['Builder', ['Woodwork', 'Carpentry', 'Masonry', 'Blacksmith']],
  ['Mechanic', ['Mechanics', 'MetalWelding', 'Electricity', 'Maintenance']],
  ['Farmer', ['Farming', 'Fishing', 'Trapping', 'PlantScavenging']],
  ['Cook', ['Cooking']],
  ['Fighter', ['Aiming', 'Reloading', 'Axe', 'Blunt', 'SmallBlunt', 'LongBlade', 'SmallBlade', 'Spear']],
  ['Scavenger', ['Nimble', 'Sneak', 'Lightfoot', 'Sprinting']],
];

/** Resolve sheet config for a guild, or null when it isn't set up. */
function sheetConfig(guildId) {
  const config = getGuildConfig(guildId);
  const zomboid = config?.zomboid;
  const forumId = config?.channels?.characters;
  if (!forumId || !zomboid?.logDir || !zomboid?.playersDb) return null;
  return { forumId, logDir: zomboid.logDir, playersDb: zomboid.playersDb };
}

/**
 * Everything the server knows about a character, for the derived block.
 *
 * @returns {{name: string|null, isDead: boolean, hours: number|null,
 *            skills: Array<[string, number]>, lives: number}}
 */
function derive(cfg, { steamid, username }) {
  const player = lookupPlayer(cfg.playersDb, { steamid, username });
  const now = Date.now();
  const lookbackMs = SKILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  // The newest dump at or before now is the current character's sheet — the
  // same reasoning the eulogy uses, with "now" standing in for the death.
  const dump = steamid ? skillsAtDeath(cfg.logDir, String(steamid), now, lookbackMs) : null;

  const skills = Object.entries(dump?.skills || {})
    .filter(([, level]) => level > 0)
    .sort((a, b) => b[1] - a[1]);

  return {
    name: player?.name || null,
    username: player?.username || username || null,
    isDead: !!player?.isDead,
    hours: dump?.hours ?? null,
    skills,
    // Deaths on this account, which is how many characters came before.
    lives: steamid ? countDeaths(cfg.logDir, String(steamid), now, lookbackMs) : 0,
  };
}

/** The occupation tag a skill list earns, or null when nothing stands out. */
function occupationTag(skills) {
  for (const [skill] of skills) {
    const hit = SKILL_TAGS.find(([, members]) => members.includes(skill));
    if (hit) return hit[0];
  }
  return null;
}

/** `412 hours (17 days)`, or null when the logs have nothing to say. */
function formatSurvival(hours) {
  if (hours === null || Number.isNaN(hours)) return null;
  const days = Math.floor(hours / 24);
  return `${hours} hours survived${days ? ` (${days} days)` : ''}`;
}

/**
 * The whole starter post.
 *
 * The derived block goes last, under a rule, so it reads as a footer the server
 * maintains rather than something the player wrote.
 */
function render({ fields, derived, discordId }) {
  const name = derived.name || derived.username || 'Unnamed survivor';
  const lines = [`## ${name}`];

  const subtitle = [fields.age, fields.before].filter(Boolean).join(' · ');
  if (subtitle) lines.push(`*${subtitle}*`);

  const faction = (fields.faction || '').trim();
  if (faction && !/^(none|n\/a|-)$/i.test(faction)) lines.push(`**Runs with:** ${faction}`);

  lines.push('', fields.bio || '');
  lines.push('', '**Approaching them**', fields.approach || '');

  lines.push('', '---');
  const facts = [];
  const survival = formatSurvival(derived.hours);
  if (survival) facts.push(survival);
  if (derived.lives > 0) facts.push(`${derived.lives} character(s) buried on this account`);
  lines.push(`🧾 ${facts.length ? facts.join(' · ') : 'No survival record yet.'}`);

  if (derived.skills.length) {
    const top = derived.skills.slice(0, 5).map(([s, lvl]) => `${s} ${lvl}`).join(' · ');
    lines.push(`🛠️ ${top}`);
  }

  lines.push(`👤 Played by <@${discordId}> · account \`${derived.username || '?'}\``);
  lines.push('*Stats are read from the server and refresh on `/character refresh`.*');

  const out = lines.join('\n');
  return out.length > MESSAGE_LIMIT ? `${out.slice(0, MESSAGE_LIMIT - 1)}…` : out;
}

/** Fetch a thread by ID, or null if it's gone. Unarchives so it can be edited. */
async function liveThread(client, threadId) {
  if (!threadId) return null;
  let thread;
  try {
    thread = await client.channels.fetch(threadId);
  } catch {
    return null;
  }
  if (!thread?.isThread?.()) return null;
  if (thread.archived) {
    try {
      await thread.setArchived(false);
    } catch (err) {
      console.warn('[Characters] Could not unarchive thread:', err?.message || err);
      return null;
    }
  }
  return thread;
}

/** Apply the derived occupation tag without disturbing the status tag. */
async function applyOccupation(thread, derived) {
  const name = occupationTag(derived.skills);
  if (!name) return;
  const available = thread.parent?.availableTags || [];
  const target = available.find((t) => t.name === name);
  if (!target) return;

  const current = thread.appliedTags || [];
  if (current.includes(target.id)) return;

  // The occupation tags are the unmoderated ones, so swap out any other
  // occupation while leaving Alive/Deceased and anything staff applied.
  const occupationIds = new Set(
    available.filter((t) => SKILL_TAGS.some(([label]) => label === t.name)).map((t) => t.id),
  );
  const keep = current.filter((id) => !occupationIds.has(id));
  try {
    await thread.setAppliedTags([...new Set([target.id, ...keep])].slice(0, 5));
  } catch (err) {
    console.warn('[Characters] Could not apply occupation tag:', err?.message || err);
  }
}

/**
 * Create or update a player's sheet.
 *
 * @returns {Promise<{thread: object, derived: object, created: boolean}>}
 */
async function upsertSheet(client, guildId, { discordId, steamid, username, fields }) {
  const cfg = sheetConfig(guildId);
  if (!cfg) throw new Error('Character sheets are not configured for this server.');

  const derived = derive(cfg, { steamid, username });
  if (derived.isDead) {
    throw new Error(
      'The save says this character is dead. Their sheet will be retired automatically — ' +
      'spawn a new character and try again.',
    );
  }

  const name = (derived.name || derived.username || 'Unnamed survivor').slice(0, NAME_LIMIT);
  const body = render({ fields, derived, discordId });
  const existing = identity.getSheet(guildId, steamid);

  let thread = await liveThread(client, existing?.threadId);
  let created = false;

  if (thread) {
    const starter = await fetchStarter(thread);
    if (starter) {
      await starter.edit({ content: body, allowedMentions: { parse: [] } });
    } else {
      // The starter is gone, which means the post was gutted. Rather than
      // silently losing the sheet, start a fresh thread below.
      thread = null;
    }
    if (thread && thread.name !== name) await thread.setName(name).catch(() => {});
  }

  if (!thread) {
    const forum = await client.channels.fetch(cfg.forumId);
    thread = await forum.threads.create({
      name,
      message: { content: body, allowedMentions: { parse: [] } },
      reason: `Character sheet for ${discordId}`,
    });
    created = true;
  }

  await applyStatusTag(thread, CHARACTERS, TAG.ALIVE);
  await applyOccupation(thread, derived);

  identity.saveSheet(guildId, steamid, {
    threadId: thread.id,
    discordId,
    name,
    fields,
  });

  return { thread, derived, created };
}

/**
 * Re-render an existing sheet against the current server state, without the
 * player rewriting anything.
 *
 * @returns {Promise<{thread: object, derived: object}|null>} null when there is
 *          no sheet to refresh.
 */
async function refreshSheet(client, guildId, { discordId, steamid, username }) {
  const existing = identity.getSheet(guildId, steamid);
  if (!existing) return null;
  return upsertSheet(client, guildId, {
    discordId: existing.discordId || discordId,
    steamid,
    username,
    fields: existing.fields || {},
  });
}

/**
 * Retire a sheet when its character dies.
 *
 * Called from the eulogy watcher, which is already the one thing on the server
 * that notices a death the moment it happens. Runs even for lives too short to
 * earn a eulogy — the sheet still has to stop claiming its owner is alive.
 *
 * @returns {Promise<boolean>} whether a sheet was retired.
 */
async function retireOnDeath(client, guildId, { steamid, displayName, diedAt, eulogyUrl } = {}) {
  if (!steamid) return false;
  const sheet = identity.getSheet(guildId, String(steamid));
  if (!sheet) return false;

  // Record it first. If Discord is unreachable the sheet must still stop being
  // the player's live one, or they cannot write a replacement.
  identity.retireSheet(guildId, steamid, { diedAt, eulogyUrl });

  const thread = await liveThread(client, sheet.threadId);
  if (!thread) return true;

  try {
    await applyStatusTag(thread, CHARACTERS, TAG.DECEASED);
    const name = displayName || sheet.name || 'This survivor';
    await thread.send({
      content:
        `⚰️ **${name}** did not make it.` +
        (eulogyUrl ? `\n\nTheir eulogy: ${eulogyUrl}` : '') +
        '\n\nThis sheet is kept as a record. Run `/character sheet` to write your next one.',
      allowedMentions: { parse: [] },
    });
    // Locked, not deleted: the thread is this character's history, and the
    // eulogy above points at it. Archiving keeps it off the live board.
    await thread.setArchived(true).catch(() => {});
  } catch (err) {
    console.warn('[Characters] Could not mark a sheet deceased:', err?.message || err);
  }

  console.log(`[Characters] Retired the sheet for ${displayName || sheet.name} (${steamid}).`);
  return true;
}

module.exports = {
  FIELDS,
  MESSAGE_LIMIT,
  sheetConfig,
  derive,
  render,
  occupationTag,
  upsertSheet,
  refreshSheet,
  retireOnDeath,
};
