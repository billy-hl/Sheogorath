'use strict';
/**
 * What Sheogorath may do on his own, and what he has to ask permission for.
 *
 * The model decides *what* it wants to do; this file decides whether that is
 * allowed. Keeping the two apart matters more here than in most places, because
 * the input to the model is chat written by the people it can act against — a
 * player who can phrase a sentence can otherwise phrase an instruction. Nothing
 * in this file consults the model's reasoning; it looks only at who asked, who
 * is being acted on, and how much has already happened this hour.
 *
 * Four verdicts come out of `decide()`:
 *
 *   execute — do it now, and record it
 *   propose — post an Approve/Deny card for a Sheriff, do nothing until clicked
 *   shadow  — record what would have happened, do nothing (see MODES)
 *   deny    — refuse, and record the refusal
 *
 * The rule that does most of the work is the targeting rule. An action aimed at
 * someone other than the person Sheogorath is replying to is *never* executed on
 * the say-so of an ordinary member — it degrades to a proposal a Sheriff has to
 * click. So the worst a member can talk him into is a card in the staff channel,
 * and the only person they can get acted on directly is themselves.
 */
const { isStaff, isAdmin } = require('../utils/permissions');

/**
 * Per-guild autonomy, set as `ai.mode` in config/guilds.json.
 *
 *   shadow  — nothing is ever executed. Every decision is logged as what it
 *             *would* have been. This is the default for a guild that hasn't
 *             said otherwise: a new deployment should not be able to punish
 *             anyone before someone has read a week of its judgement.
 *   assist  — anything that would execute becomes a proposal instead. Nothing
 *             happens without a human click.
 *   enforce — the auto tier executes; the propose tier still asks.
 */
const MODES = ['shadow', 'assist', 'enforce'];
const DEFAULT_MODE = 'shadow';

/**
 * Targeting rules.
 *
 *   author — may only be aimed at the author of the triggering message, unless
 *            a Sheriff asked. Aimed anywhere else it degrades to a proposal.
 *   member — aimed at any member, subject to immunity. Every capability using
 *            this is already `propose`, so "aim it at anyone" always means
 *            "ask a Sheriff about anyone".
 *   none   — not aimed at a person at all.
 */

/**
 * The capability table. Adding a power to Sheogorath means adding a row here;
 * there is deliberately no way to reach an executor that has no row.
 *
 * `perHour` is a rolling per-guild cap on *executions* — proposals are not
 * rationed, because a proposal costs a Sheriff one glance and nothing else.
 */
const CAPABILITIES = {
  // --- Record-keeping. Nobody is punished by a note, so these run freely. ---
  note:       { tier: 'auto',    targets: 'member', immune: false, perHour: 30 },
  memory:     { tier: 'auto',    targets: 'member', immune: false, perHour: 30 },
  clearnotes: { tier: 'auto',    targets: 'member', immune: false, perHour: 10 },

  // Tells staff someone tried to manipulate him. Punishes nobody, so it runs
  // freely and is not subject to immunity — a Sheriff testing him should show up
  // in the log like anyone else. Rationed loosely: one person probing will
  // usually try several framings in a row, and staff want the whole run.
  flag:       { tier: 'auto',    targets: 'member', immune: false, perHour: 25 },

  // An early chronicle, when someone asks before the nightly one is due. Costs
  // a large generation each time, so it is rationed by the day rather than the
  // hour — and deliberately not gated on staff, because a player asking for a
  // story is the entire point of it.
  storytime:  { tier: 'auto',    targets: 'none',   immune: false, perHour: 1, perDay: 3 },

  // --- Corrective, bounded, and undoable within a few minutes. ---
  delete:     { tier: 'auto',    targets: 'author', immune: true,  perHour: 15 },
  warn:       { tier: 'auto',    targets: 'author', immune: true,  perHour: 10 },

  // A timeout is the one auto-tier action that takes something away for a
  // measurable stretch, so it carries a second threshold: up to ten minutes is
  // his to give, anything longer is a proposal. Ten minutes is short enough to
  // be a cooling-off period rather than a punishment, and it matches the ceiling
  // the action layer already enforced before this gate existed.
  timeout:    { tier: 'auto',    targets: 'author', immune: true,  perHour: 5,
                autoMaxMinutes: 10, hardMaxMinutes: 7 * 24 * 60 },

  // --- Everything below always asks, whoever is asking. ---
  kick:       { tier: 'propose', targets: 'member', immune: true,  perHour: 5 },
  ban:        { tier: 'propose', targets: 'member', immune: true,  perHour: 3,
                maxDeleteDays: 7 },

  // A raw server command, shown verbatim on the approval card.
  //
  // `ownerTier` is the exception an Owner asking in chat earns: they are the
  // person the approval card would have been escalated to, so making them click
  // their own request is ceremony. It stops at Owners rather than extending to
  // Sheriffs on purpose — permissions.js already holds `/pz access`, `/pz raid`
  // and `/pz siege` above the Sheriff tier because they hand out power or
  // spawn things that cannot be removed, and letting a Sheriff reach the same
  // commands by asking Sheogorath nicely would route straight around that.
  // A Sheriff's request still becomes a card; any Sheriff can approve it.
  pzcommand:  { tier: 'propose', ownerTier: 'auto', targets: 'none', immune: false, perHour: 10 },

  // Restarting is not an RCON command — PZ has none — so it cannot ride on
  // `pzcommand`. It runs through the same systemd path `/pz restart` uses,
  // warnings to players and all.
  pzrestart:  { tier: 'propose', ownerTier: 'auto', targets: 'none', immune: false, perHour: 3,
                defaultMinutes: 5, maxMinutes: 180 },
};

