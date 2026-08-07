'use strict';
/**
 * The item catalogue behind `/pz giveitem`.
 *
 * RCON's `additem` wants an internal ID — `Base.Axe`, `Base.CeramicCrucibleSmall`.
 * Nobody remembers those, so this builds the reverse index: the display names
 * people actually see in-game ("Fire Axe", "Box of .30-30 Rounds") mapped back
 * to the ID, ready for a Discord autocomplete.
 *
 * The names come from the translation files rather than the item scripts.
 * Scripts hold the authoritative *list* of items, but only a bare ID —
 * `item CeramicCrucible_Iron` — while the translations hold the human name for
 * the same key. Since the whole point is searching by human name, an item with
 * no translation is one nobody could search for anyway.
 *
 * Two file formats, because the game changed them and mods sit on both sides:
 *   b42 JSON  — { "Base.Axe": "Axe" }
 *   b41 Lua   — ItemName_EN = { ItemName_Base.Axe = "Axe", }
 *
 * Only *enabled* mods are indexed. The workshop directory keeps every mod ever
 * downloaded, including ones since switched off; offering their items would
 * hand out IDs that `additem` then rejects.
 */
const fs = require('fs');
const path = require('path');
const { getGuildConfig } = require('../../config/guilds');

// Mods update and the server restarts nightly; an hour keeps a newly enabled
// mod's items from being missing all day without re-reading ~35 files a keystroke.
const TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // cacheKey -> { at, items }

const RELATIVE_TRANSLATIONS = path.join('media', 'lua', 'shared', 'Translate', 'EN');

