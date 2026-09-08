'use strict';
/**
 * The messages that were taken back, so he can answer "what was deleted?"
 *
 * Somebody asked him exactly that and he had nothing — Discord keeps no record
 * a bot can read, and the message is gone from the channel before he is ever
 * called. The only way to know is to have been watching when it happened, so
 * this listens and keeps a short tail.
 *
 * Three deliberate limits, because a bot that remembers everything anybody ever
 * withdrew is a different and worse thing than one that can say what just
 * happened:
 *
 *   It is small — the last 30 per guild, and nothing older than six hours.
 *   It is in memory only — a restart forgets, and nothing is written to disk.
 *   It is only handed to him when somebody asks about deletions, not on every
 *   reply, so it is not quietly sitting in his context colouring everything.
 *
 * Only messages Discord had cached arrive with content. An older one comes
 * through as a partial and is recorded as "something, from someone" — which is
 * still the honest answer to "was anything deleted?", and better than silence.
 */

/** Per-guild tail length. */
const KEEP = 30;

/** Nothing older than this is offered. */
const WINDOW_MS = 6 * 60 * 60 * 1000;

/** Per-message clamp, matching the transcript's. */
const LINE_CHARS = 300;

/** guildId -> [{ at, channelId, channelName, author, content, hadAttachments }] */
const byGuild = new Map();

/** Record one deletion. Called from the messageDelete listener. */
function remember(message) {
  const guildId = message.guildId || message.guild?.id;
  if (!guildId) return;

  const list = byGuild.get(guildId) || [];
  list.push({
    at: Date.now(),
    channelId: message.channelId,
    channelName: message.channel?.name || null,
    // A partial has no author and no content; both are recorded as unknown
    // rather than dropped, because "one was removed and I could not see it" is
    // a true and useful answer.
    author: message.author?.username || null,
    authorId: message.author?.id || null,
    content: (message.content || '').replace(/\s+/g, ' ').trim().slice(0, LINE_CHARS) || null,
    hadAttachments: !!message.attachments?.size,
    byBot: !!message.author?.bot,
  });

  while (list.length > KEEP) list.shift();
  byGuild.set(guildId, list);
}

/** Whether a question is about deleted messages at all. */
function asksAboutDeletions(text) {
  return /\b(delet|remov|erase|wipe|took (it|that) (back|down)|censor|what did .{0,20}say)\w*/i.test(text || '');
}

/**
 * The block for the prompt, or '' when there is nothing to say.
 *
 * @param {string} guildId
 * @param {string} question what was asked — the block is only built when it is
 *   about deletions, so an ordinary chat does not carry a list of everything
 *   people have withdrawn.
 * @param {string} [channelId] when given, this channel's deletions come first
 */
function deletionsFor(guildId, question, channelId = null) {
  if (!asksAboutDeletions(question)) return '';

  const cutoff = Date.now() - WINDOW_MS;
  const all = (byGuild.get(guildId) || []).filter((d) => d.at >= cutoff);
  if (!all.length) return '';

  const here = channelId ? all.filter((d) => d.channelId === channelId) : all;
  const use = here.length ? here : all;

  const lines = use.map((d) => {
    const at = new Date(d.at);
    const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const who = d.author ? d.author : 'someone (too old for me to have seen)';
    const what = d.content
      || (d.hadAttachments ? '[an attachment, no text]' : '[I did not see what it said]');
    const where = d.channelName && d.channelName !== null ? ` in #${d.channelName}` : '';
    return `[${clock}] ${who}${where}: ${what}`;
  });

  return (
    `[MESSAGES DELETED RECENTLY — you were watching when these went. Somebody is asking about ` +
    `deletions, which is why you have them now.\n` +
    `Say what you saw plainly if you are asked. Do not go fishing with them: quoting a person's ` +
    `deleted message back at them when nobody asked is a nasty trick, and repeating one you were ` +
    `not asked about is worse]:\n${lines.join('\n')}\n`
  );
}

/** Wire the listener. Called once at startup. */
function watchDeletions(client) {
  client.on('messageDelete', (message) => {
    try {
      remember(message);
    } catch (err) {
      console.warn('[Deletions] Could not record one:', err?.message || err);
    }
  });

  client.on('messageDeleteBulk', (messages) => {
    try {
      for (const message of messages.values()) remember(message);
    } catch (err) {
      console.warn('[Deletions] Could not record a bulk removal:', err?.message || err);
    }
  });
}

module.exports = { watchDeletions, deletionsFor, asksAboutDeletions, remember, KEEP, WINDOW_MS };
