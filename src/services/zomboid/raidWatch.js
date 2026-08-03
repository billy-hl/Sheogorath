'use strict';
/**
 * Watches for raid-logging — players disconnecting to escape a fight.
 *
 * The server seals a safehouse the moment its last member goes offline
 * (`DisableSafehouseWhenOwnerConnected=true`), so quitting mid-raid does not
 * just end the fight, it makes the base invulnerable. PZ offers no mechanism
 * to prevent that, so the next best thing is to catch it while the raid is
 * still happening and let an admin intervene.
 *
 * The signal is a join between two logs PZ already writes:
 *   pvp.txt         `Combat: "A" (x,y,z) hit "B" (x,y,z) weapon="W" damage=D.`
 *   connections.txt `event="disconnect" ... username="B"`
 *
 * One player leaving after a scuffle is ambiguous — people lose connections,
 * crash, and eat dinner. A *group* leaving together inside a couple of minutes
 * is not, and that group signature is what this alerts on. Solo departures are
 * only reported when they are near-instant, which is hard to explain innocently.
 *
 * Everything here produces LEADS, not proof: PZ's disconnect record cannot
 * distinguish a rage-quit from a crash. Messages say so, on purpose.
 */
const { getGuildConfig } = require('../../config/guilds');
const { linesSince, parseStamp } = require('./logs');

// `Combat: "A" (x,y,z) hit "B" (x,y,z) weapon="Crowbar (Bloody)" damage=0.02.`
// Weapon names contain their own brackets, so the quotes do the delimiting.
const COMBAT = /Combat: "(.+?)" \((-?\d+),(-?\d+),(-?\d+)\) hit "(.+?)" \((-?\d+),(-?\d+),(-?\d+)\) weapon="(.+?)" damage=([\d.-]+)/;
// Client-initiated leave. RakNet's own `disconnection-notification` lines carry
// no username, so they are skipped — this one is the record with a name on it.
const DISCONNECT = /event="disconnect".*?username="(.+?)"/;

const DEFAULTS = {
  pollMinutes: 2,
  // How long after being hit a departure still counts as leaving the fight.
  contactWindowSeconds: 300,
  // Departures this close together are treated as one coordinated exit.
  clusterWindowSeconds: 180,
  // Distinct players who must leave together before a group alert fires.
  minLeavers: 2,
  // A lone departure this fast after contact is reported on its own.
  soloFastLeaveSeconds: 60,
  // Zombie and vehicle hits are logged in the same file and are not PvP.
  ignoreWeapons: ['zombie', 'vehicle'],
};

/** PvP contacts in the window, oldest first. */
function readContacts(logDir, sinceMs, ignoreWeapons = DEFAULTS.ignoreWeapons) {
  const ignore = new Set(ignoreWeapons.map((w) => w.toLowerCase()));
  const out = [];

  for (const { at, line } of linesSince(logDir, 'pvp', sinceMs)) {
    const m = COMBAT.exec(line);
    if (!m) continue;
    const [, attacker, ax, ay, , victim, vx, vy, , weapon, damage] = m;
    // PZ logs zombie and vehicle damage through the same Combat: line, naming
    // the victim on both sides. Either check alone would let some through.
    if (attacker === victim || ignore.has(weapon.toLowerCase())) continue;
    out.push({
      at,
      attacker,
      victim,
      weapon,
      damage: Number(damage.replace(/\.$/, '')) || 0,
      at_xy: [Number(ax), Number(ay)],
      vic_xy: [Number(vx), Number(vy)],
    });
  }

  return out.sort((a, b) => a.at - b.at);
}