/**
 * Guild-wide brake. If Sheogorath executes more than this many actions in an
 * hour, something has gone wrong — a prompt that has talked him into a loop, a
 * raid he is over-reacting to, a bad model day. He drops to proposals only and
 * staff are told once.
 */
const BREAKER_LIMIT = 20;
const BREAKER_WINDOW_MS = 60 * 60 * 1000;
const BREAKER_COOLDOWN_MS = 60 * 60 * 1000;
/**
 * How long execution records are kept. Longer than the breaker's window
 * because some capabilities are rationed per day rather than per hour — an
 * on-demand chronicle costs real money and would be tiresome hourly, so
 * "three a day" has to be expressible.
 */
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** guildId -> timestamps of executed actions, newest last. */
const executions = new Map();
/** guildId -> epoch ms until which the breaker stays tripped. */
const tripped = new Map();

/**
 * Executions inside a window. Prunes to the longest window anyone asks about,
 * so the per-day counters still have their history when the per-hour ones have
 * moved on.
 */
function recentExecutions(guildId, capability = null, windowMs = BREAKER_WINDOW_MS) {
  const kept = (executions.get(guildId) || []).filter((e) => e.at >= Date.now() - HISTORY_WINDOW_MS);
  executions.set(guildId, kept);

  const cutoff = Date.now() - windowMs;
  const inWindow = kept.filter((e) => e.at >= cutoff);
  return capability ? inWindow.filter((e) => e.capability === capability) : inWindow;
}

/**
 * Record that an action actually ran. Called by the dispatcher after a
 * successful execution — not at decision time, so a failed Discord call doesn't
 * eat somebody's hourly budget.
 */
function recordExecution(guildId, capability) {
  const list = recentExecutions(guildId);
  list.push({ at: Date.now(), capability });
  executions.set(guildId, list);

  if (list.length > BREAKER_LIMIT && !isBreakerTripped(guildId)) {
    tripped.set(guildId, Date.now() + BREAKER_COOLDOWN_MS);
    return { justTripped: true, count: list.length };
  }
  return { justTripped: false, count: list.length };
}

function isBreakerTripped(guildId) {
  const until = tripped.get(guildId);
  if (!until) return false;
  if (Date.now() >= until) {
    tripped.delete(guildId);
    return false;
  }
  return true;
}

/** Let staff clear the brake by hand rather than waiting out the hour. */
function resetBreaker(guildId) {
  tripped.delete(guildId);
  executions.set(guildId, []);
}