/** `ItemName_Base.Axe = "Axe",` → ['Base.Axe', 'Axe'] */
const LUA_ENTRY = /ItemName_([A-Za-z0-9_.]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;

function parseJsonNames(text) {
  // Some mod files ship a UTF-8 BOM, which JSON.parse chokes on.
  const parsed = JSON.parse(text.replace(/^﻿/, ''));
  const out = [];
  for (const [id, name] of Object.entries(parsed)) {
    if (typeof name === 'string') out.push([id, name]);
  }
  return out;
}

function parseLuaNames(text) {
  const out = [];
  for (const m of text.matchAll(LUA_ENTRY)) {
    out.push([m[1], m[2].replace(/\\"/g, '"')]);
  }
  return out;
}

function readNameFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return file.endsWith('.json') ? parseJsonNames(text) : parseLuaNames(text);
}

/** Workshop IDs the server actually loads, read from `WorkshopItems=` in the ini. */
function enabledWorkshopIds(serverIni) {
  if (!serverIni) return null;
  let text;
  try {
    text = fs.readFileSync(serverIni, 'utf8');
  } catch {
    return null; // Can't tell — caller falls back to indexing everything.
  }
  const line = /^WorkshopItems=(.*)$/m.exec(text);
  if (!line) return null;
  return new Set(
    line[1]
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Every EN ItemName file under a mod directory. Mods nest them inconsistently —
 * `mods/<name>/media/...`, `mods/<name>/<build>/media/...`, `common/media/...` —
 * so this walks rather than guessing the layout.
 */
function findNameFiles(dir, found = [], depth = 0) {
  if (depth > 6) return found;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findNameFiles(full, found, depth + 1);
    } else if (/^ItemName(_EN)?\.(json|txt)$/i.test(entry.name) && full.includes(RELATIVE_TRANSLATIONS)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Build the id→name map.
 *
 * Base game first, then mods, so a mod that deliberately relabels a vanilla item
 * wins — that relabel is what players see in their inventory, so it's the name
 * they'll search by.
 */
function build({ gameDir, workshopDir, serverIni }) {
  const names = new Map();
  const add = (pairs) => {
    for (const [id, name] of pairs) if (id && name) names.set(id, name);
  };

  if (gameDir) {
    const base = path.join(gameDir, RELATIVE_TRANSLATIONS);
    for (const file of ['ItemName.json', 'ItemName_EN.txt']) {
      try {
        add(readNameFile(path.join(base, file)));
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`[Items] Skipped ${file}: ${err.message}`);
        }
      }
    }
  }

  if (workshopDir) {
    const enabled = enabledWorkshopIds(serverIni);
    let modDirs;
    try {
      modDirs = fs.readdirSync(workshopDir, { withFileTypes: true });
    } catch {
      modDirs = [];
    }
    for (const entry of modDirs) {
      if (!entry.isDirectory()) continue;
      if (enabled && !enabled.has(entry.name)) continue;
      for (const file of findNameFiles(path.join(workshopDir, entry.name))) {
        try {
          add(readNameFile(file));
        } catch (err) {
          // One malformed mod file shouldn't cost us the whole catalogue.
          console.warn(`[Items] Skipped ${file}: ${err.message}`);
        }
      }
    }
  }

  // Pre-lowercased so searching doesn't re-lowercase 5k names per keystroke.
  return [...names.entries()].map(([id, name]) => ({
    id,
    name,
    lcName: name.toLowerCase(),
    lcId: id.toLowerCase(),
  }));
}

/** The catalogue for a guild's server, cached. */
function catalogue(guildId) {
  const z = getGuildConfig(guildId)?.zomboid;
  if (!z) return [];

  const key = `${z.gameDir || ''}|${z.workshopDir || ''}|${z.serverIni || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;

  let items;
  try {
    items = build({ gameDir: z.gameDir, workshopDir: z.workshopDir, serverIni: z.serverIni });
  } catch (err) {
    console.warn('[Items] Could not build item index:', err?.message || err);
    items = [];
  }

  cache.set(key, { at: Date.now(), items });
  if (items.length) console.log(`[Items] Indexed ${items.length} item names.`);
  return items;
}

/**
 * Rank items against what the user has typed so far.
 *
 * Ordering is by how close a match it is, then shortest name first, which floats
 * the plain item above its variants — typing "axe" offers "Axe" before "Axe
 * Handle Splinter". An empty query returns an arbitrary slice, so the picker
 * isn't blank before the first keystroke.
 *
 * The all-tokens tier is what makes this usable rather than merely correct.
 * People search for the item they have in mind, not the string the game stores:
 * "fire axe" is nobody's typo, but the item is called "Firefighter Axe", and a
 * contiguous-substring match alone returns nothing for it. Requiring only that
 * every word appear somewhere finds it, while ranking below the exact hits so
 * the looser matches never displace a direct one.
 *
 * The whole catalogue is scanned every time. At ~5k items that is well under a
 * millisecond, and an early bail-out risks cutting the loop before a better
 * match further down the list.
 *
 * @returns {Array<{id: string, name: string}>} at most `limit` entries
 */
function search(guildId, query, limit = 25) {
  const items = catalogue(guildId);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items.slice(0, limit);

  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const item of items) {
    let score;
    if (item.lcName === q) score = 0;
    else if (item.lcName.startsWith(q)) score = 1;
    else if (item.lcId.endsWith(`.${q}`)) score = 2;
    else if (item.lcName.includes(q)) score = 3;
    else if (tokens.length > 1 && tokens.every((t) => item.lcName.includes(t))) score = 4;
    else if (item.lcId.includes(q)) score = 5;
    else continue;

    scored.push({ item, score });
  }

  scored.sort((a, b) => a.score - b.score || a.item.name.length - b.item.name.length);
  return scored.slice(0, limit).map(({ item }) => ({ id: item.id, name: item.name }));
}

/**
 * Turn whatever came back from the option into an item ID.
 *
 * Autocomplete sends the ID we put in the choice value, but the option is
 * free-text — someone can ignore the picker and type "fire axe" or "Base.Axe"
 * by hand, and both should work.
 *
 * @returns {{id: string, name: string}|null}
 */
function resolve(guildId, input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const items = catalogue(guildId);
  const exactId = items.find((i) => i.lcId === raw.toLowerCase());
  if (exactId) return { id: exactId.id, name: exactId.name };

  // An unindexed but well-formed ID is still worth passing through: a mod may
  // ship items with no EN translation, and the server is the real authority.
  if (/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(raw)) return { id: raw, name: raw };

  const [best] = search(guildId, raw, 1);
  return best || null;
}

/** Drop the cache — used after a mod update changes what's installed. */
function clearCache() {
  cache.clear();
}

module.exports = { search, resolve, catalogue, clearCache };
