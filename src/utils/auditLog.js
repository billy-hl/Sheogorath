'use strict';
/**
 * Audit trail for slash commands.
 *
 * `trackCommand` in commands/stats.js counts invocations in memory, which is
 * fine for "what's popular" and useless for "who teleported that player at 2am":
 * it has no actor, no arguments, and it dies with the process. This is the other
 * half — an append-only record of every invocation, kept on disk.
 *
 * Two sinks, deliberately different in what they carry:
 *
 *   logs/commands.jsonl — everything, one JSON object per line. JSONL because
 *     the file is grep-able as text but still parses per-line, so a truncated
 *     final write (power loss mid-append) costs one record instead of the file.
 *
 *   a Discord channel — privileged commands only. The point of mirroring is that
 *     Owners can see what Sheriffs did without shelling into the box, and
 *     that stops being true if the channel is buried under `/play` spam.
 *
 * Failures to log are swallowed. An unwritable disk should not take down the
 * command the user actually asked for.
 */
const fs = require('fs');
const path = require('path');
const { channelId } = require('../config/guilds');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'commands.jsonl');
const MAX_BYTES = 10 * 1024 * 1024; // rotate at 10MB
const KEEP_ROTATIONS = 5;

/** Options whose values shouldn't land in a log file in plaintext. */
const REDACT = /pass(word)?|token|secret|key$/i;

let client = null;

/** Give the logger a Discord client so it can mirror to a channel. */
function setClient(c) {
  client = c;
}

/**
 * Roll commands.jsonl over once it gets large, keeping a few generations.
 * Same shape as the winston file transports so the logs directory stays
 * predictable to anyone poking at it.
 */
function rotateIfNeeded() {
  let size;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    return; // No file yet.
  }
  if (size < MAX_BYTES) return;

  try {
    fs.rmSync(`${LOG_FILE}.${KEEP_ROTATIONS}`, { force: true });
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i + 1}`);
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (err) {
    console.warn('[Audit] Could not rotate command log:', err.message);
  }
}

/**
 * Flatten the invoked options into something readable.
 *
 * Subcommands nest their options one level down, which is where every argument
 * to `/pz` lives — reading the top level only would log every admin action as
 * having no arguments at all.
 */
function extractOptions(interaction) {
  const out = {};
  const walk = (opts) => {
    for (const opt of opts || []) {
      if (Array.isArray(opt.options) && opt.options.length) {
        walk(opt.options);
      } else if (opt.value !== undefined && opt.value !== null) {
        out[opt.name] = REDACT.test(opt.name) ? '[redacted]' : opt.value;
      }
    }
  };
  walk(interaction.options?.data);
  return out;
}

/** `/pz giveitem player:Renny item:Base.Axe` */
function formatInvocation(record) {
  const parts = [`/${record.command}`];
  if (record.subcommand) parts.push(record.subcommand);
  for (const [k, v] of Object.entries(record.options)) parts.push(`${k}:${v}`);
  return parts.join(' ');
}

function writeLine(record) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.warn('[Audit] Could not write command log:', err.message);
  }
}

async function mirrorToDiscord(record) {
  const target = channelId(record.guildId, 'commandLog');
  if (!target || !client) return;

  try {
    const channel = await client.channels.fetch(target);
    if (!channel?.isTextBased()) return;

    const icon = record.status === 'denied' ? '⛔' : record.status === 'error' ? '⚠️' : '🛡️';
    const detail = record.detail ? ` — ${record.detail}` : '';
    await channel.send({
      content: `${icon} \`${formatInvocation(record)}\` by <@${record.userId}> (${record.userTag})${detail}`,
      allowedMentions: { parse: [] }, // The actor is a link, not a ping.
    });
  } catch (err) {
    console.warn('[Audit] Could not mirror to log channel:', err.message);
  }
}

/**
 * Record one command invocation.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} [opts]
 * @param {'ok'|'denied'|'error'} [opts.status] outcome, default 'ok'
 * @param {string} [opts.detail] extra context — the denial reason, the error
 * @param {boolean} [opts.privileged] also mirror to the Discord log channel
 */
function logCommand(interaction, { status = 'ok', detail = null, privileged = false } = {}) {
  const record = {
    at: new Date().toISOString(),
    guildId: interaction.guildId,
    guildName: interaction.guild?.name || null,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    command: interaction.commandName,
    subcommand: interaction.options?.getSubcommand?.(false) || null,
    options: extractOptions(interaction),
    status,
    detail,
  };

  writeLine(record);
  if (privileged) {
    // Fire-and-forget: the audit mirror must never delay the reply.
    mirrorToDiscord(record).catch(() => {});
  }
  return record;
}

module.exports = { logCommand, setClient, LOG_FILE };
