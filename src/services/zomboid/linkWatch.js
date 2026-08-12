'use strict';
/**
 * Completes `/character link` by watching the game's own chat log.
 *
 * A player asks for a code in Discord and types it in-game. This poller reads
 * `chat.txt`, finds the code, and takes the line's author as proof of who they
 * are: only someone logged into that account can put words in its mouth. No
 * staff member has to vouch for anyone, and nothing is trusted that a player
 * merely typed into Discord.
 *
 * The chat log identifies the speaker by **account username**. That gets turned
 * into a Steam ID through `players.db`, because the Steam ID is what the sheet
 * is filed under and the only identifier that survives a rename.
 *
 * Chat lines are read, matched against a code, and discarded. Nothing from them
 * is stored or posted — `chat.txt` includes `Private`, which is player DMs.
 */
const { getGuildConfig, guildIds, hasFeature } = require('../../config/guilds');
const { linesSince, CHAT } = require('./logs');
const { lookupPlayer } = require('./players');
const identity = require('./identity');

const DEFAULTS = {
  // Someone is standing at their keyboard waiting for this, so it runs much
  // hotter than the chronicle or the eulogy watch.
  pollSeconds: 30,
};

/** Resolve watcher config for a guild, or null when it can't run. */
function linkWatchConfig(guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  // Without players.db a username cannot become a Steam ID, and a link keyed on
  // a username would break the first time anyone renamed.
  if (!zomboid?.logDir || !zomboid?.playersDb) return null;
  return {
    logDir: zomboid.logDir,
    playersDb: zomboid.playersDb,
    ...DEFAULTS,
    ...(zomboid.linkWatch || {}),
  };
}

/** Codes are matched case-insensitively and ignoring surrounding punctuation. */
function saidCode(text, code) {
  return new RegExp(`(?:^|[^A-Z0-9])${code}(?:[^A-Z0-9]|$)`, 'i').test(text);
}

const watermark = new Map();

/**
 * One pass for a guild.
 *
 * @returns {Promise<Array<{discordId: string, steamid: string, username: string}>>}
 *          the links completed this pass
 */
async function checkOnce(client, guildId, now = Date.now()) {
  const cfg = linkWatchConfig(guildId);
  if (!cfg) return [];

  const pending = identity.pendingVerifications(guildId);
  if (!pending.length) return [];

  // Enough overlap to survive a missed tick. Bounded by the oldest live code so
  // a long-idle bot doesn't re-read hours of chat looking for codes that have
  // already expired.
  const overlap = now - cfg.pollSeconds * 1000 * 3;
  const oldestCode = Math.min(...pending.map((p) => p.createdAt));
  const since = Math.max(Math.min(overlap, oldestCode), now - identity.CODE_TTL_MS);
  const floor = watermark.get(guildId) ?? now;
  let highest = floor;

  const completed = [];

  for (const { at, line } of linesSince(cfg.logDir, 'chat', since)) {
    // A second of slack under the watermark. Log stamps have one-second
    // granularity, so a code typed in the same second as a line already
    // processed would otherwise fall behind the mark and never be seen. Reading
    // a line twice costs nothing here — a code is deleted from `pending` the
    // moment it is used, so the second read matches nothing.
    if (at < floor - 1000) continue;
    if (at > highest) highest = at;

    const m = CHAT.exec(line);
    if (!m) continue;
    const author = m[2];
    const text = m[3];
    if (!author || !text) continue;

    const match = pending.find((p) => saidCode(text, p.code));
    if (!match) continue;

    // Whoever said it has to exist in the save. A player who has connected but
    // never spawned a character has no `networkPlayers` row and so no Steam ID
    // to file against — they're told to spawn in and try again.
    const player = lookupPlayer(cfg.playersDb, { username: author });
    if (!player?.steamid) {
      console.warn(`[Zomboid] Link code said by "${author}", who has no players.db row yet.`);
      await notify(
        client,
        match.discordId,
        `I saw your code in chat from **${author}**, but that account has no character in the save yet. ` +
        'Spawn in, then say the code again — the code is still good.',
      );
      continue;
    }

    const result = identity.completeVerification(guildId, match.discordId, {
      steamid: player.steamid,
      username: player.username || author,
    });

    if (!result.ok) {
      await notify(
        client,
        match.discordId,
        `That account (**${author}**) is already linked to another Discord user. ` +
        'If it should be yours, ask staff to unlink it first.',
      );
      // Consume the code anyway — retrying will not change the answer.
      identity.cancelVerification(guildId, match.discordId);
      continue;
    }

    // Named explicitly, and with the escape hatch spelled out. The code is only
    // ever shown to the person who asked for it, but if one were ever repeated
    // to someone else, this message is how they'd notice.
    await notify(
      client,
      match.discordId,
      `✅ Linked to **${author}**${player.name ? ` — playing **${player.name}**` : ''}.\n` +
      'Run `/character sheet` to write their story. If that account isn\'t yours, ' +
      'run `/character unlink` and tell staff.',
    );

    completed.push({ discordId: match.discordId, steamid: player.steamid, username: author });
    console.log(`[Zomboid] Linked Discord ${match.discordId} to ${author} (${player.steamid}).`);

    // Drop it from this pass's candidates so a second line with the same code
    // isn't processed again before the watermark moves.
    pending.splice(pending.indexOf(match), 1);
    if (!pending.length) break;
  }

  watermark.set(guildId, Math.max(floor, highest + 1));
  return completed;
}

/** Best-effort DM. A closed DM is not a failure — the command works regardless. */
async function notify(client, discordId, content) {
  try {
    const user = await client.users.fetch(discordId);
    await user.send(content);
  } catch (err) {
    console.warn(`[Zomboid] Could not DM ${discordId}:`, err?.message || err);
  }
}

/** Start polling for every guild with a Zomboid server configured. */
function scheduleLinkWatch(client) {
  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'zomboid')) continue;
    const cfg = linkWatchConfig(guildId);
    if (!cfg) continue;

    // Only ever look forward: a code said before the bot started belongs to a
    // session nobody is waiting on any more.
    watermark.set(guildId, Date.now());

    setInterval(() => {
      checkOnce(client, guildId).catch((err) =>
        console.error('[Zomboid] Link watch failed:', err?.message || err));
    }, cfg.pollSeconds * 1000);

    console.log(`[Zomboid] Character link watch armed for ${guildId} every ${cfg.pollSeconds}s.`);
  }
}

module.exports = { linkWatchConfig, saidCode, checkOnce, scheduleLinkWatch, DEFAULTS };
