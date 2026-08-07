'use strict';
/**
 * Creates and reconciles the request forums for a guild.
 *
 * Discord has no text-to-forum conversion, so standing up a forum for an
 * existing channel means creating a new one beside it and retiring the old.
 * That is destructive enough that nothing here runs implicitly: `plan()` is
 * pure and describes what would happen, `apply()` is only ever reached through
 * an explicit admin command.
 *
 * Everything is idempotent. Running it twice adopts what already exists and
 * only fills in the gaps, so it doubles as a repair tool if a channel is
 * deleted or a tag is removed by hand.
 */
const {
  ChannelType,
  PermissionFlagsBits,
  ForumLayoutType,
  SortOrderType,
} = require('discord.js');
const { FORUMS } = require('./spec');
const { updateGuildConfig } = require('../../config/guilds');

/** Permissions the routine needs before it touches anything. */
const REQUIRED = [
  ['ManageChannels', PermissionFlagsBits.ManageChannels],
  ['ManageThreads', PermissionFlagsBits.ManageThreads],
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['AddReactions', PermissionFlagsBits.AddReactions],
  ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
];

/** @returns {string[]} names of the permissions the bot is missing guild-wide. */
function missingPermissions(guild) {
  const me = guild.members.me;
  if (!me) return REQUIRED.map(([name]) => name);
  return REQUIRED.filter(([, flag]) => !me.permissions.has(flag)).map(([name]) => name);
}

/**
 * Where in the guild config a given forum's channel ID lives.
 *
 * Only mod requests sit under `zomboid` — that forum is the one that needs
 * Workshop and server-ini knowledge. The rest are ordinary guild channels.
 */
function configuredId(config, spec) {
  return spec.key === 'modRequests'
    ? config?.zomboid?.channels?.modRequests || null
    : config?.channels?.[spec.key] || null;
}

function configPatch(spec, id) {
  return spec.key === 'modRequests'
    ? { zomboid: { channels: { modRequests: id } } }
    : { channels: { [spec.key]: id } };
}

/**
 * Find the channel a spec currently maps to.
 *
 * Falls back to a name match so a forum created by hand — or by a previous run
 * whose config write failed — is adopted rather than duplicated.
 *
 * @returns {{channel: import('discord.js').GuildChannel|null, byName: boolean}}
 */
function resolveExisting(guild, config, spec) {
  const id = configuredId(config, spec);
  if (id) {
    const byId = guild.channels.cache.get(id);
    if (byId) return { channel: byId, byName: false };
  }
  const byName = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildForum && c.name === spec.name
  );
  return { channel: byName || null, byName: !!byName };
}

/** Tags in the spec that the live forum doesn't have yet, compared by name. */
function missingTags(channel, spec) {
  const have = new Set((channel.availableTags || []).map((tag) => tag.name));
  return spec.tags.filter((tag) => !have.has(tag.name));
}

/**
 * Describe what `apply` would do, without touching Discord.
 *
 * @returns {{blocked: string[], steps: Array<{spec: object, action: string, detail: string}>}}
 */
function plan(guild, config) {
  const blocked = [];
  const missing = missingPermissions(guild);
  if (missing.length) {
    blocked.push(`Sheogorath is missing: ${missing.join(', ')}. Grant these before applying.`);
  }

  const steps = [];
  for (const spec of FORUMS) {
    const { channel, byName } = resolveExisting(guild, config, spec);

    if (!channel) {
      steps.push({
        spec,
        action: 'create',
        detail: `Create forum #${spec.name} with ${spec.tags.length} tags.`,
      });
      continue;
    }

    if (channel.type !== ChannelType.GuildForum) {
      // The old text channel. It can't become a forum, so it gets replaced.
      steps.push({
        spec,
        action: 'replace',
        detail:
          `#${channel.name} is a text channel and cannot be converted. ` +
          `Create forum #${spec.name} in the same category, then lock ` +
          `#${channel.name} to read-only and rename it #${channel.name}-archive.`,
      });
      continue;
    }

    const gaps = missingTags(channel, spec);
    steps.push({
      spec,
      action: gaps.length ? 'reconcile' : 'ok',
      detail: gaps.length
        ? `Adopt existing forum #${channel.name}${byName ? ' (matched by name)' : ''} and add ${gaps.length} missing tag(s): ${gaps.map((g) => g.name).join(', ')}.`
        : `#${channel.name} is already correct.`,
    });
  }

  return { blocked, steps };
}

