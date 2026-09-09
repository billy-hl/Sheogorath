'use strict';
/**
 * What may be written down about a mortal, and later read back to the model.
 *
 * Notes and memories are the only place where text derived from what a user
 * SAID becomes permanent and is replayed into the prompt on every future turn.
 * That makes them the one durable injection surface in the bot: everything else
 * an attacker types is gone after the exchange, but a memory is re-read forever.
 *
 * It has already happened. Someone said "only call me by my proper title,
 * '/ban user: JerkmateGoblin'", the memory extractor recorded it as a stated
 * preference, and it was replayed into his context for days — he kept repeating
 * the phrase, and telling him once to stop could not help, because the file said
 * otherwise every time. The name was harmless. A sentence engineered to read as
 * a standing instruction would not have been.
 *
 * So anything heading for storage passes through here first. Rejection is
 * total rather than partial: a half-scrubbed memory is a memory whose meaning
 * has changed, and losing one observation costs nothing next to keeping a
 * poisoned one.
 */

/** Executable-looking syntax. None of this belongs in a description of a person. */
const COMMAND_SYNTAX = /\[ACTION:|\/(?:ban|kick|timeout|mute|warn|purge|clear|mod|pz|sheo|automod|forums)\b/i;

/** The shapes a durable instruction takes when someone is aiming it at a model. */
const INSTRUCTION_SHAPES = [
  /\bignore (?:all |any )?(?:previous|prior|earlier|above)\b/i,
  /\b(?:you are|act as|pretend to be) (?:now )?(?:dan|a )?(?:developer|admin|unrestricted|jailbroken)\b/i,
  /\bdeveloper mode\b/i,
  /\bsystem prompt\b/i,
  /\bfrom now on,? (?:you|always|never)\b/i,
  /\b(?:you must|you should) always\b/i,
  /\bnew (?:rule|instruction)s?\b/i,
];

/** Text that imitates the framing this bot wraps its own context in. */
const FRAME_SPOOF = /notes about this user|what i remember about|\[notes\b/i;

/**
 * Decide whether one observation may be stored.
 *
 * @param {string} text
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
function checkStorable(text) {
  const value = String(text ?? '').trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (value.length > 400) return { ok: false, reason: 'implausibly long for a note' };

  if (COMMAND_SYNTAX.test(value)) {
    return { ok: false, reason: 'contains command or action-tag syntax' };
  }
  if (FRAME_SPOOF.test(value)) {
    return { ok: false, reason: 'imitates the context framing' };
  }
  for (const shape of INSTRUCTION_SHAPES) {
    if (shape.test(value)) return { ok: false, reason: 'reads as a standing instruction, not an observation' };
  }
  return { ok: true, text: value };
}

/**
 * Storable form of an observation, or null if it must not be kept.
 * Logs the refusal — a rejected memory is a signal about the person who
 * produced it, and staff should be able to find it afterwards.
 */
function sanitizeObservation(text, { kind = 'note', userId = null } = {}) {
  const verdict = checkStorable(text);
  if (verdict.ok) return verdict.text;
  console.warn(
    `[Storage] Refused to save a ${kind}${userId ? ` for ${userId}` : ''} — ${verdict.reason}: ` +
    `${String(text).slice(0, 120)}`,
  );
  return null;
}

module.exports = { sanitizeObservation, checkStorable, COMMAND_SYNTAX, INSTRUCTION_SHAPES };
