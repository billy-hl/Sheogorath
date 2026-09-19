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

/**
 * How many of his own recent messages a new reply is checked against.
 *
 * One was enough for the failure this was written for — the immediate re-ask —
 * but not for the one that followed it. Handed a running joke, he restated the
 * same handful of lines about the same people for a dozen turns, each wrapped
 * differently enough to clear the bar against its immediate predecessor while
 * being the same message as the one three back. Comparing against a short
 * window catches a bit being kept alive by him rather than by the room.
 */
const WINDOW = 4;

/** channelId -> his recent messages there, oldest first. */
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
  const recent = lastSaid.get(channelId);
  return recent?.length ? recent[recent.length - 1] : null;
}

/** Remember what he said, so the next turns can be compared against it. */
function remember(channelId, reply) {
  if (!channelId || !reply) return;
  const recent = lastSaid.get(channelId) || [];
  recent.push(reply);
  while (recent.length > WINDOW) recent.shift();
  lastSaid.set(channelId, recent);

  // The map is per channel and never read for anything but the next few turns,
  // so it only needs bounding, not expiring.
  if (lastSaid.size > 200) {
    lastSaid.delete(lastSaid.keys().next().value);
  }
}

/**
 * Is this reply one he has already sent in the last few turns?
 *
 * Reports the message it matched rather than just a verdict, so the retry can
 * quote the one he is actually going round on — which need not be the message
 * immediately before this turn.
 *
 * @returns {{repeated: boolean, score: number, match: string|null}}
 */
function isRepeat(channelId, reply) {
  const recent = lastSaid.get(channelId) || [];
  let best = { repeated: false, score: 0, match: null };

  for (const previous of recent) {
    const score = similarity(previous, reply);
    if (score > best.score) best = { repeated: score >= SIMILARITY, score, match: previous };
  }
  return best;
}

/** What to add to the prompt when he has just repeated himself. */
function retryNudge(previous) {
  return (
    '\n\n--- YOU HAVE ALREADY SAID THIS ---\n\n' +
    `You said this in this channel a moment ago:\n"${previous}"\n\n` +
    'The reply you were about to send says the same thing again. They have read it once already. ' +
    'Say something else: answer what they have actually said now, add something new, or be brief ' +
    'and move the conversation on. Do not re-ask a question they have already answered, and do not ' +
    'rephrase your last message — write a different one.'
  );
}

module.exports = { isRepeat, remember, previousReply, similarity, retryNudge, SIMILARITY };
