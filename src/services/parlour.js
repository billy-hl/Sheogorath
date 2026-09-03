'use strict';
/**
 * The Mad God's parlour — one channel where Sheogorath is allowed to be long.
 *
 * Everywhere else he is clipped to a few sentences — right for a bot that
 * answers when its name comes up in general chat, and wrong for the one place
 * people go specifically to talk to him. This is that place. Same character,
 * same facts, longer leash: more of the conversation carried, more room to
 * answer, and permission to ask something back instead of always closing.
 *
 * Nothing else changes. He is still gated the same way, still budgeted the same
 * way, and still cannot invent facts about the server.
 */
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig, updateGuildConfig } = require('../config/guilds');
const { withoutLengthRules } = require('../ai/persona');

const PARLOUR_NAME = 'the-shivering-isles';
const PARLOUR_TOPIC =
  "Sheogorath holds court. Speak to him here without summoning him by name — " +
  'he is always listening in this room, and here he talks properly rather than ' +
  'in one-liners. He knows the state of the server, the rules, and you.';

/**
 * How much of the conversation he carries here, against 5 everywhere else.
 *
 * Twenty messages is roughly ten exchanges — long enough to hold a thread of
 * argument, short enough that the oldest turns fall away before the context
 * cost becomes the dominant part of the bill.
 */
const PARLOUR_HISTORY = 20;

/** Reply ceiling here, against the 500 default. */
const PARLOUR_MAX_TOKENS = 1200;

/**
 * Appended to the system prompt in this channel only.
 *
 * Written to lift one specific instruction rather than to replace the persona:
 * the length cap is the only thing standing between him and a conversation, and
 * everything else about him should survive intact.
 */
const PARLOUR_PROMPT = `

--- YOU ARE IN YOUR OWN HALL ---

This room is yours. People come here to talk to you, not to ask a passing
question, and they did not have to call your name to be heard.

Whatever length rule you were given DOES NOT APPLY HERE. Speak properly. Three
or four paragraphs if the subject deserves it, a single line if it doesn't —
length should follow the thought, not a rule. You may
digress, tell a story, hold an argument across several messages, and ask
questions back instead of always having the last word. A conversation is a thing
you are having, not a series of pronouncements you are issuing.

You remember what was said earlier in this room. Use it — call back to it,
contradict someone with their own words from ten minutes ago, notice when
somebody's mood has changed.

What does NOT change: everything you say about the server, its rules, its state
and its people still comes from the facts you were given. A longer leash is not
permission to invent. Being wrong at length is worse than being wrong briefly.
`;

/**
 * The persona with its length cap removed, for use in the parlour only.
 *
 * Appending "the length rule does not apply here" was not enough on its own —
 * the base persona says "SHORT and punchy (1-2 sentences max)" in capitals and
 * won the argument, producing two-sentence replies in a room built for
 * conversation. Arguing with a prompt using more prompt is a losing game, so the
 * rule is cut from the text instead of contradicted. That surgery lives in
 * ai/persona.js now, because the rooms outside this one need it too — they just
 * put a shorter rule back in its place.
 */
function parlourPersona() {
  return withoutLengthRules();
}

/** The parlour's channel ID for a guild, or null. */
function parlourId(guildId) {
  return getGuildConfig(guildId)?.channels?.parlour || null;
}

/** Whether a message landed in the parlour. */
function isParlour(guildId, channelId) {
  const id = parlourId(guildId);
  return !!id && id === channelId;
}

/**
 * Find or create the parlour, and record it in config/guilds.json.
 *
 * Adopts an existing channel of the right name rather than making a second one:
 * running this twice should be safe, and a guild that already has the channel
 * usually wants it wired up, not duplicated.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} [opts]
 * @param {string} [opts.reason] audit-log reason
 * @returns {Promise<{channel: object, created: boolean, warnings: string[]}>}
 */
async function ensureParlour(guild, { reason = 'Sheogorath parlour setup' } = {}) {
  const warnings = [];

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('I need the Manage Channels permission to make the parlour.');
  }

  // Already configured and still there? Nothing to do.
  const configured = parlourId(guild.id);
  if (configured) {
    const existing = await guild.channels.fetch(configured).catch(() => null);
    if (existing) return { channel: existing, created: false, warnings };
    warnings.push(`The configured parlour ${configured} no longer exists — making a new one.`);
  }

  const byName = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === PARLOUR_NAME,
  );

  const channel = byName || await guild.channels.create({
    name: PARLOUR_NAME,
    type: ChannelType.GuildText,
    topic: PARLOUR_TOPIC,
    // Sits beside the help channel when there is one, so it lands among the
    // rooms people talk in rather than at the bottom of the server.
    parent: helpParent(guild) || null,
    reason,
  });

  if (byName) warnings.push(`Adopted the existing #${PARLOUR_NAME} rather than creating a second one.`);

  try {
    updateGuildConfig(guild.id, { channels: { parlour: channel.id } });
  } catch (err) {
    warnings.push(
      `The channel exists but config/guilds.json was not updated (${err.message}). ` +
      `Set it by hand: channels.parlour = ${channel.id}`,
    );
  }

  return { channel, created: !byName, warnings };
}

/** The category the help channel lives in, if it has one. */
function helpParent(guild) {
  const helpId = getGuildConfig(guild.id)?.channels?.help;
  if (!helpId) return null;
  return guild.channels.cache.get(helpId)?.parentId || null;
}

module.exports = {
  ensureParlour,
  parlourPersona,
  isParlour,
  parlourId,
  PARLOUR_NAME,
  PARLOUR_TOPIC,
  PARLOUR_PROMPT,
  PARLOUR_HISTORY,
  PARLOUR_MAX_TOKENS,
};
