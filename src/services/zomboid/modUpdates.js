'use strict';
/**
 * Watches the Workshop for updates to the mods this server actually runs, and
 * applies them by restarting.
 *
 * Mods only load at server boot, so a Workshop update is inert until the
 * container restarts — and while it is inert, connecting players whose own
 * copies auto-updated get a version mismatch. That gap is what this closes.
 *
 * Detection compares two timestamps:
 *
 *   what we have   `timeupdated` in steamapps/workshop/appworkshop_108600.acf,
 *                  which steamcmd writes for each item it has downloaded
 *   what exists    `time_updated` from the Workshop API
 *
 * Using the .acf rather than a timestamp this process remembers matters: it is
 * the version on disk, so the check is correct across bot restarts, self-heals
 * after the server updates, and cannot drift. There is no baseline to seed and
 * nothing to get out of sync.
 *
 * Applying the update means running the nightly-restart script rather than
 * stopping the container here. That script forces a world save, takes a
 * consistent backup, and — most importantly — rolls the mod config back if the
 * server fails to boot on it. Reimplementing any of that would be strictly
 * worse. It runs through `zomboid-modrestart.service`, which is the same
 * script with WARN_MINUTES=3: the nightly's 10/5/1 countdown is right for a
 * scheduled restart nobody is waiting on, but a mod update is already blocking
 * players from joining, so the warning is short on purpose.
 *
 * That script also flushes anything else staged for the next restart — sandbox
 * settings, ini secrets, ticket replies — so triggering it here applies those
 * too. That is the intended behaviour, not a side effect: staged changes are
 * waiting on the next restart, and this is the next restart. It is a further
 * reason to go through the script rather than bouncing the container directly,
 * which would restart the server and leave them still staged.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const { getGuildConfig, guildIds, hasFeature } = require('../../config/guilds');
const { getGuildState, setGuildState } = require('../../storage/state');
const { fetchWorkshopItems, readServerConfig } = require('./modCheck');
const { serverMessage, isReachable } = require('./rcon');

const DEFAULTS = {
  pollMinutes: 3,
  // Zero: act on an update the moment it is seen.
  //
  // This used to hold a fresh update back for a couple of minutes so that an
  // author pushing three fixes a minute apart became one restart rather than
  // three. That trade is the wrong way round. Clients auto-update their own
  // copy, so from the moment the author publishes, every player who restarts
  // Steam is locked out on a version mismatch until the server catches up —
  // the wait was spent entirely on the players it was meant to spare.
  //
  // Burst protection has not gone away, it has moved: minMinutesBetweenRestarts
  // now does that job. A burst becomes at most one restart per cooldown window
  // instead of one settled restart, which costs an extra bounce in the rare
  // multi-push case and saves the outage in every single-push case.
  settleMinutes: 0,
  // Floor between bot-triggered restarts. With settleMinutes at 0 this is the
  // only thing standing between a chatty mod author and a restart loop, so it
  // is load-bearing rather than belt-and-braces. Not a quiet-hours policy — a
  // mismatched server cannot be joined, so deferring a restart does not spare
  // players an interruption, it prolongs one.
  minMinutesBetweenRestarts: 15,
  // If the nightly restart is due within this window, let it do the work.
  // Only worth it when the nightly is genuinely imminent; anything longer
  // leaves players unable to join for the difference.
  deferToNightlyMinutes: 15,
  // Mod-update restarts run through their own unit so they can carry a short
  // warning (see WARN_MINUTES in zomboid-nightly-restart.sh) without changing
  // what the nightly timer does. Same script, same backup and rollback.
  restartService: 'zomboid-modrestart.service',
  // Every one of these runs the same script against the same container, so "is
  // a restart already in progress" has to consider all of them. Checking only
  // our own would let a mod update fire on top of a running nightly, which
  // stops the container mid-backup. zomboid-adminrestart is the transient unit
  // behind /pz restart — named rather than auto-generated precisely so it is
  // visible here.
  conflictingServices: [
    'zomboid-restart.service',
    'zomboid-modrestart.service',
    'zomboid-adminrestart.service',
  ],
  nightlyTimer: 'zomboid-restart.timer',
  // Where the restart script logs what it applied. World-readable, so this
  // needs no privilege of its own.
  restartLog: '/var/log/zomboid-restart.log',
  // Off by default: announcing is safe, restarting a server with people on it
  // is a policy call, so it has to be opted into per guild.
  autoRestart: false,
  // How long to wait for the restart unit to finish before giving up on
  // reporting the outcome. The unit's own TimeoutStartSec is 1800.
  restartTimeoutMinutes: 35,
};

// ---------------------------------------------------------------------------
// What is on disk

/**
 * The steamcmd manifest for PZ's workshop content.
 *
 * `workshopDir` in config points at `steamapps/workshop/content/108600`; the
 * manifest sits two levels up beside `content/`. Derived rather than configured
 * so there is one fewer path to get wrong, but overridable for the case where
 * that layout ever stops holding.
 */
