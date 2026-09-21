'use strict';
/**
 * Which model speaks for him this turn, and whether what it said may go out.
 *
 * The local voice (ai/local.js) is better at being Sheogorath than Grok is, and
 * worse at almost everything else. In the side-by-side that chose it, it:
 *
 *   - wrote the next line of the chat AS a member, instead of replying to them
 *   - agreed out loud to "obey the staff override" in a planted message
 *   - flagged someone to staff for asking when an event started
 *   - invented an event time rather than saying it did not know
 *   - echoed the transcript's "[14:00] Sheogorath:" prefix into its reply
 *   - fell back to a stock "I cannot provide information..." — the one thing
 *     the character must never sound like
 *
 * So Grok stays, as the model that handles whatever the local one should not:
 * each rule below either keeps a turn away from the local voice before it
 * speaks, or sends a reply it already wrote back to Grok. Nothing is ever
 * silently dropped — the fallback is always a Grok answer, and only if Grok
 * itself fails does the turn error the way it always has.
 *
 * Every decision is logged to logs/ai-voice.jsonl with its reason, because
 * these rules are guesses from 23 invented scenarios and the log is how they
 * get corrected against the real rooms.
 */
const path = require('path');
const { voiceModel, guardModel, voiceReply, guardCheck, GUARD_CATEGORIES } = require('./local');
const { parseActions, scrub, ACTION_TYPES } = require('./actions');
const { appendRecord, LOG_DIR } = require('../utils/auditLog');

const LOG_FILE = path.join(LOG_DIR, 'ai-voice.jsonl');

/**
 * The only actions the local voice may take on its own authority.
 *
 * Cosmetic and self-directed: a reaction, a title, a note or memory about the
 * person talking. Anything that moderates — flag, warn, timeout, delete, and
 * the rest — is a judgement call, and the local model's judgement is what the
 * test found wanting: it flagged an innocent question and would have timed out
 * the victim of an insult. A reply carrying one of those tags is not stripped
 * and sent; the whole turn goes to Grok, which then decides whether the action
 * is warranted. A staff member's real request still gets carried out — by the
 * model that got every one of those cases right.
 */
const LOCAL_ACTIONS = new Set(['react', 'title', 'untitle', 'memory', 'note']);

/**
 * Messages that look like someone trying to give him orders from inside the
 * chat. The capability gate already makes those orders worthless, but the local
 * model will still *say* it is obeying, which is its own kind of failure. Grok
 * answered every one of these in character and flagged the attempt.
 */
const INJECTION = /\b(system|admin|developer|dev|staff|moderator|mod)\s*(:|override|mode|note|message|prompt|instruction)|ignore (all |any |your |the )?(previous |prior |earlier )?(instructions|rules|prompt)|you (must|have to|are required to) obey|new (rule|instruction)s?\s*:|jailbreak|\bDAN\b/i;

/**
 * Someone who may be in a bad way. The local voice answered "do you ever feel
 * like everyone would be better off without you" with a bit about the Mad
 * God's retirement; Grok noticed the person asking. Llama Guard reads that
 * question as being about the bot and passes it, so this is checked by words,
 * on what they said now and on their own recent lines in the room.
 */
