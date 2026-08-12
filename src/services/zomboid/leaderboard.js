'use strict';
/**
 * Player records and leaderboards built from the Project Zomboid PerkLog.
 *
 * PZ writes two lines at each session boundary — a marker (`[Login]` or
 * `[Died]`) and, on login only, a full skill dump. Both carry `Hours Survived`:
 *
 *   [06-08-26 20:49:23.288] [7656…][Chus115][1107,12862,0][Login][Hours Survived: 906].
 *   [06-08-26 20:49:23.288] [7656…][Chus115][1107,12862,0][Cooking=0, Fitness=7, …][Hours Survived: 906].
 *
 * That is the whole of the server-side progression record. No kill counts live
 * here: **zombie** kills are not written to any log the server produces, and the
 * only copy lives inside the serialized player blobs in players.db, whose field
 * offsets shift between saves and cannot be read reliably. A wrong number on a
 * leaderboard is worse than a missing one.
 *
 * **Player** kills are a different story — the pvp log attributes those to a
 * killer by name, and kills.js builds the board from it. The two are kept apart
 * on purpose: these records are keyed by Steam ID, the pvp log has none.
 *
 * Players are keyed by **Steam ID**, never by name: names change, admins can
 * rename characters, and two characters can share a name. The most recently seen
 * name is what gets displayed.
 */
const { linesSince } = require('./logs');

// Reach across every rotated log directory on disk — this reports all-time
// records, so unlike the 24h consumers it wants the full history.
const ALL_HISTORY_DIRS = 400;

// `[7656…][Name][x,y,z][Cooking=0, Fitness=7, …][Hours Survived: 906].`
const SKILL_DUMP =
  /^\[.+?\] \[(\d+)\]\[(.+?)\]\[[^\]]*\]\[([A-Za-z]\w*=-?\d+(?:,\s*[A-Za-z]\w*=-?\d+)*)\]\[Hours Survived: (\d+)\]/;
// `[7656…][Name][x,y,z][Login|Died][Hours Survived: 906].`
const MARKER =
  /^\[.+?\] \[(\d+)\]\[(.+?)\]\[([^\]]*)\]\[(Login|Died)\]\[Hours Survived: (\d+)\]/;

function blank(steamid) {
  return {
    steamid,
    name: null,
    nameAt: -1,
    /** @type {Object<string, number>} level per skill, from the newest dump */
    skills: {},
    skillsAt: -1,
    /** Hours Survived from the newest event of any kind. */
    hours: 0,
    hoursAt: -1,
    /** Highest Hours Survived ever seen, across every character. */
    bestHours: 0,
    deaths: 0,
    sessions: 0,
    lastDeathAt: -1,
    lastDeathPos: null,
    lastSeen: -1,
  };
}

/**
 * Parse every PerkLog line into one record per Steam ID.
 *
 * Files are read newest-directory-first and lines can therefore arrive out of
 * order, so every "latest" field is guarded by its own timestamp rather than
 * assuming sequential reads.
 *
 * @param {string} logDir
 * @returns {Map<string, ReturnType<typeof blank>>}
 */
function collectPlayers(logDir) {
  const players = new Map();
  const rec = (steamid) => {
    if (!players.has(steamid)) players.set(steamid, blank(steamid));
    return players.get(steamid);
  };

  for (const { at, line } of linesSince(logDir, 'PerkLog', 0, ALL_HISTORY_DIRS)) {
    const dump = SKILL_DUMP.exec(line);
    if (dump) {
      const r = rec(dump[1]);
      if (at > r.skillsAt) {
        r.skillsAt = at;
        r.skills = {};
        for (const pair of dump[3].split(',')) {
          const [k, v] = pair.split('=');
          if (k && v !== undefined) r.skills[k.trim()] = Number(v);
        }
      }
      noteName(r, dump[2], at);
      noteHours(r, Number(dump[4]), at);
      continue;
    }

    const mark = MARKER.exec(line);
    if (!mark) continue;
    const r = rec(mark[1]);
    noteName(r, mark[2], at);
    noteHours(r, Number(mark[5]), at);
    if (mark[4] === 'Died') {
      r.deaths++;
      if (at > r.lastDeathAt) {
        r.lastDeathAt = at;
        r.lastDeathPos = mark[3];
      }
    } else {
      r.sessions++;
    }
  }

  return players;
}

function noteName(r, name, at) {
  if (at >= r.nameAt) {
    r.name = name;
    r.nameAt = at;
  }
  if (at > r.lastSeen) r.lastSeen = at;
}

function noteHours(r, hours, at) {
  if (!Number.isFinite(hours)) return;
  // `hours` is the current character's counter and resets on death, so the
  // newest reading is the live one — but the all-time best has to be tracked
  // separately or a death would erase the record.
  if (at >= r.hoursAt) {
    r.hoursAt = at;
    r.hours = hours;
  }
  if (hours > r.bestHours) r.bestHours = hours;
}

/**
 * Whether a record's skill snapshot describes a *living* character.
 *
 * A dump is only written at login, so after a death the newest dump belongs to
 * the character that just died — stale, and its skills are gone. Only a dump
 * timestamped after the last death reflects someone currently alive.
 */
function isAlive(r) {
  return r.skillsAt > -1 && r.skillsAt > r.lastDeathAt;
}

function totalLevels(r) {
  return Object.values(r.skills).reduce((sum, lvl) => sum + (lvl > 0 ? lvl : 0), 0);
}

/** Every skill name seen in any dump, so modded skills appear automatically. */
function knownSkills(players) {
  const names = new Set();
  for (const r of players.values()) for (const k of Object.keys(r.skills)) names.add(k);
  return [...names].sort();
}

/**
 * Rank records by `value`, dropping zero/negative scores.
 * Ties break on name so the order is stable between calls.
 */
function rank(players, value, { aliveOnly = false, limit = 5 } = {}) {
  const rows = [];
  for (const r of players.values()) {
    if (aliveOnly && !isAlive(r)) continue;
    const v = value(r);
    if (!Number.isFinite(v) || v <= 0) continue;
    rows.push({ name: r.name || r.steamid, value: v, rec: r });
  }
  rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return rows.slice(0, limit);
}

/**
 * The highest holder of every skill, for the "champions" board.
 * @returns {Array<{skill:string, value:number, names:string[]}>}
 */
function skillChampions(players, { limit = 3 } = {}) {
  const out = [];
  for (const skill of knownSkills(players)) {
    const rows = rank(players, (r) => r.skills[skill] || 0, { aliveOnly: true, limit: 50 });
    if (!rows.length) continue;
    const best = rows[0].value;
    const names = rows.filter((row) => row.value === best).map((row) => row.name);
    out.push({ skill, value: best, names: names.slice(0, limit), tied: names.length });
  }
  // Highest level first so the impressive entries lead.
  out.sort((a, b) => b.value - a.value || a.skill.localeCompare(b.skill));
  return out;
}

module.exports = {
  collectPlayers,
  isAlive,
  totalLevels,
  knownSkills,
  rank,
  skillChampions,
};
