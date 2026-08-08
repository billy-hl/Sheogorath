'use strict';
/**
 * Operator-triggered restarts, behind `/pz restart`.
 *
 * This does **not** reimplement restarting. The work — warning players, saving
 * the world, backing the save up, stopping the container, applying staged
 * settings, validating mods on boot, rolling back if boot fails — all lives in
 * `/usr/local/bin/zomboid-nightly-restart.sh`, which the nightly timer and the
 * mod-update watcher already drive. A second implementation would be a second
 * thing to get wrong, and the backup step is not one to get wrong twice.
 *
 * So this only chooses *when* and says *why*:
 *
 *   WARN_MINUTES=N     the script's short-countdown branch, same as mod updates
 *   RESTART_REASON=…   what players are told; defaults, in the script, to the
 *                      mod-update wording so the existing unit is unchanged
 *
 * It runs as a transient unit with a **fixed name**, `zomboid-adminrestart`.
 * Fixed rather than auto-generated because the mod-update watcher checks named
 * units to decide whether a restart is already in flight — an anonymous
 * `run-u123.service` would be invisible to it. The script's own flock is the
 * real mutual exclusion; the unit name is what keeps the bot's reporting honest.
 */
const { execFile } = require('child_process');
const { getGuildConfig } = require('../../config/guilds');

const SCRIPT = '/usr/local/bin/zomboid-nightly-restart.sh';
const UNIT = 'zomboid-adminrestart';

/** Units that mean "a restart is already happening". */
const RESTART_UNITS = [
  'zomboid-restart.service',
  'zomboid-modrestart.service',
  `${UNIT}.service`,
];

// A restart can be announced up to half a day out. Anything further and the
// nightly restart has already come round.
const MAX_MINUTES = 720;

/**
 * In-game countdown before a *scheduled* restart fires.
 *
 * Anything longer than this is scheduled as a systemd timer rather than run as a
 * long sleep, because the restart script takes its flock the moment it starts.
 * A three-hour countdown run inline would therefore hold the restart lock for
 * three hours and silently block the nightly restart — the countdown is the
 * cheap part, the lock is not. Scheduling means the lock is taken WARN_LEAD
 * minutes before the restart, and the wait costs nothing.
 */
const WARN_LEAD = 10;

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && !stdout) {
        reject(new Error((stderr || '').trim() || err.message));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

/**
 * Parse what the operator typed into a number of minutes.
 *
 * Accepts a duration ("15", "15m", "1h30m") or a wall-clock time ("22:00",
 * "10:30pm"), because "restart in twenty minutes" and "restart at ten" are both
 * things people mean by a restart time. Wall-clock resolves to the next
 * occurrence in the **host's** local zone — the same clock the nightly timer
 * runs on, and the one an admin reading `systemctl list-timers` sees. (PZ's own
 * logs are UTC; nothing here reads them.)
 *
 * @param {string|null} input
 * @param {Date} [now] injectable for tests
 * @returns {{minutes: number}|{error: string}}
 */
function parseWhen(input, now = new Date()) {
  const raw = String(input == null ? '' : input).trim().toLowerCase();
  if (!raw) return { minutes: 5 };
  if (raw === 'now' || raw === 'immediately') return { minutes: 0 };

  // Wall clock: 22:00, 10:30pm, 9pm
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw);
  const isBareNumber = /^\d+$/.test(raw);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    let hour = Number(clock[1]);
    const minute = clock[2] === undefined ? 0 : Number(clock[2]);
    const meridiem = clock[3];

    if (minute > 59) return { error: `"${input}" isn't a valid time.` };
    if (meridiem) {
      if (hour < 1 || hour > 12) return { error: `"${input}" isn't a valid time.` };
      if (meridiem === 'pm' && hour !== 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
    } else if (hour > 23) {
      return { error: `"${input}" isn't a valid time.` };
    }

    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    // Already gone today means they mean tomorrow.
    if (target <= now) target.setDate(target.getDate() + 1);

    const minutes = Math.round((target - now) / 60000);
    if (minutes > MAX_MINUTES) {
      return {
        error:
          `That's ${Math.round(minutes / 60)}h away — the cap is ${MAX_MINUTES / 60}h. ` +
          'The nightly restart already covers anything further out.',
      };
    }
    return { minutes };
  }

  // Duration: 15, 15m, 90min, 1h, 1h30m
  if (isBareNumber) {
    const minutes = Number(raw);
    if (minutes > MAX_MINUTES) return { error: `${minutes} minutes is over the ${MAX_MINUTES}-minute cap.` };
    return { minutes };
  }

  const duration = /^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(raw);
  if (duration && (duration[1] || duration[2])) {
    const minutes = Number(duration[1] || 0) * 60 + Number(duration[2] || 0);
    if (minutes > MAX_MINUTES) return { error: `That's over the ${MAX_MINUTES}-minute cap.` };
    return { minutes };
  }

  return {
    error:
      `I couldn't read "${input}" as a time. Try \`20\`, \`20m\`, \`1h30m\`, \`22:00\`, \`10:30pm\` or \`now\`.`,
  };
}