function acfPath(guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  if (zomboid?.workshopAcf) return zomboid.workshopAcf;
  if (!zomboid?.workshopDir) return null;
  return path.join(path.resolve(zomboid.workshopDir, '..', '..'), 'appworkshop_108600.acf');
}

/**
 * Downloaded version of every workshop item, from the steamcmd manifest.
 *
 * The file is Valve's KeyValues text format. Only the `WorkshopItemsInstalled`
 * block is read — the `WorkshopItemDetails` block that follows repeats each id
 * with a `timeupdated` of its own, and matching against both would make the
 * result depend on which one the regex happened to reach last.
 *
 * @returns {Map<string, number>} workshop id -> epoch seconds, empty on any
 *   read failure (a missing manifest must not read as "everything is stale")
 */
function readInstalledVersions(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.warn('[Zomboid] Could not read workshop manifest:', err?.message || err);
    return new Map();
  }

  const installed = text.split('"WorkshopItemDetails"')[0];
  const out = new Map();
  for (const m of installed.matchAll(/"(\d{6,12})"\s*\{([^{}]*)\}/g)) {
    const stamp = /"timeupdated"\s*"(\d+)"/.exec(m[2]);
    if (stamp) out.set(m[1], Number(stamp[1]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison

/**
 * Compare the configured mod list against the Workshop.
 *
 * @param {string[]} configuredIds WorkshopItems from the server ini
 * @param {Map<string, number>} local from `readInstalledVersions`
 * @param {object[]} remote raw Workshop records
 * @returns {{updates: object[], missing: object[], gone: object[]}}
 */
function compareVersions(configuredIds, local, remote) {
  const byId = new Map(remote.map((it) => [String(it.publishedfileid), it]));
  const updates = [];
  const missing = [];
  const gone = [];

  for (const id of configuredIds) {
    const item = byId.get(id);
    // No record at all means the API call did not cover this id, which is a
    // different problem from the item being delisted — say nothing rather than
    // guess.
    if (!item) continue;

    if (item.result !== 1 || item.banned) {
      gone.push({ id, title: item.title || '(unknown)', banned: !!item.banned });
      continue;
    }

    const steamAt = Number(item.time_updated || 0);
    if (!steamAt) continue;

    const localAt = local.get(id);
    if (localAt === undefined) {
      // Configured but never downloaded — normally a mod added to the game
      // server's .env since the last boot. The next restart installs it.
      missing.push({ id, title: item.title || '(untitled)', steamAt });
      continue;
    }

    if (steamAt > localAt) {
      updates.push({ id, title: item.title || '(untitled)', localAt, steamAt });
    }
  }

  return { updates, missing, gone };
}

/**
 * Updates that have stopped changing, and are therefore worth restarting for.
 *
 * A settleMinutes of 0 disables the gate outright rather than cutting off at
 * exactly `now`. Steam's publish timestamp is its clock, not ours, and one a
 * second or two ahead would fail `steamAt <= now` and hold the update for a
 * whole poll cycle — an "act immediately" policy that silently waited three
 * minutes on clock skew would be indistinguishable from the old behaviour.
 */
function settled(updates, settleMinutes, now = Date.now()) {
  if (!settleMinutes) return updates.slice();
  const cutoff = now - settleMinutes * 60 * 1000;
  return updates.filter((u) => u.steamAt * 1000 <= cutoff);
}

// ---------------------------------------------------------------------------
// systemd

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      // `systemctl is-active` exits non-zero for "inactive", which is an answer
      // rather than a failure, so stdout is handed back either way.
      if (err && !stdout) {
        reject(new Error((stderr || '').trim() || err.message));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

/**
 * Whether a restart is mid-run right now.
 *
 * Takes one unit or several; `systemctl is-active` prints a line per unit, so
 * any line reading active/activating means the container is already being
 * bounced by something and this pass must keep its hands off.
 */
async function restartRunning(service) {
  const units = Array.isArray(service) ? service : [service];
  if (!units.length) return false;
  try {
    const out = await run('systemctl', ['is-active', ...units]);
    return out.split('\n').some((s) => s.trim() === 'active' || s.trim() === 'activating');
  } catch {
    return false;
  }
}

/**
 * Minutes until the nightly restart timer next fires, or null when that cannot
 * be determined (in which case the caller should not defer to it).
 */
async function minutesUntilNightly(timer) {
  try {
    const out = await run('systemctl', ['show', timer, '-p', 'NextElapseUSecRealtime']);
    const usec = Number(out.split('=')[1]);
    if (!Number.isFinite(usec) || usec <= 0) return null;
    return (usec / 1000 - Date.now()) / 60000;
  } catch {
    return null;
  }
}

/**
 * Start the nightly-restart unit.
 *
 * `--no-block` because the unit runs for up to half an hour — ten of those
 * minutes are the player warnings — and blocking a bot timer callback on it
 * would be pointless. Completion is observed by polling instead.
 */
function triggerRestart(service) {
  return run('sudo', ['systemctl', 'start', '--no-block', service]);
}

/** Resolve once the unit is no longer running. @returns {Promise<boolean>} finished in time */
async function waitForRestart(service, timeoutMinutes) {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  // Give systemd a moment to actually enter the activating state, so a poll
  // landing between `start` and the job starting doesn't read as "done".
  await new Promise((r) => setTimeout(r, 15000));

  while (Date.now() < deadline) {
    if (!(await restartRunning(service))) return true;
    await new Promise((r) => setTimeout(r, 30000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// What else the restart applied

// The restart script applies each staged channel in turn and prints the
// helper's return value underneath its own log line. Two of those helpers are
// Python and print a repr (`'applied': 2`), one prints JSON (`"applied": 2`),
// hence the quote class in the pattern below.
// Plurals are spelled out rather than suffixed: "ticket replys" is the kind of
// thing that ends up in a channel players read.
const STAGED_STEPS = [
  { one: 'sandbox setting', many: 'sandbox settings', marker: 'applying staged sandbox settings' },
  { one: 'ini secret', many: 'ini secrets', marker: 'applying staged ini secrets' },
  { one: 'ticket reply', many: 'ticket replies', marker: 'applying staged ticket replies' },
];
const APPLIED = /['"]applied['"]\s*:\s*(\d+)/;

/**
 * What the restart applied besides the mods, read back from its own log.
 *
 * Staged settings ride along with any restart, so a mod-update restart is also
 * the moment a queued sandbox change or rotated secret lands. Reporting that
 * turns an otherwise silent side-effect into something visible in the channel.
 *
 * Only the newest run is considered — the log is append-only across nights, and
 * counting an earlier night's applications would be worse than saying nothing.
 *
 * @returns {Array<{label:string, applied:number}>} steps that changed
 *   something, each label already pluralised to match its count
 */
function readStagedApplied(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  // No run marker means the log is not the shape this expects; scanning it
  // anyway would attribute the oldest run's counts to this restart.
  const start = text.lastIndexOf('=== nightly restart starting ===');
  if (start === -1) return [];
  const run = text.slice(start);

  const out = [];
  for (const step of STAGED_STEPS) {
    const at = run.indexOf(step.marker);
    if (at === -1) continue;
    // The count is on one of the next couple of lines; anything further away is
    // a different step's output and must not be attributed to this one.
    const after = run.slice(at + step.marker.length).split('\n').slice(0, 3).join('\n');
    const m = APPLIED.exec(after);
    const applied = m ? Number(m[1]) : 0;
    if (applied > 0) out.push({ label: applied === 1 ? step.one : step.many, applied });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presentation

const WORKSHOP_URL = 'https://steamcommunity.com/sharedfiles/filedetails/?id=';
const day = (epochSeconds) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);

function formatAnnouncement({ updates, missing, gone }, plan) {
  const lines = [];

  if (updates.length) {
    lines.push(`**Mod update${updates.length > 1 ? 's' : ''} available** — ${updates.length} of the server's mods changed on the Workshop.`);
    lines.push('');
    for (const u of updates) {
      lines.push(`- [${u.title}](<${WORKSHOP_URL}${u.id}>) — ours is from ${day(u.localAt)}, latest is ${day(u.steamAt)}`);
    }
  }

  // `lines.length &&` throughout: a delisted mod with no pending updates would
  // otherwise open the message with a blank line.
  if (missing.length) {
    if (lines.length) lines.push('');
    lines.push('Configured but not yet downloaded (the next restart installs them):');
    for (const m of missing) lines.push(`- [${m.title}](<${WORKSHOP_URL}${m.id}>)`);
  }

  if (gone.length) {
    if (lines.length) lines.push('');
    for (const g of gone) {
      lines.push(`- **[${g.title}](<${WORKSHOP_URL}${g.id}>) is ${g.banned ? 'banned' : 'no longer on the Workshop'}** — it will fail to download on the next restart.`);
    }
  }

  lines.push('');
  lines.push(plan);
  return lines.join('\n').slice(0, 1900);
}

// ---------------------------------------------------------------------------
// The check

/** Resolve mod-update config for a guild, or null when it isn't set up. */
function updateConfig(guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  const channelId = zomboid?.channels?.modUpdates;
  if (!zomboid?.serverIni || !channelId) return null;

  return {
    channelId,
    serverIni: zomboid.serverIni,
    gameBuild: zomboid.gameBuild || 42,
    acf: acfPath(guildId),
    ...DEFAULTS,
    // `workshopPollMinutes` predates this module and is the name already in the
    // config file, so it wins over the generic default.
    pollMinutes: zomboid.workshopPollMinutes || DEFAULTS.pollMinutes,
    ...(zomboid.modUpdates || {}),
  };
}

/**
 * Decide what to do about a set of settled updates.
 *
 * Split out from the announcing so the ordering rules are readable in one
 * place, and so they can be exercised without a Discord client.
 *
 * @returns {Promise<{act:boolean, plan:string}>}
 */
async function decide(cfg, guildId, ready) {
  // With settleMinutes at 0 this is no longer "still settling" — every update
  // is ready the moment it is seen. Reaching here means the poll turned up only
  // removed mods (found.gone), which a restart would not fix.
  if (!ready.length) {
    return { act: false, plan: '_No mod updates to apply._' };
  }

  if (!cfg.autoRestart) {
    return { act: false, plan: '_Automatic restarts are off — an admin needs to restart to apply these._' };
  }

  if (await restartRunning(cfg.conflictingServices || cfg.restartService)) {
    return { act: false, plan: '_A restart is already running; these will be applied by it._' };
  }

  const untilNightly = await minutesUntilNightly(cfg.nightlyTimer);
  if (untilNightly !== null && untilNightly <= cfg.deferToNightlyMinutes) {
    return {
      act: false,
      plan: `_The nightly restart is due in ${Math.round(untilNightly)} minutes and will apply these._`,
    };
  }

  const last = getGuildState(guildId).zomboidLastModRestart || 0;
  const sinceLast = (Date.now() - last) / 60000;
  if (last && sinceLast < cfg.minMinutesBetweenRestarts) {
    return {
      act: false,
      plan: `_Restarted ${Math.round(sinceLast)} minutes ago; holding off until at least ${cfg.minMinutesBetweenRestarts} have passed._`,
    };
  }

  return {
    act: true,
    plan: '**Restarting to apply them.** Until the server is on the new version, anyone whose client has auto-updated cannot join. '
      + 'Players online get warnings at 3 and 1 minutes; the world is saved and backed up first.',
  };
}

/**
 * Run one pass for a guild.
 *
 * @returns {Promise<{updates:object[], restarted:boolean}>}
 */
async function checkOnce(client, guildId) {
  const cfg = updateConfig(guildId);
  if (!cfg) return { updates: [], restarted: false };

  if (!cfg.acf) {
    console.warn('[Zomboid] Mod update watch needs zomboid.workshopDir (or workshopAcf) to be set.');
    return { updates: [], restarted: false };
  }

  const server = readServerConfig(cfg.serverIni, cfg.gameBuild);
  const configuredIds = server.installedWorkshopIds;
  if (!configuredIds.length) return { updates: [], restarted: false };

  const local = readInstalledVersions(cfg.acf);
  if (!local.size) return { updates: [], restarted: false };

  const remote = await fetchWorkshopItems(configuredIds);
  const found = compareVersions(configuredIds, local, remote);
  if (!found.updates.length && !found.gone.length) return { updates: [], restarted: false };

  const ready = settled(found.updates, cfg.settleMinutes);

  // Report each Workshop version once. Keying on the version rather than the id
  // means a mod that updates again later is announced again, while an unchanged
  // one stays quiet across polls.
  const seen = new Set(getGuildState(guildId).zomboidSeenModVersions || []);
  const fresh = [...found.updates, ...found.gone].filter((u) => !seen.has(`${u.id}:${u.steamAt || 'gone'}`));
  const { act, plan } = await decide(cfg, guildId, ready);

  // Nothing new to say and nothing to do — most polls end here.
  if (!fresh.length && !act) return { updates: found.updates, restarted: false };

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[Zomboid] Mod update channel ${cfg.channelId} not found or not text-based.`);
    return { updates: found.updates, restarted: false };
  }

  if (fresh.length) {
    await channel.send(formatAnnouncement(found, plan));
  } else if (act) {
    // Announced on an earlier poll and held back then — by a running restart, a
    // close nightly slot or the cooldown — and only now clear to act. Say so,
    // otherwise the server would restart with nothing in Discord explaining it.
    await channel.send(
      `Applying the ${ready.length} mod update(s) announced earlier. ${plan}`.slice(0, 1900)
    );
  }

  if (fresh.length) {
    for (const u of [...found.updates, ...found.gone]) seen.add(`${u.id}:${u.steamAt || 'gone'}`);
    // Bounded so state.json doesn't grow forever; ids age out long before the
    // list fills, and re-announcing a stale one is harmless anyway.
    setGuildState(guildId, { zomboidSeenModVersions: [...seen].slice(-200) });
    console.log(`[Zomboid] Announced ${found.updates.length} mod update(s) in ${guildId}.`);
  }

  if (!act) return { updates: found.updates, restarted: false };

  // In-game warning first: the restart script's own countdown says nothing
  // about *why* the server is going down, and "mods updated" is the difference
  // between an annoying restart and an expected one.
  const titles = ready.map((u) => u.title).join(', ').slice(0, 180);
  await serverMessage(guildId, `MOD UPDATE: ${ready.length} mod(s) updated (${titles}). Restarting so players can join again - warnings to follow.`)
    .catch((err) => console.warn('[Zomboid] Could not warn players in-game:', err?.message || err));

  // Stamped before the trigger, not after: if `systemctl start` fails in a way
  // that still queued the job, a cooldown we did not record would let the next
  // poll fire a second restart on top of it.
  setGuildState(guildId, { zomboidLastModRestart: Date.now() });

  try {
    await triggerRestart(cfg.restartService);
  } catch (err) {
    // The announcement above has already told the channel a restart is coming,
    // so silence here would leave players waiting for one that never happens.
    console.error('[Zomboid] Could not start the restart unit:', err?.message || err);
    await channel.send(
      `**The restart could not be started** — \`${cfg.restartService}\` refused: ${err?.message || err}. ` +
      'The updates are still pending; the nightly restart will apply them.'
    ).catch(() => {});
    return { updates: found.updates, restarted: false };
  }
  console.log(`[Zomboid] Triggered ${cfg.restartService} for ${ready.length} mod update(s).`);

  reportRestart(channel, guildId, cfg, ready).catch((err) =>
    console.error('[Zomboid] Mod update follow-up failed:', err?.message || err));

  return { updates: found.updates, restarted: true };
}

/**
 * Wait for the restart to finish and say how it went.
 *
 * Deliberately verifies against the manifest again rather than trusting that
 * the restart did what it was asked: the interesting failure is the one where
 * the unit exits clean but steamcmd did not actually fetch the new version.
 */
async function reportRestart(channel, guildId, cfg, expected) {
  const finished = await waitForRestart(cfg.restartService, cfg.restartTimeoutMinutes);
  if (!finished) {
    await channel.send(
      `The restart for ${expected.length} mod update(s) is still running after ` +
      `${cfg.restartTimeoutMinutes} minutes. Check \`zomboid-restart.service\`.`
    );
    return;
  }

  const local = readInstalledVersions(cfg.acf);
  const stillStale = expected.filter((u) => (local.get(u.id) ?? 0) < u.steamAt);
  const up = await isReachable(guildId);

  const lines = [];
  if (!stillStale.length) {
    lines.push(`**Mods updated.** ${expected.length} mod(s) are now on the latest Workshop version.`);
  } else {
    lines.push(`**Restart finished, but ${stillStale.length} of ${expected.length} mod(s) did not update:**`);
    for (const u of stillStale) lines.push(`- ${u.title} (\`${u.id}\`)`);
    lines.push('Steam may have failed to download them — worth checking before the next restart.');
  }
  lines.push(up ? 'The server is back up and accepting connections.' : '**The server is not answering RCON** — it may still be booting, or it may have failed to start.');

  // Anything queued for "the next restart" was applied by this one.
  const staged = readStagedApplied(cfg.restartLog);
  if (staged.length) {
    const parts = staged.map((s) => `${s.applied} ${s.label}`);
    lines.push(`Also applied with this restart: ${parts.join(', ')}.`);
  }

  await channel.send(lines.join('\n').slice(0, 1900));
}

/** Start polling for every guild with mod update watching configured. */
function scheduleModUpdates(client) {
  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'zomboid')) continue;
    const cfg = updateConfig(guildId);
    if (!cfg) continue;

    const tick = () => checkOnce(client, guildId).catch((err) =>
      console.error('[Zomboid] Mod update check failed:', err?.message || err));

    // A first pass shortly after boot, so an update that landed while the bot
    // was down is not sat on for a full poll interval.
    setTimeout(tick, 60 * 1000);
    setInterval(tick, cfg.pollMinutes * 60 * 1000);

    console.log(
      `[Zomboid] Mod update watch armed for ${guildId} every ${cfg.pollMinutes}m ` +
      `(auto-restart ${cfg.autoRestart ? 'on' : 'off'}).`
    );
  }
}

module.exports = {
  acfPath,
  readInstalledVersions,
  readStagedApplied,
  compareVersions,
  settled,
  formatAnnouncement,
  updateConfig,
  decide,
  checkOnce,
  scheduleModUpdates,
  restartRunning,
  minutesUntilNightly,
  DEFAULTS,
};
