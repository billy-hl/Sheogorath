'use strict';
/**
 * Vets Steam Workshop mod requests against what this server can actually run.
 *
 * The Workshop API carries the facts that decide most requests outright — the
 * game it belongs to, whether it is banned, and its Build/Multiplayer tags — so
 * those are checked deterministically. The model is only asked to read the
 * free-text description for things no field captures: required dependencies,
 * client-side-only warnings, and conflicts with what is already installed.
 */
const axios = require('axios');
const { getAIResponse } = require('../../ai/grok');

const STEAM_API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const PZ_APP_ID = 108600;
const STALE_YEARS = 2;

/** Workshop links, plus bare 9-10 digit ids so people can paste just the number. */
function parseWorkshopIds(text) {
  const ids = new Set();
  const urlRe = /(?:sharedfiles|workshop)\/filedetails\/?\?id=(\d{6,12})/gi;
  let m;
  while ((m = urlRe.exec(text)) !== null) ids.add(m[1]);
  if (ids.size === 0) {
    for (const bare of text.match(/(?<!\d)\d{9,10}(?!\d)/g) || []) ids.add(bare);
  }
  return [...ids];
}

/** @returns {Promise<object[]>} raw Workshop records, in request order. */
async function fetchWorkshopItems(ids) {
  const form = new URLSearchParams();
  form.append('itemcount', String(ids.length));
  ids.forEach((id, i) => form.append(`publishedfileids[${i}]`, id));

  const { data } = await axios.post(STEAM_API, form, { timeout: 15000 });
  return data?.response?.publishedfiledetails || [];
}

/**
 * Deterministic verdict from Workshop metadata alone.
 *
 * @param {object} item raw Workshop record
 * @param {{gameBuild:number, installedWorkshopIds:string[], installedMods:string[]}} server
 * @returns {{ok:boolean, verdict:string, blockers:string[], warnings:string[], facts:object}}
 */