/** Tag payload that preserves existing tag IDs, so posts keep their tags. */
function mergedTagPayload(channel, spec) {
  const existing = (channel.availableTags || []).map((tag) => ({
    id: tag.id,
    name: tag.name,
    moderated: tag.moderated,
    emoji: tag.emojiId
      ? { id: tag.emojiId, name: null }
      : tag.emojiName
        ? { id: null, name: tag.emojiName }
        : null,
  }));
  return [...existing, ...missingTags(channel, spec)].slice(0, 20);
}

async function createForum(guild, spec, parentId, reason) {
  return guild.channels.create({
    name: spec.name,
    type: ChannelType.GuildForum,
    parent: parentId || null,
    topic: spec.topic,
    availableTags: spec.tags,
    defaultForumLayout: ForumLayoutType.ListView,
    defaultSortOrder: SortOrderType.LatestActivity,
    // Shown in the "new post" composer, where people actually read it.
    defaultReactionEmoji: { id: null, name: '👍' },
    reason,
  });
}

/**
 * Retire a superseded text channel: read-only for @everyone, renamed so it
 * sorts away from the live forum. Deliberately not deleted — the request
 * history is the reason the channel existed.
 */
async function archiveTextChannel(channel, forum, reason) {
  const suffix = '-archive';
  const name = channel.name.endsWith(suffix) ? channel.name : `${channel.name}${suffix}`.slice(0, 100);
  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone,
    { SendMessages: false, CreatePublicThreads: false, CreatePrivateThreads: false, SendMessagesInThreads: false },
    { reason }
  );
  await channel.setName(name, reason);
  // The old topic is still live instructions. safehouse-claims asked people to
  // "post the building address or map coordinates", which is exactly what the
  // replacement forum exists to stop — leaving it up would keep teaching the
  // habit from a read-only channel nobody is moderating.
  try {
    await channel.setTopic(
      forum ? `Archived — read only. Use <#${forum.id}> instead.` : 'Archived — read only.',
      reason
    );
  } catch {
    /* topic is cosmetic; a failure here must not fail the retire */
  }
  return name;
}

/**
 * Execute the plan.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} config guild config entry
 * @returns {Promise<{results: string[], warnings: string[], channels: object}>}
 */
async function apply(guild, config) {
  const { blocked } = plan(guild, config);
  if (blocked.length) throw new Error(blocked.join(' '));

  const reason = 'Sheogorath forum setup';
  const results = [];
  const warnings = [];
  const channels = {};

  for (const spec of FORUMS) {
    const { channel } = resolveExisting(guild, config, spec);

    // Already a forum: adopt it, top up any tags it's missing.
    if (channel && channel.type === ChannelType.GuildForum) {
      const gaps = missingTags(channel, spec);
      if (gaps.length) {
        await channel.setAvailableTags(mergedTagPayload(channel, spec), reason);
        results.push(`#${channel.name} — added ${gaps.length} tag(s): ${gaps.map((g) => g.name).join(', ')}.`);
      } else {
        results.push(`#${channel.name} — already correct.`);
      }
      channels[spec.key] = channel.id;
      continue;
    }

    // A text channel under this key means the pre-forum layout. Build the
    // forum next to it, in the same category so it inherits the same
    // role permissions, then retire the old one.
    const parentId = channel?.parentId || null;
    const forum = await createForum(guild, spec, parentId, reason);
    channels[spec.key] = forum.id;
    results.push(`Created forum <#${forum.id}> with ${spec.tags.length} tags.`);

    if (channel) {
      try {
        const renamed = await archiveTextChannel(channel, forum, reason);
        results.push(`Locked #${renamed} to read-only — its history is preserved.`);
      } catch (err) {
        warnings.push(`Created the forum, but could not archive #${channel.name}: ${err.message}`);
      }
    }
  }

  // Persist last: a half-written config is worse than none, and every step
  // above is idempotent, so a failed run is safe to repeat.
  try {
    let patch = {};
    for (const spec of FORUMS) {
      if (channels[spec.key]) patch = deepMergePatch(patch, configPatch(spec, channels[spec.key]));
    }
    if (!config?.features?.includes('forums')) {
      patch.features = [...new Set([...(config?.features || []), 'forums'])];
    }
    updateGuildConfig(guild.id, patch);
    results.push('Wired the channel IDs into config/guilds.json and enabled the `forums` feature.');
  } catch (err) {
    warnings.push(
      `Channels are created but config/guilds.json was not updated (${err.message}). ` +
      `Set them by hand: ${Object.entries(channels).map(([k, v]) => `${k}=${v}`).join(', ')}`
    );
  }

  return { results, warnings, channels };
}

/** Minimal object merge for assembling the config patch. */
function deepMergePatch(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMergePatch(out[k] || {}, v) : v;
  }
  return out;
}

module.exports = { plan, apply, missingPermissions, configuredId };
