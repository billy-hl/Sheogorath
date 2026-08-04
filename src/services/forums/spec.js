'use strict';
/**
 * The shape of the two request forums, in one place.
 *
 * Setup creates channels from these specs and the runtime handler looks tags up
 * by name from them, so a rename here propagates to both halves instead of
 * leaving the handler applying a tag that no longer exists.
 *
 * Discord's limits, for reference: 20 tags per forum, 20 characters per tag
 * name. `moderated: true` restricts a tag to members with Manage Threads —
 * that's what keeps status honest, since the author of a post can't mark their
 * own suggestion Accepted.
 */

/** Status tag names, referenced by the handler. */
const TAG = {
  OPEN: 'Open',
  NEEDS_REVIEW: 'Needs Review',
  UNDER_REVIEW: 'Under Review',
  INCOMPATIBLE: 'Incompatible',
  APPROVED: 'Approved',
  ACCEPTED: 'Accepted',
  DENIED: 'Denied',
  DECLINED: 'Declined',
  INSTALLED: 'Installed',
  IMPLEMENTED: 'Implemented',
  DUPLICATE: 'Duplicate',
};

const t = (name, emoji, moderated = true) => ({ name, emoji: { id: null, name: emoji }, moderated });

/**
 * Generic server suggestions. No Workshop knowledge — the bot only adds vote
 * reactions and flags likely duplicates.
 */
const SUGGESTIONS = {
  key: 'suggestions',
  name: 'suggestions',
  topic:
    'Suggest changes to the server. One suggestion per post. ' +
    'Search before posting — duplicates get merged. ' +
    'React 👍 / 👎 on posts you care about; staff read the vote counts.',
  guidelines:
    'Post a suggestion and the community votes on it. Pick a category tag ' +
    'when you post; staff set the status tag as it moves along.',
  tags: [
    t(TAG.OPEN, '🕓'),
    t(TAG.UNDER_REVIEW, '🔍'),
    t(TAG.ACCEPTED, '✅'),
    t(TAG.DECLINED, '⛔'),
    t(TAG.IMPLEMENTED, '🎉'),
    t(TAG.DUPLICATE, '♻️'),
    // Category tags are deliberately unmoderated so posters can file their own.
    t('Server Settings', '⚙️', false),
    t('Map / Build', '🗺️', false),
    t('Roleplay', '🎭', false),
    t('Rules', '📜', false),
    t('Events', '📅', false),
    t('Bot', '🤖', false),
  ],
  defaultTag: TAG.OPEN,
};

/**
 * Workshop mod requests. Every post here gets vetted against what the server
 * can actually run.
 *
 * The bot only ever applies *factual* tags — Incompatible, Installed,
 * Duplicate, Needs Review — all of which follow from Workshop metadata or the
 * server ini. Approved and Denied are decisions, so they stay human.
 */
const MOD_REQUESTS = {
  key: 'modRequests',
  name: 'mod-requests',
  topic:
    'Request a Steam Workshop mod. Put the Workshop link in the post — ' +
    'Sheogorath vets it automatically and tags the result. One mod per post.',
  guidelines:
    'Paste the Workshop link in your post body. The bot checks the game, ' +
    'build tag, multiplayer support and recent Workshop comments, then reports ' +
    'back in the thread. Staff make the final call.',
  tags: [
    t(TAG.OPEN, '🕓'),
    t(TAG.NEEDS_REVIEW, '🔍'),
    t(TAG.INCOMPATIBLE, '🚫'),
    t(TAG.APPROVED, '✅'),
    t(TAG.DENIED, '⛔'),
    t(TAG.INSTALLED, '📦'),
    t(TAG.DUPLICATE, '♻️'),
  ],
  defaultTag: TAG.OPEN,
};

const FORUMS = [SUGGESTIONS, MOD_REQUESTS];

/** Up/down reactions added to every new post so staff can read interest. */
const VOTE_EMOJI = ['👍', '👎'];

module.exports = { TAG, SUGGESTIONS, MOD_REQUESTS, FORUMS, VOTE_EMOJI };
