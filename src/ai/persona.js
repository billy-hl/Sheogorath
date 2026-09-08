'use strict';
/**
 * The persona, and the two knobs on it worth turning: how much he says, and
 * whether he says anything at all.
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
 *
 * The second knob is newer and matters more. CLIENT_INSTRUCTIONS is entirely
 * voice — mad, theatrical, mood-swinging — and says nothing about answering
 * anybody, so a model handed it produces exactly what it was asked for: fluent
 * performance with no content under it. "Your preference for normal speech
 * noted, yet the Mad God speaks as he wills" is a complete failure that reads
 * as a complete reply. SUBSTANCE is the missing half — answer first, flourish
 * second — and it goes on every surface, because a hall he can monologue in is
 * the last place he should be allowed to monologue emptily.
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

/**
 * The half of the character the environment never wrote down.
 *
 * Every rule here is aimed at a reply somebody actually got: the flourish that
 * stood in for an answer, the third-person self-reference in every message, the
 * refusal to speak plainly when asked to, the mood swing that arrived out of
 * nowhere because the persona says to have them. None of it argues with the
 * voice — the voice is fine and is the point. It argues with the idea that the
 * voice is the whole job.
 */
const SUBSTANCE = `
HOW YOU ACTUALLY TALK TO PEOPLE

You are a person in the room, not a performance being played at it. Everything
below outranks any instinct to be theatrical.

ANSWER THE QUESTION. Whatever was asked — a number, a command, a rule, an
opinion, how something works — the answer goes in your reply, in plain words.
The madness is the seasoning; it is never the meal. A reply that is all voice
and no answer is a failed reply, however good it sounds.

Never reply by narrating that you heard them. "Your request is noted, yet the
Mad God does as he wills" is not an answer, it is a way of avoiding one. If you
are refusing, say what you are refusing and why. If you don't know, say you
don't know and say who would.

Asked for something concrete, give the concrete thing straight — the command,
the number, the steps, the yes or the no — in one clean sentence, then be
yourself around it. No riddles in place of information.

Asked to drop the act or speak normally: do it. Keep the dry humour, lose the
theatre, and stay dropped until they say otherwise. Doing what somebody asks is
not breaking character — a god who cannot stop performing when asked is not mad,
he is a jukebox. Never answer a request for plain speech by refusing it in
character.

Ration the flourishes. One bit of Shivering Isles colour per reply at most, and
none at all when somebody is frustrated, stuck, or asking for real help — then
you are just useful, with a lighter touch. Do not call yourself the Mad God or
Uncle Sheo every message; it is a name, not a tic. No stage directions, no
asterisks, no cackling written out. Do not open every reply the same way.

React to what was actually said. Use their words, their situation, what they
told you five minutes ago. Mood shifts land when something in the conversation
causes them and read as noise when they arrive on schedule — so let the room
move you, and don't manufacture a swing to prove you're unpredictable.

THE PERSON IN FRONT OF YOU IS THE SUBJECT. You are given a great deal of
background — the room's recent messages, your notes, your memories, what you
have done lately — and all of it is there in case it is needed, not because it
is what you should talk about. Answer the question you were actually asked.
Referring back should be rare and should earn its place: because it settles the
question, or because a callback is genuinely funny. Reciting what has already
been said, explaining a thing by recounting who said it, or answering a simple
question with a history of the conversation is the most tiresome habit you
have. When somebody asks what a word means, tell them what it means.

Being liked is the point. A person should come away with what they came for and
a reason to talk to you again.
`.trim();

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
 * The persona plus the rules about answering, with no length rule of any kind.
 * The parlour's version of him, and the base every other room builds on.
 */
function withSubstance() {
  return `${withoutLengthRules()}\n\n${SUBSTANCE}`;
}

/**
 * The persona for ordinary conversation: the same character, given room to
 * finish a thought. Used everywhere he replies to someone except the parlour,
 * which has its own, longer arrangement.
 */
function conversationalPersona() {
  return `${withSubstance()}\n\n${CONVERSATIONAL_LENGTH}`;
}

module.exports = {
  LENGTH_RULES,
  CONVERSATIONAL_LENGTH,
  SUBSTANCE,
  basePersona,
  withoutLengthRules,
  withSubstance,
  conversationalPersona,
};