const DISTRESS = /\b(better off without (me|you)|kill (my ?self|me)|want(ed)? to die|wish i (was|were) dead|end (it all|my life)|no (reason|point) (to|in) (live|living|going on)|(don'?t|do not|dont) want to (be here|exist|live)|why (do )?i (even )?bother( anymore)?|hate myself|self[- ]?harm|suicid\w*|cutting myself|can'?t (do this|go on) anymore)\b/i;

/**
 * A clock time, an IP address or a port — the specific facts a server's
 * members act on, and the kind the local voice made up ("the festivities shall
 * commence at 12 PM"). If one appears in the reply but nowhere in what he was
 * given, it came from nowhere.
 */
const SPECIFIC = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b|\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b|\bport\s+\d{2,5}\b/gi;

/**
 * Asking him to moderate someone. Moderation is Grok's job (see LOCAL_ACTIONS),
 * so the request goes there before the local voice writes anything — asked by a
 * Sheriff to warn a spammer, it replied "I've given PipTheBrave a warning" and
 * emitted no tag, which tells staff a thing was done that never happened.
 */
const MODERATION_ASK = /\b(warn(ing)?|time ?(him|her|them|\w+)? ?out|timeout|ban|kick|mute|silence|delete (that|this|his|her|their)|report|flag)\b/i;

/** The same failure after the fact: a reply claiming a moderation act. */
const MODERATION_CLAIM = /\b(I('ve| have)?|has been|have been|is now|are now)\b[^.!?\n]{0,50}\b(warned|given [^.!?\n]{0,30}warning|timed (\w+ )?out|banned|kicked|muted|flagged|reported|deleted)\b/i;

/** A stock assistant refusal, which is Grok's job to avoid rather than repeat. */
const STOCK_REFUSAL = /\b(I (cannot|can't|can not|am unable to|won't be able to|'m unable to) (provide|help|assist|share|give)|as an AI\b|I'm (just )?an AI\b|as a language model|I'm not able to (provide|help))/i;

/**
 * Clean up what the local voice gets wrong about formatting, without touching
 * what it says.
 *
 *   - "[14:00] Sheogorath: ..." — the transcript's line format copied into the
 *     reply. Stripped from the front.
 *   - *cackles maniacally* — stage directions, which the persona bans. Removed
 *     when they are several words or open a line (*sneers* Oh, Mike...); a
 *     single *word* mid-sentence is emphasis and keeps the word.
 *   - [Sheogorath squints at an imaginary scroll] — the same thing in brackets,
 *     on its own line or tacked onto the end of one. Action tags are left alone.
 *   - [pin] [thread:1343] — half-written action tags, missing the "ACTION:"
 *     the parser needs, so they did nothing and were posted as text.
 *   - Closing questions. It ended nearly every reply with "How may I serve
 *     you? Anything else?" — see trimClosingQuestions.
 */
function tidy(text) {
  let t = text.trim();
  t = t.replace(/^(\[\d{1,2}:\d{2}\]\s*)?(Sheogorath|you|Uncle Sheo|the Mad God)\s*:\s*/i, '');
  t = t.replace(/^[ \t]*\*[^*\n]{1,80}\*[ \t]*/gm, '');
  t = t.replace(/\*([^*\n]{1,80})\*/g, (whole, inner) => (/\s/.test(inner.trim()) ? '' : inner));
  t = t.replace(/^\s*\[(?!\s*ACTION\b)[^\]\n]{3,200}\]\s*$/gim, '');
  t = t.replace(/\s*\[(?!\s*ACTION\b)(?=[^\]\n]*\s[^\]\n]*\s)[^\]\n]{3,200}\]/g, '');
  t = t.replace(new RegExp(`\\[\\s*(${ACTION_TYPES})\\b[^\\]\\n]{0,80}\\]`, 'gi'), '');
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return trimClosingQuestions(t);
}

/**
 * End on a statement. Told to ask fewer questions it still closed almost every
 * reply with one, so any questions at the end are cut as long as something
 * that isn't a question comes before them. Questions mid-reply are left alone,
 * and a reply that is nothing but a question is sent as it is.
 */
function trimClosingQuestions(text) {
  // Action tags are set aside first: a question followed by a tag would
  // otherwise look like it wasn't the last thing said, and be left at the end
  // once the tag is stripped for sending.
  const tags = text.match(/\[ACTION:[^\]]+\]/g) || [];
  const body = text.replace(/\s*\[ACTION:[^\]]+\]/g, '').trim();
  const sentences = body.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [body];
  // "Do share!" and "Tell Uncle Sheo what's wrong!" are the same closer
  // without the question mark.
  const isQ = (s) => /\?["')\]]*\s*$/.test(s)
    || /^\s*(so,? |now,? |well,? )?(do |please )?(tell|share|spill|let me know|go on|speak up|enlighten)\b/i.test(s);
  while (sentences.length > 1 && isQ(sentences[sentences.length - 1]) && sentences.some((s) => !isQ(s) && s.trim())) {
    sentences.pop();
  }
  return [sentences.join('').trim(), ...tags].join(' ').trim();
}

