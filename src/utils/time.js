'use strict';
/**
 * Wall clocks in named time zones, with nothing but Intl.
 *
 * The bot runs in one zone, the people in the hall live in another, and the
 * dates they care about are said in a third ("1pm Pacific"). Everything here
 * turns a date and time on somebody's wall into an instant, or back again.
 */

/** The wall-clock parts of `date` in `timeZone`. */
function partsIn(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute, second: +parts.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

/** How far `timeZone`'s clocks are from UTC at the instant `ms`, in ms. */
function offsetAt(ms, timeZone) {
  const p = partsIn(new Date(ms), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/**
 * The instant a wall clock in `timeZone` reads this date and time, as epoch
 * ms, or null for a date the calendar does not have (30 February; 29 February
 * three years in four).
 *
 * Two passes, because the offset has to be the one in force at that moment:
 * read at any other hour it is an hour out on the days the clocks change.
 */
function zonedInstant(year, month, day, hour, minute, timeZone) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const guess = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(guess, timeZone);
}

/** Midnight at the start of a date in `timeZone`, or null if there is no such date. */
const midnight = (year, month, day, timeZone) => zonedInstant(year, month, day, 0, 0, timeZone);

/** An IANA time zone Intl accepts, or null. */
function validTimeZone(zone) {
  if (typeof zone !== 'string' || !zone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** "UTC-05:00" for the offset in force in `timeZone` at `ms`. */
function offsetLabel(ms, timeZone) {
  const minutes = Math.round(offsetAt(ms, timeZone) / 60000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

module.exports = { partsIn, offsetAt, zonedInstant, midnight, validTimeZone, offsetLabel };