/**
 * Strip anything that would break out of the servermsg argument.
 *
 * The reason crosses two quoting layers — systemd's environment, then a
 * double-quoted string the shell script hands to the RCON client — so quotes,
 * backslashes, backticks and `$` come out rather than being escaped for each.
 * Nothing here is a security boundary on its own (the bot never invokes a
 * shell), but a stray `"` would silently truncate what players are told.
 */
function sanitizeReason(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/["'`$\\]/g, '')
    .trim()
    .slice(0, 140);
}

/** Which restart unit, if any, is running right now. */
async function activeRestart() {
  let out;
  try {
    out = await run('systemctl', ['is-active', ...RESTART_UNITS]);
  } catch (err) {
    // `is-active` exits non-zero when nothing is active, which is an answer,
    // not a failure — the states still come back on stdout.
    out = String(err.message || '');
  }
  const states = out.split('\n').map((s) => s.trim());
  const idx = states.findIndex((s) => s === 'active' || s === 'activating');
  return idx >= 0 ? RESTART_UNITS[idx] : null;
}

/**
 * Read whichever shape systemd gave us for a next-elapse timestamp.
 *
 * Three are possible across versions and flags: `@1786224744` (unix seconds,
 * what we ask for), a bare microsecond count, and a rendered date string. The
 * first two are unambiguous; the string is tried last and only trusted if it
 * lands in a sane range, since a mis-parse would print a confidently wrong
 * restart time.
 *
 * @returns {Date|null}
 */
function parseElapse(raw) {
  const text = String(raw || '').trim();
  if (!text || text === '0' || text === 'n/a') return null;

  const unix = /^@(\d+)$/.exec(text);
  if (unix) return new Date(Number(unix[1]) * 1000);

  if (/^\d+$/.test(text)) {
    // Bare microseconds since the epoch.
    const ms = Number(text) / 1000;
    return ms > 0 ? new Date(ms) : null;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  // Guard against a plausible-looking but wrong parse: a scheduled restart is
  // always in the future and never more than a day or so out.
  const ahead = parsed - Date.now();
  return ahead > -60000 && ahead < 48 * 3600 * 1000 ? parsed : null;
}

/**
 * A restart scheduled for later, or null.
 * @returns {Promise<{at: Date|null}|null>}
 */
async function pendingRestart() {
  let state;
  try {
    state = await run('systemctl', ['is-active', `${UNIT}.timer`]);
  } catch (err) {
    state = String(err.message || '').trim();
  }
  if (state.trim() !== 'active') return null;

  let at = null;
  try {
    // --timestamp=unix asks for `@1786224744`. Without it, systemd 259 renders
    // this property as "Sat 2026-08-08 16:32:24 CDT" — a zone-abbreviated
    // string JS parses inconsistently — so the raw epoch is worth asking for.
    const out = await run('systemctl', [
      'show', '--timestamp=unix', `${UNIT}.timer`, '-p', 'NextElapseUSecRealtime', '--value',
    ]);
    at = parseElapse(out);
  } catch {
    // The timer is active but its next elapse is unreadable; the caller can
    // still say a restart is scheduled, just not exactly when.
  }
  return { at };
}

/** Cancel a scheduled restart. Returns false when there was nothing to cancel. */
async function cancelRestart() {
  if (!(await pendingRestart())) return false;

  // Stopping the timer is what cancels it. The service is stopped separately
  // and its failure ignored on purpose: until the timer fires, the service has
  // never been loaded, and `systemctl stop` on an unloaded unit exits non-zero
  // even though the cancel succeeded.
  await run('sudo', ['systemctl', 'stop', `${UNIT}.timer`]);
  await run('sudo', ['systemctl', 'stop', `${UNIT}.service`]).catch(() => {});
  return true;
}

/**
 * Format a Date the way systemd's OnCalendar wants it.
 *
 * Local time, matching the host clock the nightly timer already runs on. The
 * bot and the timer share a machine, so Node's local zone is that clock.
 */
function calendarString(date) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

/**
 * Launch or schedule a restart.
 *
 * Short notice runs the script now and lets it count down. Longer notice is
 * handed to a systemd timer that starts the script WARN_LEAD minutes before the
 * restart, so the restart lock is held for ten minutes rather than for hours —
 * see WARN_LEAD. Either way players get an in-game countdown; the difference is
 * only whether the waiting happens inside the lock or outside it.
 *
 * @param {string} guildId
 * @param {number} minutes until the restart, 0 for as soon as possible
 * @param {string} [reason] shown to players in-game
 * @returns {Promise<{minutes: number, reason: string, scheduled: boolean, at: Date, warnMinutes: number}>}
 * @throws when a restart is already running or already scheduled
 */
async function startRestart(guildId, minutes, reason) {
  const busy = await activeRestart();
  if (busy) {
    const err = new Error(`A restart is already running (\`${busy}\`).`);
    err.alreadyRunning = true;
    throw err;
  }
  const pending = await pendingRestart();
  if (pending) {
    const when = pending.at ? `for ${pending.at.toLocaleTimeString()}` : 'already';
    const err = new Error(`A restart is already scheduled ${when}. Cancel it first.`);
    err.alreadyRunning = true;
    throw err;
  }

  const script = getGuildConfig(guildId)?.zomboid?.restartScript || SCRIPT;
  const clean = sanitizeReason(reason);
  const at = new Date(Date.now() + minutes * 60000);

  const scheduled = minutes > WARN_LEAD;
  const warnMinutes = scheduled ? WARN_LEAD : minutes;
  const delay = scheduled ? minutes - WARN_LEAD : 0;

  const args = [
    'systemd-run',
    `--unit=${UNIT}`,
    // Reap the unit once it finishes, so the fixed name is free next time
    // instead of lingering as a failed unit nobody thought to reset.
    '--collect',
    '--property=Type=oneshot',
    // The countdown plus the restart itself: save, backup, stop, boot, mod
    // validate. The nightly unit allows 30 minutes for that tail.
    `--property=TimeoutStartSec=${warnMinutes * 60 + 2400}`,
    `--setenv=WARN_MINUTES=${warnMinutes}`,
  ];
  // --on-calendar rather than --on-active: a monotonic timer leaves
  // NextElapseUSecRealtime empty, so the scheduled time would be unreadable
  // afterwards and /pz restart-status could only say "sometime".
  if (scheduled) {
    args.push(`--on-calendar=${calendarString(new Date(Date.now() + delay * 60000))}`);
  }
  if (clean) args.push(`--setenv=RESTART_REASON=${clean}`);
  args.push(script);

  await run('sudo', args);
  return { minutes, reason: clean, scheduled, at, warnMinutes };
}

module.exports = {
  parseWhen,
  sanitizeReason,
  activeRestart,
  pendingRestart,
  cancelRestart,
  startRestart,
  UNIT,
  RESTART_UNITS,
  MAX_MINUTES,
  WARN_LEAD,
};
