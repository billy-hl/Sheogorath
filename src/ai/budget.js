'use strict';
/**
 * What Sheogorath has cost this month, and stopping him when it is enough.
 *
 * The moderation gate next door bounds how many *actions* he takes, which has
 * nothing to do with money: a reply that does nothing at all still costs a full
 * request. This is the other axis, and until it existed there was no ceiling on
 * spend at all — no cooldown on the message path, two API calls per reply, and
 * a help channel that answers everything.
 *
 * The numbers are not estimated. xAI returns `usage.cost_in_usd_ticks` on every
 * response: the amount actually billed, after prompt-caching discounts and
 * including server-side tool costs, in integer ticks at 1 USD = 10^10 ticks.
 * Integers because summing floats over thousands of requests drifts. So there is
 * no pricing table here to go stale — the provider says what it charged and this
 * file adds it up.
 *
 * State is on disk. A monthly ceiling held in memory would reset on every
 * restart, which for a bot that restarts on mod updates is not a ceiling at all.
 */
const fs = require('fs');
const path = require('path');

const TICKS_PER_USD = 10_000_000_000; // 10^10, per xAI's cost-tracking docs
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SPEND_FILE = path.join(DATA_DIR, 'ai-spend.json');

/** Percentages at which staff are told once, before the hard stop at 100. */
const WARN_AT = [50, 80, 95];
const KEEP_MONTHS = 12;

/**
 * The ceiling, in dollars. Lives in .env rather than config/guilds.json because
 * spend is a property of the API key, not of a guild — both servers draw on the
 * same key, so a per-guild budget would be two ceilings on one bill.
 */
function budgetUsd() {
  const raw = Number(process.env.AI_MONTHLY_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

/** Calendar month in UTC, e.g. "2026-08". */
function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function currentDay() {
  return new Date().toISOString().slice(0, 10);
}

function emptyMonth(month) {
  return { month, ticks: 0, calls: 0, days: {}, notified: [] };
}

let state = null;

function read() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8'));
  } catch {
    state = { current: emptyMonth(currentMonth()), history: [] };
  }
  if (!state.current) state.current = emptyMonth(currentMonth());
  if (!Array.isArray(state.history)) state.history = [];
  return rollover();
}

/**
 * Start a new month when the clock says so, keeping the old one.
 *
 * The archive is what makes "is $20 the right number" answerable later — a
 * ceiling with no record of what was actually spent under it is a guess that
 * never gets revised.
 */
function rollover() {
  const month = currentMonth();
  if (state.current.month === month) return state;

  state.history.unshift(state.current);
  state.history = state.history.slice(0, KEEP_MONTHS);
  state.current = emptyMonth(month);
  write();
  console.log(`[Budget] New month ${month}. Previous: $${usd(state.history[0].ticks).toFixed(2)} over ${state.history[0].calls} call(s).`);
  return state;
}

function write() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Temp file plus rename, so a crash mid-write can't leave a truncated
    // ledger that reads as $0 spent and re-opens the taps.
    const tmp = `${SPEND_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, SPEND_FILE);
  } catch (err) {
    console.warn('[Budget] Could not persist spend:', err.message);
  }
}

const usd = (ticks) => ticks / TICKS_PER_USD;

/** Where this month stands. */
function status() {
  const s = read();
  const limit = budgetUsd();
  const spent = usd(s.current.ticks);
  return {
    month: s.current.month,
    spentUsd: spent,
    limitUsd: limit,
    percent: limit > 0 ? (spent / limit) * 100 : 0,
    calls: s.current.calls,
    today: {
      spentUsd: usd(s.current.days[currentDay()]?.ticks || 0),
      calls: s.current.days[currentDay()]?.calls || 0,
    },
    exceeded: spent >= limit,
    history: s.history.map((h) => ({ month: h.month, spentUsd: usd(h.ticks), calls: h.calls })),
  };
}

/**
 * Record what one response actually cost.
 *
 * Called from the single place every xAI request passes through, so a call added
 * later is metered without anyone remembering to meter it.
 */
function record(usage) {
  const ticks = Number(usage?.cost_in_usd_ticks);
  if (!Number.isFinite(ticks) || ticks < 0) return null;

  const s = read();
  const day = currentDay();
  s.current.ticks += ticks;
  s.current.calls += 1;
  s.current.days[day] = s.current.days[day] || { ticks: 0, calls: 0 };
  s.current.days[day].ticks += ticks;
  s.current.days[day].calls += 1;
  write();

  // Which warning thresholds this call just crossed, for the caller to announce.
  const limit = budgetUsd();
  const percent = (usd(s.current.ticks) / limit) * 100;
  const crossed = WARN_AT.filter((t) => percent >= t && !s.current.notified.includes(t));
  if (crossed.length) {
    s.current.notified.push(...crossed);
    write();
  }
  const highest = crossed.length ? Math.max(...crossed) : null;
  if (highest) announce(highest);
  return { ticks, percent, crossed: highest };
}

/**
 * Refuse a call that would go over the ceiling.
 *
 * Thrown rather than returned so it cannot be forgotten at a call site, and
 * tagged with a code so the chat path can answer in character instead of
 * showing an error. The message is written to be readable if it ever does
 * surface raw to a user.
 */
function assertWithinBudget() {
  const s = status();
  if (!s.exceeded) return s;

  const err = new Error(
    `The Mad God has spent his allowance for ${s.month} — $${s.spentUsd.toFixed(2)} of $${s.limitUsd.toFixed(2)}. ` +
    `He returns when the month turns, or when an Owner raises the ceiling.`,
  );
  err.code = 'AI_BUDGET_EXCEEDED';
  err.budget = s;
  throw err;
}

/** Whether an error came from the ceiling rather than from the provider. */
const isBudgetError = (err) => err?.code === 'AI_BUDGET_EXCEEDED';

/**
 * Somewhere to send threshold warnings.
 *
 * A callback rather than a direct import so this file stays free of Discord —
 * it is called from inside the HTTP layer, which has no business knowing what a
 * guild is.
 */
let notifier = null;
function setNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : null;
}

/** Announce a crossed threshold, if anyone is listening. Never throws. */
function announce(percent) {
  if (!notifier) return;
  const s = status();
  Promise.resolve()
    .then(() => notifier(
      `💸 **Sheogorath has spent ${percent}% of this month's allowance** — ` +
      `$${s.spentUsd.toFixed(2)} of $${s.limitUsd.toFixed(2)} for ${s.month}, over ${s.calls} call(s). ` +
      (percent >= 95
        ? 'At 100% he stops answering until the month turns or an Owner raises `AI_MONTHLY_BUDGET_USD`.'
        : 'Nothing has changed yet — this is a heads-up.'),
      s,
    ))
    .catch((err) => console.warn('[Budget] Could not announce threshold:', err?.message || err));
}

/** Drop the cached ledger so the next read re-reads the file. */
function reload() {
  state = null;
  return read();
}

module.exports = {
  status,
  setNotifier,
  record,
  assertWithinBudget,
  isBudgetError,
  budgetUsd,
  reload,
  usd,
  TICKS_PER_USD,
  SPEND_FILE,
  WARN_AT,
};
