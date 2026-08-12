'use strict';
/**
 * Who in Discord is who in Project Zomboid.
 *
 * Everything else in the Zomboid integration identifies people the way the logs
 * do — by account username, sometimes by Steam ID. Nothing has ever known which
 * *Discord* account is behind them, which is fine for a chronicle but not for a
 * character sheet: a sheet nobody owns is a sheet anyone can claim.
 *
 * The link is proved in-game rather than typed. A player asks for a code here,
 * says it in General chat, and `linkWatch` sees it in `chat.txt` attributed to
 * their account name. Possession of the account is the proof, so no staff member
 * has to vouch for anyone.
 *
 * Links are stored against the **Steam ID**, never the username. Usernames are
 * reused across worlds and can be changed; the Steam ID is the one identifier
 * `networkPlayers` and the PerkLog agree on.
 *
 * This module is the persistence layer for the whole feature — links, pending
 * codes and the sheets themselves — because they share one lifecycle: a death
 * retires a sheet but keeps the link, an unlink drops both.
 */
const { getGuildState, setGuildState } = require('../../storage/state');

const STATE_KEY = 'zomboidCharacters';

/**
 * How long a verification code is good for.
 *
 * An hour rather than a few minutes, because the code is asked for in Discord
 * and spent in the game. People read Discord when they are not at the machine
 * they play on — a code that dies before they next sit down just makes them
 * start over.
 */
const CODE_TTL_MS = 60 * 60 * 1000;

/**
 * No I, O, 0 or 1 — the code gets read off Discord and retyped into a game
 * chat box, and those four are the pairs people get wrong.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function emptyStore() {
  return { links: {}, pending: {}, sheets: {}, retired: [] };
}

/** The feature's whole slice of guild state, shape guaranteed. */
function readStore(guildId) {
  const raw = getGuildState(guildId)[STATE_KEY] || {};
  return {
    links: raw.links || {},
    pending: raw.pending || {},
    sheets: raw.sheets || {},
    retired: Array.isArray(raw.retired) ? raw.retired : [],
  };
}

function writeStore(guildId, store) {
  setGuildState(guildId, { [STATE_KEY]: store });
  return store;
}

/** Read-modify-write in one pass, so callers don't each repeat it. */
function update(guildId, mutate) {
  const store = readStore(guildId);
  const result = mutate(store);
  writeStore(guildId, store);
  return result === undefined ? store : result;
}

// --- links ---------------------------------------------------------------

/** @returns {{steamid: string, username: string, linkedAt: string}|null} */
function getLink(guildId, discordId) {
  return readStore(guildId).links[discordId] || null;
}

/**
 * The Discord user who owns an account, if any.
 * @returns {{discordId: string, steamid: string, username: string}|null}
 */
function getLinkBySteamId(guildId, steamid) {
  const links = readStore(guildId).links;
  for (const [discordId, link] of Object.entries(links)) {
    if (link.steamid === String(steamid)) return { discordId, ...link };
  }
  return null;
}

function removeLink(guildId, discordId) {
  return update(guildId, (store) => {
    const had = !!store.links[discordId];
    delete store.links[discordId];
    delete store.pending[discordId];
    return had;
  });
}

// --- verification --------------------------------------------------------

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Issue a code for a Discord user to say in-game.
 *
 * One pending code per user: asking again replaces the old one rather than
 * leaving two live codes that both resolve to the same person.
 *
 * @returns {{code: string, expiresAt: number}}
 */
function startVerification(guildId, discordId) {
  const entry = { code: randomCode(), createdAt: Date.now(), expiresAt: Date.now() + CODE_TTL_MS };
  update(guildId, (store) => {
    prune(store);
    store.pending[discordId] = entry;
  });
  return entry;
}

/** Drop expired codes. Mutates in place; callers are already writing. */
function prune(store) {
  const now = Date.now();
  for (const [discordId, entry] of Object.entries(store.pending)) {
    if (!entry?.expiresAt || entry.expiresAt < now) delete store.pending[discordId];
  }
}

