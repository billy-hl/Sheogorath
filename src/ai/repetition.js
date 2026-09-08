'use strict';
/**
 * Catching him saying the same thing twice.
 *
 * He answered a reply by re-sending his previous message nearly word for word:
 * somebody had answered a question he asked, and he responded by asking it
 * again. The prompt has been told not to, but "do not repeat yourself" is a
 * request, and the failure it guards against is the model doing the most
 * probable thing — which, when the context barely changed between two turns, is
 * the reply it just produced.
 *
 * So it is also checked in code. The last thing he said in each channel is kept
 * in memory, the next reply is compared against it, and a near-duplicate is
 * regenerated once with that fact spelled out. One retry, never a loop: if he
 * insists on repeating himself twice, the second answer goes out anyway, because
 * a repeated message is worse than nothing but far better than silence.
 */

/** Above this much word overlap, it is the same message wearing a hat. */
const SIMILARITY = 0.75;

/** channelId -> the last thing he said there. */
const lastSaid = new Map();

/** Words, lowercased, stripped of punctuation and Discord furniture. */
function words(text) {
  return (text || '')
    .toLowerCase()
    .replace(/<[@#!&:][^>]+>/g, ' ')   // mentions, channels, custom emoji
    .replace(/-#.*$/gm, ' ')            // his own subtext footers
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * How alike two messages are, 0 to 1.
 *
 * Jaccard over word sets: order-insensitive on purpose, because the repeat that
 * started this was the same sentences lightly reshuffled with a "Yes," bolted
 * on the front. Comparing sequences would have called that a different message.
 */
function similarity(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;

  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/** What he last said in this channel, or null. */
function previousReply(channelId) {
  return lastSaid.get(channelId) || null;
}

/** Remember what he said, so the next turn can be compared against it. */
function remember(channelId, reply) {
  if (!channelId || !reply) return;
  lastSaid.set(channelId, reply);

  // The map is per channel and never read for anything but the next turn, so
  // it only needs bounding, not expiring.
  if (lastSaid.size > 200) {
    lastSaid.delete(lastSaid.keys().next().value);
  }
}

/**
 * Is this reply the last one again?
 *
 * @returns {{repeated: boolean, score: number}}
 */
function isRepeat(channelId, reply) {
  const previous = previousReply(channelId);
  if (!previous) return { repeated: false, score: 0 };
  const score = similarity(previous, reply);
  return { repeated: score >= SIMILARITY, score };
}

/** What to add to the prompt when he has just repeated himself. */
function retryNudge(previous) {
  return (
    '\n\n--- YOU HAVE JUST SAID THIS ---\n\n' +
    `Your previous message in this channel was:\n"${previous}"\n\n` +
    'The reply you were about to send says the same thing again. They have read it once already. ' +
    'Say something else: answer what they have actually said now, add something new, or be brief ' +
    'and move the conversation on. Do not re-ask a question they have already answered, and do not ' +
    'rephrase your last message — write a different one.'
  );
}

module.exports = { isRepeat, remember, previousReply, similarity, retryNudge, SIMILARITY };