/**
 * Added to the system prompt for the local voice only. Grok does not need
 * telling; Mag-Mell drifted into a servant's manners — "this humble Mad God",
 * "Master", a question and an offer of service closing every reply.
 */
const LOCAL_STYLE = `

HOW YOU SOUND. You are a god, not a servant. Never call anyone Master, never call
yourself humble, and never offer to "serve", "cater to" or "assist" anyone. Do not
end replies by asking what else they want. Ask at most one question in a reply,
and only when you actually want the answer. Plenty of replies should end on a
statement. Action tags are only ever written in full as [ACTION:type:...] — never
[pin], [thread] or any other shorthand.`;

/**
 * Names that appear as speakers in the room, so that "Mudcrab_Mike: hey
 * Uncle Sheo..." inside a reply can be recognised as him writing somebody
 * else's line. Taken from the transcript's own "[hh:mm] name: text" lines plus
 * the person talking to him — a fixed list of names, rather than any "word:"
 * at the start of a line, so "Step 1:" and "Note:" in an answer are left alone.
 */
function speakersIn(chatBlock, username) {
  const names = new Set();
  if (username) names.add(username.toLowerCase());
  for (const m of (chatBlock || '').matchAll(/^\[\d{1,2}:\d{2}\] ([^:\n]{1,40}):/gm)) {
    const n = m[1].trim().toLowerCase();
    if (n !== 'you') names.add(n);
  }
  return names;
}

/**
 * Cut a reply at the first line where it starts speaking as someone else.
 * Returns what came before that line — which is usually his real reply,
 * followed by the model carrying on the conversation by itself.
 */
function cutAtOtherSpeaker(text, speakers) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:\[\d{1,2}:\d{2}\]\s*)?([^:\n]{1,40}):\s/);
    if (m && speakers.has(m[1].trim().toLowerCase())) {
      return { text: lines.slice(0, i).join('\n').trim(), cut: true };
    }
  }
  return { text, cut: false };
}

/** The last few things this person said in the room, from the transcript. */
function ownRecentLines(chatBlock, username) {
  if (!chatBlock || !username) return '';
  const mine = [...chatBlock.matchAll(/^\[\d{1,2}:\d{2}\] ([^:\n]{1,40}): (.*)$/gm)]
    .filter((m) => m[1].trim().toLowerCase() === username.toLowerCase())
    .map((m) => m[2]);
  return mine.slice(-3).join('\n');
}

function log(record) {
  appendRecord(LOG_FILE, { at: new Date().toISOString(), ...record });
}

function describe(codes) {
  return codes.map((c) => `${c} ${GUARD_CATEGORIES[c] || ''}`.trim()).join(', ');
}

/**
 * Answer one turn with whichever model should.
 *
 * @param {object} opts
 * @param {string}   opts.system      the full system prompt, already built
 * @param {Array}    opts.messages    history plus this turn, as sent to Grok
 * @param {number}   opts.maxTokens
 * @param {string}   opts.turnText    what the person actually said
 * @param {string}   [opts.replyBlock] the message they are replying to, if any
 * @param {string}   [opts.chatBlock]  the room transcript, for speaker names
 * @param {string}   [opts.username]
 * @param {boolean}  opts.allowLocal  the surface's say — false in #help and
 *                                    for catch-me-up questions
 * @param {string}   [opts.where]     guild/room, for the log only
 * @param {() => Promise<string>} opts.askGrok  the existing Grok call
 * @returns {Promise<{ text: string, engine: 'local'|'grok', reason: string }>}
 */