/** Named client disconnects in the window, oldest first. */
function readDepartures(logDir, sinceMs) {
  const out = [];
  for (const { at, line } of linesSince(logDir, 'connections', sinceMs)) {
    const m = DISCONNECT.exec(line);
    if (m) out.push({ at, player: m[1] });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Departures that followed PvP contact involving that same player.
 *
 * Each carries the most recent contact, which is what an admin needs to judge
 * the call: who, with what, how long before they vanished.
 */
function suspiciousDepartures(contacts, departures, opts) {
  const windowMs = opts.contactWindowSeconds * 1000;
  const out = [];

  for (const dep of departures) {
    let last = null;
    for (const c of contacts) {
      if (c.at > dep.at) break; // contacts are sorted; nothing later can qualify
      if (dep.at - c.at > windowMs) continue;
      if (c.attacker !== dep.player && c.victim !== dep.player) continue;
      last = c;
    }
    if (last) {
      out.push({
        ...dep,
        contact: last,
        side: last.victim === dep.player ? 'victim' : 'attacker',
        gapSeconds: Math.round((dep.at - last.at) / 1000),
      });
    }
  }

  return out;
}

/**
 * Group suspicious departures into incidents.
 *
 * Clustering is by arrival time rather than by faction because PZ's logs do not
 * expose faction membership — but people leaving together within a couple of
 * minutes of the same fight are, in practice, the same group.
 */
function findIncidents(contacts, departures, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const suspects = suspiciousDepartures(contacts, departures, opts);
  if (!suspects.length) return [];

  const clusterMs = opts.clusterWindowSeconds * 1000;
  const clusters = [];
  let current = [suspects[0]];

  for (const dep of suspects.slice(1)) {
    if (dep.at - current[current.length - 1].at <= clusterMs) current.push(dep);
    else { clusters.push(current); current = [dep]; }
  }
  clusters.push(current);

  const incidents = [];
  for (const cluster of clusters) {
    const leaving = new Set(cluster.map((d) => d.player));

    // Only count people who were on the receiving end and whose attacker stayed
    // online. Without this, a duel where both fighters log off afterwards looks
    // identical to a group sealing its base — and on real logs that was most of
    // the noise. The pattern worth waking an admin for is one-sided: the raider
    // is still standing there when the defenders vanish.
    const defenders = cluster.filter(
      (d) => d.side === 'victim' && !leaving.has(d.contact.attacker)
    );
    if (!defenders.length) continue;

    const players = [...new Set(defenders.map((d) => d.player))];
    const fastest = Math.min(...defenders.map((d) => d.gapSeconds));

    const isGroup = players.length >= opts.minLeavers;
    const isFastSolo = players.length === 1 && fastest <= opts.soloFastLeaveSeconds;
    if (!isGroup && !isFastSolo) continue;

    incidents.push({
      at: defenders[0].at,
      kind: isGroup ? 'group' : 'solo',
      players,
      departures: defenders,
      // Stable across polls so the same incident is not announced twice.
      key: `${defenders[0].at}:${players.slice().sort().join(',')}`,
    });
  }

  return incidents;
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });

/** Render one incident as a Discord message. */
function formatIncident(incident) {
  const { kind, players, departures } = incident;
  const head = kind === 'group'
    ? `**Possible raid-log** — ${players.length} players left together after PvP contact`
    : '**Possible combat-log** — player left seconds after being hit';

  const lines = [head, ''];
  for (const d of departures) {
    const c = d.contact;
    const role = c.victim === d.player ? 'was hit by' : 'hit';
    const other = c.victim === d.player ? c.attacker : c.victim;
    const [x, y] = c.victim === d.player ? c.vic_xy : c.at_xy;
    lines.push(
      `\`${clock(c.at)}\` **${d.player}** ${role} **${other}** ` +
      `(${c.weapon}) at ${x},${y} — disconnected **${d.gapSeconds}s** later`
    );
  }

  lines.push('');
  lines.push(
    '_Lead, not proof — PZ cannot tell a quit from a crash. ' +
    'Check whether a safehouse sealed with a raid in progress before acting._'
  );

  return lines.join('\n');
}

/** Resolve raid-watch config for a guild, or null when it isn't set up. */
function raidConfig(guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  const channelId = zomboid?.channels?.raidAlerts;
  if (!zomboid?.logDir || !channelId) return null;
  return { logDir: zomboid.logDir, channelId, ...DEFAULTS, ...(zomboid.raidWatch || {}) };
}

// Incidents already announced, so overlapping poll windows don't double-post.
// Deliberately in-memory: the watermark below starts at process start, so a
// restart cannot replay yesterday's incidents into the channel.
const announced = new Set();
const watermark = new Map();

/** Run one pass for a guild. Returns the incidents posted. */
async function checkOnce(client, guildId, now = Date.now()) {
  const cfg = raidConfig(guildId);
  if (!cfg) return [];

  // Look back far enough to catch a fight that began before this poll, and to
  // survive a missed tick, without re-reading the whole day every two minutes.
  const lookbackMs = (cfg.contactWindowSeconds + cfg.clusterWindowSeconds) * 1000
    + cfg.pollMinutes * 60 * 1000 * 2;
  const since = now - lookbackMs;

  const contacts = readContacts(cfg.logDir, since, cfg.ignoreWeapons);
  const departures = readDepartures(cfg.logDir, since);
  const floor = watermark.get(guildId) ?? now;

  const fresh = findIncidents(contacts, departures, cfg)
    .filter((i) => i.at >= floor && !announced.has(i.key));
  if (!fresh.length) return [];

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[Zomboid] Raid alert channel ${cfg.channelId} not found or not text-based.`);
    return [];
  }

  for (const incident of fresh) {
    await channel.send(formatIncident(incident));
    announced.add(incident.key);
    console.log(`[Zomboid] Raid alert (${incident.kind}): ${incident.players.join(', ')}`);
  }

  watermark.set(guildId, Math.max(floor, ...fresh.map((i) => i.at + 1)));
  return fresh;
}

/** Start polling for every guild with raid watching configured. */
function scheduleRaidWatch(client) {
  const { guildIds, hasFeature } = require('../../config/guilds');

  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'zomboid')) continue;
    const cfg = raidConfig(guildId);
    if (!cfg) continue;

    // Only alert on things that happen from now on — never backfill on boot.
    watermark.set(guildId, Date.now());

    setInterval(() => {
      checkOnce(client, guildId).catch((err) =>
        console.error('[Zomboid] Raid watch failed:', err?.message || err));
    }, cfg.pollMinutes * 60 * 1000);

    console.log(`[Zomboid] Raid watch armed for ${guildId} every ${cfg.pollMinutes}m.`);
  }
}

module.exports = {
  readContacts,
  readDepartures,
  suspiciousDepartures,
  findIncidents,
  formatIncident,
  raidConfig,
  checkOnce,
  scheduleRaidWatch,
  DEFAULTS,
};