/** Live codes, newest first. Used by the chat watcher. */
function pendingVerifications(guildId) {
  const store = readStore(guildId);
  const now = Date.now();
  return Object.entries(store.pending)
    .filter(([, e]) => e?.expiresAt > now)
    .map(([discordId, e]) => ({ discordId, ...e }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function cancelVerification(guildId, discordId) {
  return update(guildId, (store) => {
    const had = !!store.pending[discordId];
    delete store.pending[discordId];
    return had;
  });
}

/**
 * Bind a Discord user to a PZ account, consuming their pending code.
 *
 * Refuses when the account already belongs to someone else — the first person
 * to prove they hold it keeps it, so a second player who somehow sees the code
 * cannot take an established character over. Staff can free it with `/character
 * unlink`.
 *
 * @returns {{ok: true}|{ok: false, reason: string, heldBy?: string}}
 */
function completeVerification(guildId, discordId, { steamid, username }) {
  const existing = getLinkBySteamId(guildId, steamid);
  if (existing && existing.discordId !== discordId) {
    return { ok: false, reason: 'claimed', heldBy: existing.discordId };
  }

  update(guildId, (store) => {
    store.links[discordId] = {
      steamid: String(steamid),
      username: username || null,
      linkedAt: new Date().toISOString(),
    };
    delete store.pending[discordId];
    prune(store);
  });
  return { ok: true };
}

// --- sheets --------------------------------------------------------------

/**
 * The current sheet for an account.
 *
 * Filed under Steam ID rather than Discord ID: the sheet describes a character,
 * and a character belongs to the game account. When a character dies the sheet
 * is retired and this returns null again, which is what lets the player write a
 * fresh one for their next life.
 */
function getSheet(guildId, steamid) {
  return readStore(guildId).sheets[String(steamid)] || null;
}

function getSheetByDiscordId(guildId, discordId) {
  const link = getLink(guildId, discordId);
  if (!link) return null;
  const sheet = getSheet(guildId, link.steamid);
  return sheet ? { ...sheet, steamid: link.steamid } : null;
}

/** Every live sheet, as `{steamid, ...sheet}`. */
function allSheets(guildId) {
  return Object.entries(readStore(guildId).sheets).map(([steamid, sheet]) => ({ steamid, ...sheet }));
}

function saveSheet(guildId, steamid, patch) {
  return update(guildId, (store) => {
    const key = String(steamid);
    const now = new Date().toISOString();
    const prev = store.sheets[key];
    store.sheets[key] = {
      ...(prev || { createdAt: now }),
      ...patch,
      updatedAt: now,
    };
    return store.sheets[key];
  });
}

/**
 * Move a sheet to the retired list.
 *
 * The thread is kept — a dead character's sheet is the server's history, and
 * deleting it would take the eulogy's context with it. Only the *live* entry
 * goes, freeing the Steam ID for the player's next character.
 */
function retireSheet(guildId, steamid, { diedAt, eulogyUrl } = {}) {
  return update(guildId, (store) => {
    const key = String(steamid);
    const sheet = store.sheets[key];
    if (!sheet) return null;
    delete store.sheets[key];
    store.retired.unshift({
      steamid: key,
      threadId: sheet.threadId,
      name: sheet.name,
      discordId: sheet.discordId,
      diedAt: diedAt ? new Date(diedAt).toISOString() : new Date().toISOString(),
      eulogyUrl: eulogyUrl || null,
    });
    // Unbounded growth would eventually make state.json unpleasant to read;
    // this list is only ever used for "their previous characters".
    store.retired = store.retired.slice(0, 500);
    return sheet;
  });
}

/** A player's retired characters, newest first. */
function retiredSheets(guildId, { steamid, discordId } = {}) {
  return readStore(guildId).retired.filter(
    (r) =>
      (!steamid || r.steamid === String(steamid)) &&
      (!discordId || r.discordId === discordId),
  );
}

module.exports = {
  CODE_TTL_MS,
  readStore,
  emptyStore,
  getLink,
  getLinkBySteamId,
  removeLink,
  startVerification,
  pendingVerifications,
  cancelVerification,
  completeVerification,
  getSheet,
  getSheetByDiscordId,
  allSheets,
  saveSheet,
  retireSheet,
  retiredSheets,
};
