'use strict';
/**
 * One account per person — pruning surplus accounts when their character dies.
 *
 * `MaxAccountsPerUser=1` stops NEW alts being created but is not retroactive, and
 * this server already carries 111 surplus accounts across 79 Steam IDs — one
 * person holds ten. Those are exactly the accounts the rule is aimed at, and the
 * setting does nothing about them.
 *
 * So: when a character dies on an account whose Steam ID owns more than one, that
 * account is removed. Repeated over time it converges on one account per person
 * without a mass deletion, and it falls hardest on whoever is actively cycling
 * alts, which is the behaviour being discouraged.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 *
 * It never removes somebody's last account. The guard is `> 1`, checked at the
 * moment of deletion rather than from a cached list, because the list changes as
 * this runs and a stale count would eventually delete the one account a player
 * has left. Dying on your only account is ordinary play: you reroll, as PZ
 * intends, and nothing here touches you.
 *
 * It never acts on an account with no Steam ID. Two exist, and without a Steam ID
 * there is no way to know whose they are — deleting on a guess is not a mistake
 * that can be undone.
 *
 * IT IS IRREVERSIBLE. Removing a whitelist entry destroys that character. There
 * is no undo, which is why this ships disabled and why `report()` exists: run
 * that first and look at who it would affect before enabling anything.
 */
const { rcon } = require('./rcon');
const { getGuildConfig } = require('../../config/guilds');

/** Accounts grouped by Steam ID, read fresh each call. */
function accountsBySteamId(guildId) {
  const dbPath = getGuildConfig(guildId)?.zomboid?.usersDb;
  if (!dbPath) throw new Error('No Zomboid users database is configured for this guild.');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT username, steamid, lastConnection FROM whitelist').all();
    const bySteam = new Map();
    for (const r of rows) {
      if (!r.steamid) continue;                 // unattributable; never touched
      if (!bySteam.has(r.steamid)) bySteam.set(r.steamid, []);
      bySteam.get(r.steamid).push({ username: r.username, lastConnection: r.lastConnection });
    }
    return bySteam;
  } finally { db.close(); }
}

/**
 * Who would be affected, without changing anything.
 *
 * The thing to look at before enabling this. Deleting an account cannot be
 * undone, so the list of people it would eventually take from is worth reading
 * once with your own eyes.
 */
function report(guildId) {
  const bySteam = accountsBySteamId(guildId);
  const multi = [...bySteam.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([steamid, list]) => ({ steamid, count: list.length, accounts: list }))
    .sort((a, b) => b.count - a.count);
  return {
    steamIds: bySteam.size,
    withAlts: multi.length,
    surplus: multi.reduce((sum, m) => sum + m.count - 1, 0),
    groups: multi,
  };
}

/**
 * Whether this account is a surplus one, i.e. safe to prune.
 *
 * Read live rather than from a snapshot: this runs once per death over days, and
 * a count captured earlier would keep saying "3 accounts" long after two were
 * removed — and then delete the last one.
 */
function isSurplus(guildId, username) {
  const bySteam = accountsBySteamId(guildId);
  for (const [steamid, list] of bySteam) {
    if (!list.some((a) => a.username === username)) continue;
    return { surplus: list.length > 1, steamid, count: list.length, siblings: list.map((a) => a.username) };
  }
  return { surplus: false, steamid: null, count: 0, siblings: [] };
}

/**
 * Prunes the account a character just died on, if it is a surplus one.
 *
 * `dryRun` is the default on purpose. Nothing about this is recoverable, so the
 * caller has to ask for the destructive version explicitly.
 *
 * The username is passed through exactly as the death log wrote it. RCON invents
 * an account for a name it does not recognise rather than erroring, so a
 * near-miss here would create an account rather than remove one — which is why
 * the name is checked against the database first and the call is skipped if it
 * is not found.
 */
async function pruneOnDeath(guildId, username, { dryRun = true } = {}) {
  const info = isSurplus(guildId, username);

  if (!info.steamid) {
    return { acted: false, reason: 'account not found, or has no Steam ID', username };
  }
  if (!info.surplus) {
    return { acted: false, reason: 'only account for this player — left alone', username, count: info.count };
  }
  if (dryRun) {
    return {
      acted: false, reason: 'dry run', username, count: info.count,
      wouldRemove: username, siblings: info.siblings,
    };
  }

  const reply = await rcon(guildId, `removeuserfromwhitelist "${username}"`);
  return {
    acted: true, username, steamid: info.steamid,
    was: info.count, now: info.count - 1, siblings: info.siblings, reply,
  };
}

module.exports = { report, isSurplus, pruneOnDeath, accountsBySteamId };