function assess(item, server) {
  const blockers = [];
  const warnings = [];
  const tags = (item.tags || []).map((t) => t.tag);
  const desc = item.description || '';

  // `Mod ID: X` is convention, not schema — absent on plenty of working mods,
  // so a miss is a warning rather than a blocker.
  const modIds = [...desc.matchAll(/Mod\s*ID\s*:\s*([A-Za-z0-9_.\- ]+)/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  if (item.result !== 1) {
    blockers.push('That Workshop item does not exist or has been removed.');
  } else {
    if (Number(item.consumer_app_id) !== PZ_APP_ID) {
      blockers.push(`That is not a Project Zomboid item (it belongs to app ${item.consumer_app_id}).`);
    }
    if (item.banned) {
      blockers.push(`Banned from the Workshop${item.ban_reason ? `: ${item.ban_reason}` : '.'}`);
    }

    const buildTags = tags.filter((t) => /^Build \d+$/i.test(t));
    const wanted = `Build ${server.gameBuild}`;
    if (buildTags.length && !buildTags.some((t) => t.toLowerCase() === wanted.toLowerCase())) {
      blockers.push(`Tagged for ${buildTags.join(' and ')}; this server runs ${wanted}.`);
    } else if (!buildTags.length) {
      warnings.push('No Build tag, so version support is unconfirmed.');
    }

    if (tags.length && !tags.some((t) => /multiplayer/i.test(t))) {
      warnings.push('Not tagged Multiplayer — may be single-player only or client-side.');
    }

    const ageMs = Date.now() - Number(item.time_updated || 0) * 1000;
    if (ageMs > STALE_YEARS * 365 * 24 * 3600 * 1000) {
      warnings.push(`Last updated ${new Date(Number(item.time_updated) * 1000).toISOString().slice(0, 10)} — possibly abandoned.`);
    }
    if (!modIds.length) {
      warnings.push('No "Mod ID:" in the description; it will have to be read from mod.info before installing.');
    }
  }

  const alreadyItem = server.installedWorkshopIds.includes(String(item.publishedfileid));
  const alreadyMod = modIds.some((id) => server.installedMods.includes(id));
  if (alreadyItem || alreadyMod) {
    warnings.push('Already installed on this server.');
  }

  return {
    ok: blockers.length === 0,
    verdict: blockers.length ? 'NO' : warnings.length ? 'MAYBE' : 'YES',
    blockers,
    warnings,
    facts: {
      id: item.publishedfileid,
      title: item.title || '(untitled)',
      tags,
      modIds,
      updated: item.time_updated ? new Date(Number(item.time_updated) * 1000).toISOString().slice(0, 10) : null,
      subs: item.subscriptions ?? null,
      sizeMb: item.file_size ? Math.round(Number(item.file_size) / 1048576 * 10) / 10 : null,
      description: desc,
      alreadyInstalled: alreadyItem || alreadyMod,
    },
  };
}

const SYSTEM_PROMPT =
  'You advise the staff of a Project Zomboid multiplayer server on whether a ' +
  'requested Workshop mod can be used. You are given verified metadata and a ' +
  'mod description. In ONE or TWO short sentences, note only what the metadata ' +
  'does not already say: required dependency mods named in the description, ' +
  'whether it sounds client-side or single-player only, and any likely clash ' +
  'with the installed mods listed. If the description reveals nothing useful, ' +
  'say so briefly. Do not repeat the build tag, subscriber count or dates. Do ' +
  'not invent requirements. Plain and factual, no roleplay, no emoji.';

/** Short model note on the things metadata can't answer. */
async function describeCaveats(check, server) {
  const f = check.facts;
  try {
    const note = await getAIResponse(
      [
        `Server runs Project Zomboid Build ${server.gameBuild}, multiplayer, ${server.installedMods.length} mods installed.`,
        `Installed mods: ${server.installedMods.join(', ') || 'none'}`,
        '',
        `Requested mod: ${f.title}`,
        `Tags: ${f.tags.join(', ') || 'none'}`,
        `Description:\n${f.description.slice(0, 1500) || '(empty)'}`,
      ].join('\n'),
      { rawSystemPrompt: SYSTEM_PROMPT, maxTokens: 160 }
    );
    return (note || '').trim();
  } catch (err) {
    console.warn('[Zomboid] Mod check AI note failed:', err?.message || err);
    return '';
  }
}

/** Render one assessment as a Discord message. */
function formatReply(check, note) {
  const f = check.facts;
  const head = { YES: 'Looks usable', MAYBE: 'Needs a look', NO: 'Cannot be used' }[check.verdict];

  const lines = [`**${f.title}** — \`${f.id}\``, `**${head}**`];

  const meta = [];
  const buildTag = f.tags.find((t) => /^Build \d+$/i.test(t));
  if (buildTag) meta.push(buildTag);
  if (f.tags.some((t) => /multiplayer/i.test(t))) meta.push('Multiplayer');
  if (f.updated) meta.push(`updated ${f.updated}`);
  if (f.subs !== null) meta.push(`${f.subs} subscribers`);
  if (f.sizeMb !== null) meta.push(`${f.sizeMb} MB`);
  if (meta.length) lines.push(meta.join(' | '));

  if (f.modIds.length) lines.push(`Mod ID: \`${f.modIds.join('`, `')}\``);
  for (const b of check.blockers) lines.push(`- ${b}`);
  for (const w of check.warnings) lines.push(`- ${w}`);
  if (note) lines.push('', note);

  return lines.join('\n').slice(0, 1900);
}

/**
 * Full pipeline for one message's worth of links.
 * @returns {Promise<string|null>} reply text, or null when there was nothing to check
 */
async function checkRequest(text, server, { maxItems = 3 } = {}) {
  const ids = parseWorkshopIds(text).slice(0, maxItems);
  if (!ids.length) return null;

  const items = await fetchWorkshopItems(ids);
  if (!items.length) return null;

  const blocks = [];
  for (const item of items) {
    const check = assess(item, server);
    // Blocked items are already fully explained by metadata; skip the model call.
    const note = check.ok ? await describeCaveats(check, server) : '';
    blocks.push(formatReply(check, note));
  }
  return blocks.join('\n\n');
}

/**
 * What the server currently runs, read fresh from the ini each time so a mod
 * added at the nightly restart is reflected without restarting the bot.
 *
 * @param {string} iniPath
 * @param {number} gameBuild
 */
function readServerConfig(iniPath, gameBuild) {
  const fs = require('fs');
  const out = { gameBuild, installedWorkshopIds: [], installedMods: [] };
  let text;
  try {
    text = fs.readFileSync(iniPath, 'utf8');
  } catch (err) {
    console.warn('[Zomboid] Could not read server ini:', err?.message || err);
    return out;
  }
  const val = (key) => {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    return m ? m[1].trim() : '';
  };
  const split = (s) => s.split(';').map((x) => x.trim()).filter(Boolean);
  out.installedWorkshopIds = split(val('WorkshopItems'));
  out.installedMods = split(val('Mods'));
  return out;
}

module.exports = {
  parseWorkshopIds,
  fetchWorkshopItems,
  assess,
  checkRequest,
  formatReply,
  readServerConfig,
};
