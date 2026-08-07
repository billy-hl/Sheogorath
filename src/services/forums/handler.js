'use strict';
/**
 * What Sheogorath does when someone opens a forum post.
 *
 * Both forums get vote reactions and duplicate checking. Mod requests
 * additionally get the Workshop vetting that used to run on every message in
 * the old #mod-requests text channel — moving it here means it fires once per
 * request, on the post that *is* the request, instead of on every line of
 * discussion that happened to contain a link.
 *
 * The bot only ever applies factual tags. Incompatible, Installed, Duplicate
 * and Needs Review all follow from Workshop metadata or the server ini;
 * Approved and Denied are decisions and stay with staff.
 */
const { ChannelType } = require('discord.js');
const { getGuildConfig, hasFeature } = require('../../config/guilds');
const {
  TAG,
  SUGGESTIONS,
  MOD_REQUESTS,
  TRADING,
  SAFEHOUSE_CLAIMS,
  VOTE_EMOJI,
  VOTE_FORUM_KEYS,
} = require('./spec');
const { findWorkshopDuplicates, findSimilarSuggestions, indexPost } = require('./duplicates');
const { checkRequestDetailed, parseWorkshopIds, readServerConfig } = require('../zomboid/modCheck');

/** Discord caps a post at 5 applied tags. */
const MAX_APPLIED_TAGS = 5;

/**
 * A forum post's starter message is not always readable the instant
 * threadCreate fires — the gateway event can beat the message. Retry briefly
 * rather than treating a race as an empty post.
 */
