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
  PENDING: 'Pending',
  COMPLETED: 'Completed',
  EXPIRED: 'Expired',
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

/**
 * In-character trading board.
 *
 * Unlike the two request forums, nothing here is vetted and no votes are
 * added — a trade offer is not a proposal to be judged, and up/down reactions
 * on someone's asking price would just be noise. The bot's whole job is
 * bookkeeping: mark new offers Open, and sweep dead ones off the board so what
 * remains is what's actually available.
 */
const TRADING = {
  key: 'trading',
  name: 'trading',
  topic:
    'In-character trading. One offer per post — tag it WTS (selling), WTB (buying) ' +
    'or WTT (trading), and say where the handover happens. ' +
    'Mark it Completed when the deal is done.',
  guidelines:
    'Post an offer, haggle in its thread, and tag it Completed when done. ' +
    'Offers with no activity go stale and get swept off the board automatically.',
  tags: [
    // Status — bot and staff only, so a seller can't quietly un-expire a post.
    t(TAG.OPEN, '🕓'),
    t(TAG.PENDING, '🤝'),
    t(TAG.COMPLETED, '✅'),
    t(TAG.EXPIRED, '⌛'),
    // What kind of offer — the poster's to set.
    t('WTS', '💰', false),
    t('WTB', '🛒', false),
    t('WTT', '🔄', false),
    // What it's about, so the board can be filtered.
    t('Weapons', '🔫', false),
    t('Food & Meds', '💊', false),
    t('Vehicles', '🚗', false),
    t('Building Mats', '🧱', false),
    t('Services', '🔧', false),
  ],
  defaultTag: TAG.OPEN,
  // Offers idle this long are swept. Overridable per guild via
  // channels-adjacent config; see tradeSweep.js.
  staleDays: 7,
};

/**
 * Safehouse claims. Shaped like MOD_REQUESTS — one request per post, staff set
 * a status tag — but with one hard rule the old text channel lacked.
 *
 * That channel's topic asked claimants to "post the building address or map
 * coordinates". On 2026-08-06 someone did, and other players immediately
 * pointed out they had just published their own base ("edit your xy out cuz you
 * exposing yourself"). A public claims board cannot ask for locations: anyone
 * reading it learns where the loot is. So the location goes to staff privately
 * and the post carries only what is safe to read.
 */
const SAFEHOUSE_CLAIMS = {
  key: 'safehouseClaims',
  name: 'safehouse-claims',
  topic:
    'Claim a player-built safehouse. DO NOT post coordinates, addresses or map ' +
    'locations — this channel is public and that tells raiders where you live. ' +
    'Staff will ask for the location privately. One claim per post.',
  guidelines:
    'Post the in-game name of the claim and who should be on it. Leave the ' +
    'location out — staff will ask you for it in private, or read it off your ' +
    'in-game ticket. Staff set the status tag as the claim is processed.',
  tags: [
    t(TAG.OPEN, '🕓'),
    t(TAG.UNDER_REVIEW, '🔍'),
    t(TAG.APPROVED, '✅'),
    t(TAG.DENIED, '⛔'),
    t(TAG.DUPLICATE, '♻️'),
    t(TAG.EXPIRED, '⌛'),
    // What kind of claim — the poster's to set.
    t('New Claim', '🏠', false),
    t('Add Member', '👥', false),
    t('Transfer', '🤝', false),
    t('Release', '📤', false),
  ],
  defaultTag: TAG.OPEN,
};

const FORUMS = [SUGGESTIONS, MOD_REQUESTS, TRADING, SAFEHOUSE_CLAIMS];

/**
 * Forums whose new posts get up/down reactions. Trading is deliberately
 * excluded — see the note on TRADING.
 */
const VOTE_FORUM_KEYS = new Set([SUGGESTIONS.key, MOD_REQUESTS.key]);

/** Up/down reactions added to every new post so staff can read interest. */
const VOTE_EMOJI = ['👍', '👎'];

module.exports = {
  TAG,
  SUGGESTIONS,
  MOD_REQUESTS,
  TRADING,
  SAFEHOUSE_CLAIMS,
  FORUMS,
  VOTE_EMOJI,
  VOTE_FORUM_KEYS,
};