function modeFor(guildConfig) {
  const mode = guildConfig?.ai?.mode;
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

/**
 * Whether a member is off limits to an AI-initiated action.
 *
 * Staff immunity is not about trust in the member — it is about what a
 * successful injection would be worth. The prize for talking Sheogorath into
 * acting is removing the people who could stop him, so that is the one move
 * that is never available at any tier.
 */
function immunityReason(targetMember, botMember) {
  if (!targetMember) return null; // Not resolvable — handled by the caller.
  if (targetMember.user?.bot) return 'the target is a bot';
  if (botMember && targetMember.id === botMember.id) return 'he cannot act on himself';
  if (isAdmin(targetMember)) return 'the target is an Owner';
  if (isStaff(targetMember)) return 'the target is a Sheriff';
  return null;
}

/**
 * Decide what happens to one proposed action.
 *
 * @param {object} action        parsed action, `{ type, userId?, duration?, ... }`
 * @param {object} ctx
 * @param {string} ctx.guildId
 * @param {object} ctx.guildConfig    from config/guilds.js
 * @param {string} ctx.authorId       who wrote the message Sheogorath replied to
 * @param {import('discord.js').GuildMember|null} ctx.requester  same person, as a member
 * @param {import('discord.js').GuildMember|null} ctx.targetMember  resolved target, if any
 * @param {import('discord.js').GuildMember|null} ctx.botMember
 * @returns {{verdict: string, reason: string, capability: object|null, action: object}}
 */
function decide(action, ctx) {
  const cap = CAPABILITIES[action.type];
  const out = (verdict, reason, patched = action) =>
    ({ verdict, reason, capability: cap || null, action: patched });

  // An action with no row in the table is not a power he has. This is the
  // backstop for a model that invents a tag name.
  if (!cap) return out('deny', `"${action.type}" is not a capability`);

  const mode = modeFor(ctx.guildConfig);
  if (mode === 'shadow') return out('shadow', 'guild is in shadow mode');

  // --- Immunity, before anything else that could let it through. ---
  if (cap.immune && action.userId) {
    if (!ctx.targetMember) {
      return out('deny', 'the target is not a member of this server');
    }
    const immune = immunityReason(ctx.targetMember, ctx.botMember);
    if (immune) return out('deny', immune);
  }

  const requesterIsStaff = isStaff(ctx.requester);
  const requesterIsOwner = isAdmin(ctx.requester);

  // A capability may be gentler on an Owner than on everyone else. Computed
  // once here so every branch below agrees on which tier is in force.
  const tier = cap.ownerTier && requesterIsOwner ? cap.ownerTier : cap.tier;

  // --- Targeting: the rule that contains prompt injection. ---
  //
  // Aimed at anyone but the person he is replying to, on the word of an
  // ordinary member, this becomes a card in the staff channel. Members can
  // still *raise* things — that is the point of letting it degrade rather than
  // refusing outright — they just cannot land them.
  if (cap.targets === 'author' && action.userId && action.userId !== ctx.authorId && !requesterIsStaff) {
    return out('propose', 'aimed at someone other than the author, and the requester is not a Sheriff');
  }

  // --- Per-capability thresholds. ---
  let patched = action;
  if (action.type === 'timeout') {
    const requested = Math.max(1, Math.min(action.duration || 5, cap.hardMaxMinutes));
    patched = { ...action, duration: requested };
    if (requested > cap.autoMaxMinutes) {
      return out('propose', `${requested}m is over the ${cap.autoMaxMinutes}m he may give unasked`, patched);
    }
  }
  if (action.type === 'ban') {
    patched = { ...action, deleteDays: Math.min(action.deleteDays || 0, cap.maxDeleteDays) };
  }
  if (action.type === 'pzrestart') {
    const requested = Number(action.minutes);
    patched = {
      ...action,
      minutes: Math.max(0, Math.min(Number.isFinite(requested) ? requested : cap.defaultMinutes, cap.maxMinutes)),
    };
  }

  if (tier === 'propose') {
    return out(
      'propose',
      requesterIsStaff
        ? 'this capability asks an Owner, or any Sheriff, before it runs'
        : 'this capability always asks a Sheriff',
      patched,
    );
  }

  // --- Brakes. Both degrade to a proposal rather than refusing, so a busy
  // hour costs staff a click instead of losing the action entirely. ---
  if (isBreakerTripped(ctx.guildId)) {
    return out('propose', 'the hourly action brake is tripped', patched);
  }
  if (cap.perHour && recentExecutions(ctx.guildId, action.type).length >= cap.perHour) {
    return out('propose', `${action.type} has hit its ${cap.perHour}/hour limit`, patched);
  }
  if (cap.perDay && recentExecutions(ctx.guildId, action.type, HISTORY_WINDOW_MS).length >= cap.perDay) {
    // Refused outright rather than degraded to a proposal: a day's worth of
    // chronicles is a taste question, not a permissions one, and a card asking
    // a Sheriff to approve a fourth would be a worse use of their attention
    // than the word no.
    return out('deny', `${action.type} has already run ${cap.perDay} time(s) today`, patched);
  }

  // `assist` is `enforce` with the auto tier taken away.
  if (mode === 'assist') return out('propose', 'guild is in assist mode', patched);

  return out('execute', 'within his own authority', patched);
}

module.exports = {
  CAPABILITIES,
  MODES,
  DEFAULT_MODE,
  BREAKER_LIMIT,
  HISTORY_WINDOW_MS,
  decide,
  modeFor,
  immunityReason,
  recordExecution,
  isBreakerTripped,
  resetBreaker,
  recentExecutions,
};