async function fetchStarter(thread, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      const msg = await thread.fetchStarterMessage();
      if (msg) return msg;
    } catch {
      // Not there yet, or genuinely gone. Either way, wait and retry.
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

/**
 * Set one status tag, leaving user-chosen category tags alone.
 *
 * Status tags are exactly the moderated ones in the spec, so swapping a status
 * means dropping any other moderated tag currently applied and keeping the
 * rest.
 */
async function applyStatusTag(thread, spec, tagName) {
  const available = thread.parent?.availableTags || [];
  const target = available.find((t) => t.name === tagName);
  if (!target) {
    console.warn(`[Forums] #${thread.parent?.name} has no "${tagName}" tag — run /forums apply.`);
    return;
  }

  const statusIds = new Set(
    available.filter((t) => spec.tags.some((s) => s.name === t.name && s.moderated)).map((t) => t.id)
  );
  const keep = (thread.appliedTags || []).filter((id) => !statusIds.has(id));
  const next = [...new Set([target.id, ...keep])].slice(0, MAX_APPLIED_TAGS);

  try {
    await thread.setAppliedTags(next);
  } catch (err) {
    console.warn(`[Forums] Could not tag "${tagName}" on ${thread.id}:`, err?.message || err);
  }
}

/** Up/down reactions so staff can read interest off the post itself. */
async function addVoteReactions(starter) {
  if (!starter) return;
  for (const emoji of VOTE_EMOJI) {
    try {
      await starter.react(emoji);
    } catch (err) {
      console.warn('[Forums] Could not add vote reaction:', err?.message || err);
      return; // A failure here is permissions, so the second will fail too.
    }
  }
}

const link = (guildId, threadId) => `https://discord.com/channels/${guildId}/${threadId}`;

/**
 * Mod request: vet the Workshop link, tag the outcome, catch repeats.
 */
async function handleModRequest(thread, starter, config) {
  const zomboid = config.zomboid;
  const text = `${thread.name}\n${starter?.content || ''}`;
  const ids = parseWorkshopIds(text);

  if (!ids.length) {
    await thread.send(
      'I could not find a Steam Workshop link in this post. Edit it in — or paste it below — ' +
      'and staff can pick it up from there. A link looks like ' +
      '`https://steamcommunity.com/sharedfiles/filedetails/?id=1234567890`.'
    );
    await applyStatusTag(thread, MOD_REQUESTS, TAG.NEEDS_REVIEW);
    return;
  }

  // Cheapest check first — a known repeat needs no Workshop or model calls.
  const dupes = await findWorkshopDuplicates(thread.guildId, thread.parent, ids, thread.id);
  if (dupes.length) {
    const list = dupes.map((d) => `- \`${d.id}\` — ${link(thread.guildId, d.threadId)}`).join('\n');
    await thread.send(`This mod has been requested before:\n${list}\n\nFollow the existing post for the outcome.`);
    await applyStatusTag(thread, MOD_REQUESTS, TAG.DUPLICATE);
    indexPost(thread.guildId, thread.parent.id, thread, ids);
    return;
  }

  if (!zomboid?.serverIni) {
    console.warn('[Forums] Mod request forum is configured but zomboid.serverIni is not.');
    await applyStatusTag(thread, MOD_REQUESTS, TAG.NEEDS_REVIEW);
    return;
  }

  await thread.sendTyping().catch(() => {});
  const server = readServerConfig(
    zomboid.serverIni,
    zomboid.gameBuild || 42,
    zomboid.logDir,
    // Optional: lets the check read real `require=` lines out of mod.info for
    // anything already downloaded, instead of inferring deps from prose.
    zomboid.workshopDir || null
  );
  const result = await checkRequestDetailed(text, server);

  // Index regardless of the verdict — a request that failed vetting is still a
  // request, and the next person asking for it should be pointed here.
  indexPost(thread.guildId, thread.parent.id, thread, ids);

  if (!result) {
    await applyStatusTag(thread, MOD_REQUESTS, TAG.NEEDS_REVIEW);
    return;
  }

  await thread.send({ content: result.text, allowedMentions: { parse: [] } });

  const tag = result.verdict === 'NO'
    ? TAG.INCOMPATIBLE
    : result.alreadyInstalled
      ? TAG.INSTALLED
      : result.verdict === 'MAYBE'
        ? TAG.NEEDS_REVIEW
        : TAG.OPEN;

  await applyStatusTag(thread, MOD_REQUESTS, tag);
  console.log(`[Forums] Vetted "${thread.name}" — ${result.verdict} → ${tag}`);
}

/**
 * Suggestion: mark it open, and point out near-identical posts.
 *
 * Similar titles are only ever an advisory. Word overlap is not evidence two
 * people want the same thing, so nothing is tagged Duplicate here — that call
 * is left to whoever reads the two posts.
 */
async function handleSuggestion(thread) {
  await applyStatusTag(thread, SUGGESTIONS, TAG.OPEN);

  const similar = await findSimilarSuggestions(thread.parent, thread.name, thread.id);
  if (!similar.length) return;

  const list = similar.map((s) => `- ${s.title} — ${link(thread.guildId, s.threadId)}`).join('\n');
  await thread.send(
    `These existing suggestions look related — worth a read before this one gets going:\n${list}\n\n` +
    `If yours is different, ignore me and carry on.`
  );
}

/**
 * A pair or triple of map-sized numbers — `1107,12862,0`, `8614 8830` — which
 * is how PZ reports a position and how people paste one in.
 *
 * Both numbers must be 3-5 digits, which is the range the Knox County map
 * actually spans. That keeps ordinary prose ("all 12 of us") out of it while
 * still catching the copy-paste from the in-game ticket that caused the leak
 * this forum was created to prevent.
 *
 * The gap between them is any run of up to three non-digits, so `1107,12862`,
 * `8614 8830` and `x=3564 y=10901` all match while "1200 planks and 3000 nails"
 * (a five-character gap) does not.
 */
const COORDS = /(?<!\d)\d{3,5}\D{0,3}\d{3,5}(?:\D{0,3}-?\d{1,2})?(?!\d)/;

/**
 * Tell a claimant to edit their location out.
 *
 * Deliberately a nudge and not a deletion: removing someone's post costs them
 * the claim, and the damage from a leak is already done the moment it is
 * posted. Saying so quickly is what the players themselves did by hand.
 */
async function warnIfLocationLeaked(thread, starter) {
  const body = `${thread.name}\n${starter?.content || ''}`;
  if (!COORDS.test(body)) return;

  await thread.send(
    '⚠️ This post looks like it contains **map coordinates**. This forum is public — ' +
    'anyone reading it can find your base. Please edit them out; staff will ask you ' +
    'for the location privately if they need it.'
  );
  console.log(`[Forums] Warned about a possible location leak in "${thread.name}".`);
}

/**
 * Entry point for the threadCreate event.
 *
 * Silent for anything that isn't a post in one of the two configured forums,
 * so ordinary threads elsewhere in the guild are untouched.
 */
async function handleThreadCreate(thread) {
  if (!thread?.guildId || !thread.parentId) return;
  if (!hasFeature(thread.guildId, 'forums')) return;

  // `thread.parent` is a cache lookup. It is normally warm, but a miss would
  // make this return silently and drop the request on the floor, so fetch.
  if (!thread.parent) {
    try {
      await thread.guild.channels.fetch(thread.parentId);
    } catch (err) {
      console.warn('[Forums] Could not resolve parent channel:', err?.message || err);
      return;
    }
  }
  if (thread.parent?.type !== ChannelType.GuildForum) return;

  const config = getGuildConfig(thread.guildId);
  if (!config) return;

  const parentId = thread.parentId;
  const spec =
    parentId === config.zomboid?.channels?.modRequests ? MOD_REQUESTS
      : parentId === config.channels?.suggestions ? SUGGESTIONS
        : parentId === config.channels?.trading ? TRADING
          : parentId === config.channels?.safehouseClaims ? SAFEHOUSE_CLAIMS
            : null;
  if (!spec) return;

  const starter = await fetchStarter(thread);
  if (VOTE_FORUM_KEYS.has(spec.key)) await addVoteReactions(starter);

  if (spec === MOD_REQUESTS) {
    await handleModRequest(thread, starter, config);
  } else if (spec === SUGGESTIONS) {
    await handleSuggestion(thread);
  } else if (spec === SAFEHOUSE_CLAIMS) {
    // Claims are staff work, not a vote, and there is nothing to vet
    // automatically. Mark it Open and warn if the poster published a location
    // despite the channel topic.
    await applyStatusTag(thread, SAFEHOUSE_CLAIMS, TAG.OPEN);
    await warnIfLocationLeaked(thread, starter);
  } else {
    // Trading: bookkeeping only. No vetting, no duplicate check — two people
    // selling the same rifle are not duplicates, they're competition.
    await applyStatusTag(thread, TRADING, TAG.OPEN);
  }
}

module.exports = { handleThreadCreate, applyStatusTag, fetchStarter };
