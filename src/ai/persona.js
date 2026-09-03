'use strict';
/**
 * The persona, and the one knob on it worth turning: how much he says.
 *
 * `CLIENT_INSTRUCTIONS` ends with a hard length cap — "SHORT and punchy (1-2
 * sentences max)" — which is right for a bot that pipes up when its name is
 * mentioned in general chat, and wrong for every case where somebody is
 * actually talking to it. Two sentences is enough to be funny and not enough to
 * answer anything.
 *
 * The parlour learned the way to change it: appending "that rule does not apply"
 * loses the argument, because the original is in capitals and says "max". The
 * rule has to come OUT of the text and be replaced, not contradicted. So this
 * module owns the surgery, and there are two lengths on the other side of it —
 * conversational for the rooms he is spoken to in, and unclipped for his own
 * hall.
 */

/**
 * Sentences in the persona that cap how much he says.
 *
 * Only length directives are cut. "Always complete your thoughts" survives,
 * because that one is about finishing sentences, not rationing them.
 */
const LENGTH_RULES = /[^.!?]*\b(short and punchy|1-2 sentences|1 to 2 sentences|one or two sentences|keep (?:it|responses|replies) short|be concise|stay concise)\b[^.!?]*[.!?]/gi;

/**
 * What replaces the cap when someone is talking to him rather than about him.
 *
 * Deliberately a small step, not the parlour's open leash: this is still chat,
 * and a paragraph in reply to "sheo what's for dinner" is worse than a line.
 * Two to four sentences is the difference between a punchline and an answer.
 */
const CONVERSATIONAL_LENGTH =
  'LENGTH: two to four sentences — long enough to actually answer and land the joke, ' +
  'short enough to read at a glance. A single line is fine when a single line does it, ' +
  'and one more sentence is fine when the question has more in it than that. Never pad, ' +
  'never pile on flourishes to fill the room, and always finish the thought you started.';

/** The raw persona, straight from the environment. */
function basePersona() {
  return process.env.CLIENT_INSTRUCTIONS || '';
}

/**
 * The persona with its length cap cut out.
 *
 * Falls back to the untouched persona if the cut took too much — a future edit
 * to CLIENT_INSTRUCTIONS that words the rule differently should leave him terse
 * rather than leave him with no character at all.
 */
function withoutLengthRules() {
  const base = basePersona();
  const stripped = base.replace(LENGTH_RULES, ' ').replace(/\s{2,}/g, ' ').trim();
  return stripped.length > base.length * 0.5 ? stripped : base;
}

/**
 * The persona for ordinary conversation: the same character, given room to
 * finish a thought. Used everywhere he replies to someone except the parlour,
 * which has its own, longer arrangement.
 */
function conversationalPersona() {
  return `${withoutLengthRules()}\n\n${CONVERSATIONAL_LENGTH}`;
}

module.exports = {
  LENGTH_RULES,
  CONVERSATIONAL_LENGTH,
  basePersona,
  withoutLengthRules,
  conversationalPersona,
};
