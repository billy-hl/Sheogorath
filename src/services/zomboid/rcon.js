'use strict';
/**
 * RCON access to the Project Zomboid dedicated server.
 *
 * This shells out to `/usr/local/bin/pzrcon.py` instead of speaking Source RCON
 * from Node, because that script is already the RCON path for the watchdog, the
 * load sampler and the nightly restart — one client, one place to fix.
 *
 * It also solves the password problem for us. pzrcon.py reads `RCONPassword`
 * out of the server ini, which is the only copy guaranteed to match what the
 * running server is currently using: a rotated password staged in the game
 * server's .env does not take effect until the container restarts. So the bot
 * never needs the secret in its own environment, and it never lands in `ps`
 * output either — `execFile` with an argv array means no shell is involved.
 *
 * (`zomboid.rcon.passwordEnv` in config/guilds.json points at
 * ZOMBOID_RCON_PASSWORD, which is empty in the bot's .env by design. Nothing
 * here reads it; the host and port in that block are likewise informational —
 * pzrcon.py carries its own.)
 */
const { execFile } = require('child_process');
const { getGuildConfig } = require('../../config/guilds');

const DEFAULT_CLIENT = '/usr/local/bin/pzrcon.py';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * PZ's console splits on quotes, so a stray `"` in a message body would
 * truncate the command or swallow the rest of the line. Newlines end the
 * command outright. Neither is worth failing over — mod titles are the main
 * source and they contain both — so they are flattened rather than rejected.
 */
function sanitizeArg(text) {
  return String(text).replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
}

/** Path to the RCON helper for a guild's server. */
function clientPath(guildId) {
  return getGuildConfig(guildId)?.zomboid?.rcon?.client || DEFAULT_CLIENT;
}

/**
 * Run one RCON command.
 *
 * @param {string} guildId
 * @param {string} command full command line, e.g. `servermsg "hello"`
 * @returns {Promise<string>} the server's reply, empty string when it said nothing
 * @throws when the helper exits non-zero — the server being down is the usual
 *   cause, and callers decide whether that is fatal.
 */
function rcon(guildId, command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [clientPath(guildId), command],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || '').trim() || err.message;
          reject(new Error(`RCON "${command.split(' ')[0]}" failed: ${detail}`));
          return;
        }
        resolve((stdout || '').trim());
      }
    );
  });
}

/** Broadcast a line to everyone in-game. Text is sanitized for you. */
function serverMessage(guildId, text, opts) {
  return rcon(guildId, `servermsg "${sanitizeArg(text)}"`, opts);
}

/**
 * Who is connected right now.
 *
 * `players` replies with a `Players connected (N):` header followed by one
 * `-name` line each. The header count is authoritative, but it is parsed
 * defensively — a build that changes the wording should degrade to counting
 * lines rather than throwing.
 *
 * @returns {Promise<{count:number, names:string[]}>}
 */
async function players(guildId, opts) {
  const out = await rcon(guildId, 'players', opts);
  const names = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);

  const header = /\((\d+)\)/.exec(out);
  return { count: header ? Number(header[1]) : names.length, names };
}

/**
 * Whether the server is answering RCON at all.
 *
 * Used as a liveness probe around restarts, so it swallows the error rather
 * than making every caller write the same try/catch.
 */
async function isReachable(guildId, opts) {
  try {
    await rcon(guildId, 'players', { timeoutMs: 10000, ...opts });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  rcon,
  serverMessage,
  players,
  isReachable,
  sanitizeArg,
  DEFAULT_CLIENT,
};