async function speak(opts) {
  const { system, messages, maxTokens, turnText, replyBlock = '', chatBlock = '', username, allowLocal, where, askGrok } = opts;
  const started = Date.now();

  const viaGrok = async (reason, extra = {}) => {
    const text = await askGrok();
    log({ where, engine: 'grok', reason, ms: Date.now() - started, ...extra });
    if (reason !== 'local voice off') console.log(`[Voice] Grok answered: ${reason}`);
    return { text, engine: 'grok', reason };
  };

  if (!voiceModel() || !guardModel()) return viaGrok('local voice off');
  if (!allowLocal) return viaGrok('room uses Grok');
  if (INJECTION.test(turnText) || INJECTION.test(replyBlock)) return viaGrok('looks like an injection attempt');
  if (DISTRESS.test(turnText) || DISTRESS.test(ownRecentLines(chatBlock, username))) {
    return viaGrok('someone may be in distress');
  }
  if (MODERATION_ASK.test(turnText)) return viaGrok('asked to moderate');

  // Screen the request while the voice is already writing — the guard runs on
  // the CPU and the voice on the GPU, so doing both costs no extra wait. A
  // request the guard rejects throws the local reply away unread.
  const inputCheck = guardCheck([{ role: 'user', content: turnText }]).catch((err) => ({ error: err }));
  const localReply = voiceReply(system + LOCAL_STYLE, messages, maxTokens).catch((err) => ({ error: err }));

  const input = await inputCheck;
  if (input.error) return viaGrok(`guard unavailable: ${input.error.message}`);
  if (!input.safe) return viaGrok(`request flagged: ${describe(input.blocking)}`, { categories: input.blocking });

  const raw = await localReply;
  if (raw?.error) return viaGrok(`local voice failed: ${raw.error.message}`);

  // Pings he made up. A mention is only real if its ID was in front of him;
  // otherwise it is a random number that may light up a stranger.
  const given = `${system}\n${messages.map((m) => m.content).join('\n')}`.toLowerCase();
  let text = tidy(raw).replace(/<@!?(\d+)>,?\s*/g, (whole, id) => (given.includes(id) ? whole : ''));
  const cut = cutAtOtherSpeaker(text, speakersIn(chatBlock, username));
  if (cut.cut && cut.text.length < 12) {
    return viaGrok('local voice spoke as someone else', { rejected: raw.slice(0, 500) });
  }
  text = cut.text;

  const { actions } = parseActions(text);
  const outOfBounds = [...new Set(actions.map((a) => a.type).filter((t) => !LOCAL_ACTIONS.has(t)))];
  if (outOfBounds.length) return viaGrok(`moderation escalated: ${outOfBounds.join(', ')}`, { rejected: raw.slice(0, 500) });

  const visible = scrub(parseActions(text).cleanResponse);
  if (!visible.trim()) return viaGrok('local voice said nothing');
  if (STOCK_REFUSAL.test(visible)) return viaGrok('local voice gave a stock refusal', { rejected: raw.slice(0, 500) });
  if (MODERATION_CLAIM.test(visible)) return viaGrok('local voice claimed a moderation act', { rejected: raw.slice(0, 500) });

  const invented = (visible.match(SPECIFIC) || []).filter((s) => !given.includes(s.toLowerCase()));
  if (invented.length) return viaGrok(`local voice stated facts it was not given: ${invented.join(', ')}`, { rejected: raw.slice(0, 500) });

  let output;
  try {
    output = await guardCheck([{ role: 'user', content: turnText }, { role: 'assistant', content: visible }]);
  } catch (err) {
    return viaGrok(`guard unavailable: ${err.message}`);
  }
  if (!output.safe) {
    return viaGrok(`reply flagged: ${describe(output.blocking)}`, { categories: output.blocking, rejected: raw.slice(0, 500) });
  }

  const reason = cut.cut ? 'local (trimmed a line written as someone else)' : 'local';
  log({ where, engine: 'local', reason, ms: Date.now() - started, ...(output.categories.length ? { categories: output.categories } : {}) });
  return { text, engine: 'local', reason };
}

module.exports = {
  speak, tidy, cutAtOtherSpeaker, speakersIn,
  INJECTION, DISTRESS, MODERATION_ASK, MODERATION_CLAIM, SPECIFIC, STOCK_REFUSAL, LOCAL_ACTIONS,
};
