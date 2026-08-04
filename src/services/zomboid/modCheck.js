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

/**
 * Recent Workshop comments for an item.
 *
 * Steam has no documented comments API; the community site renders them through
 * this endpoint, which needs no auth. It returns an HTML blob, so entries are
 * recovered by stripping tags — brittle by nature, hence the try/catch and the
 * empty-array fallback. Comments are advisory only; nothing blocks on them.
 *
 * @returns {Promise<Array<{author:string, date:string, text:string}>>} newest first
 */
async function fetchComments(creatorId, fileId, count = 20) {
  if (!creatorId || !fileId) return [];
  const url = `https://steamcommunity.com/comment/PublishedFile_Public/render/${creatorId}/${fileId}/`;
  try {
    const { data } = await axios.get(url, { params: { start: 0, count }, timeout: 15000 });
    if (!data?.comments_html) return [];

    const text = data.comments_html
      .replace(/<[^>]+>/g, '\n')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ');

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    // The render is a flat author / date / body repetition. Dates are the only
    // reliably-shaped token, so they anchor each entry.
    const dateRe = /^[A-Z][a-z]{2} \d{1,2}(, \d{4})? @ \d{1,2}:\d{2}[ap]m$/;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!dateRe.test(lines[i])) continue;
      const author = lines[i - 1] || 'unknown';
      const body = [];
      for (let j = i + 1; j < lines.length && !dateRe.test(lines[j]); j++) {
        if (lines[j + 1] && dateRe.test(lines[j + 1])) break; // next author
        body.push(lines[j]);
      }
      if (body.length) out.push({ author, date: lines[i], text: body.join(' ').slice(0, 300) });
    }
    return out;
  } catch (err) {
    console.warn('[Zomboid] Could not fetch Workshop comments:', err?.message || err);
    return [];
  }
}

/**
 * The build the server is actually running, read from its own logs rather than
 * assumed, e.g. "42.20.0". Returns null when it can't be determined.
 */
function detectServerVersion(logDir) {
  const fs = require('fs');
  const path = require('path');
  try {
    const debug = fs.readdirSync(logDir)
      .filter((n) => n.endsWith('_DebugLog-server.txt'))
      .sort()
      .reverse()[0];
    if (!debug) return null;
    const head = fs.readFileSync(path.join(logDir, debug), 'utf8').slice(0, 200000);
    const m = /version=(\d+\.\d+(?:\.\d+)?)/i.exec(head);
    return m ? m[1] : null;
  } catch {
    return null;
  }
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
  'requested Workshop mod can be used. You are given verified metadata, the ' +
  'mod description, and recent Workshop comments from other players.\n\n' +
  'Report, in at most three short sentences:\n' +
  '1. Dependency mods named in the description.\n' +
  '2. Whether it sounds client-side or single-player only.\n' +
  '3. MOST IMPORTANTLY: whether commenters report it BROKEN, and if so whether ' +
  'they mention multiplayer/servers or the server\'s build version. Say how ' +
  'many commenters and roughly when.\n\n' +
  'Rules: rely only on what is actually written. One vague complaint is not ' +
  'evidence a mod is broken - say it is a single unconfirmed report. Comments ' +
  'asking for features, or about unrelated games, are not breakage. If nothing ' +
  'notable appears, say so in one short sentence. Do not repeat the build tag, ' +
  'subscriber count or dates from the metadata. Do not invent anything. Plain ' +
  'and factual, no roleplay, no emoji.';

// Deterministic breakage signal, so the headline verdict reflects the comments
// rather than depending on the model's prose. Deliberately crude: it only ever
// downgrades YES to MAYBE and never blocks, because a keyword match is a reason
// to look, not a conclusion.
const BREAKAGE_RE = /\b(does\s?n[o']?t work|doesn'?t work|not working|broken|unusable|crash(es|ing|ed)?|stopped working|no longer works?|does\s?n[o']?t (show|appear|spawn)|doesn'?t (show|appear|spawn)|not (showing|appearing|spawning))\b/i;
const MP_RE = /\b(multiplayer|server|mp|dedicated|coop|co-op)\b/i;

function applyCommentSignal(check, comments, server) {
  const broken = comments.filter((c) => BREAKAGE_RE.test(c.text));
  if (!broken.length) return;

  const mpRelated = broken.filter((c) => MP_RE.test(c.text)).length;
  const major = String(server.gameBuild);
  const buildRelated = broken.filter((c) => new RegExp(`\\b${major}(\\.\\d+)*\\b`).test(c.text)).length;

  let msg = `${broken.length} of ${comments.length} recent comments report problems`;
  const qualifiers = [];
  if (mpRelated) qualifiers.push(`${mpRelated} mentioning multiplayer or servers`);
  if (buildRelated) qualifiers.push(`${buildRelated} mentioning build ${major}`);
  msg += qualifiers.length ? ` (${qualifiers.join(', ')}).` : '.';

  check.warnings.push(msg);
  if (check.verdict === 'YES') check.verdict = 'MAYBE';
}

/** Short model note on the things metadata can't answer. */
async function describeCaveats(check, server, comments = []) {
  const f = check.facts;
  const commentBlock = comments.length
    ? comments.slice(0, 15).map((c) => `[${c.date}] ${c.author}: ${c.text}`).join('\n')
    : '(no comments on the Workshop page)';
  try {
    const note = await getAIResponse(
      [
        `Server runs Project Zomboid ${server.version || `Build ${server.gameBuild}`}, multiplayer, ${server.installedMods.length} mods installed.`,
        `Installed mods: ${server.installedMods.join(', ') || 'none'}`,
        '',
        `Requested mod: ${f.title}`,
        `Tags: ${f.tags.join(', ') || 'none'}`,
        `Description:\n${f.description.slice(0, 1200) || '(empty)'}`,
        '',
        `Recent Workshop comments (${comments.length} fetched):`,
        commentBlock,
      ].join('\n'),
      { rawSystemPrompt: SYSTEM_PROMPT, maxTokens: 220 }
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
  if (f.commentCount) meta.push(`${f.commentCount} comments read`);
  if (meta.length) lines.push(meta.join(' | '));

  if (f.modIds.length) lines.push(`Mod ID: \`${f.modIds.join('`, `')}\``);
  for (const b of check.blockers) lines.push(`- ${b}`);
  for (const w of check.warnings) lines.push(`- ${w}`);
  if (note) lines.push('', note);

  return lines.join('\n').slice(0, 1900);
}

/** Worst verdict wins, so one unusable mod in a post isn't hidden by a good one. */
const VERDICT_RANK = { YES: 0, MAYBE: 1, NO: 2 };

function worstVerdict(checks) {
  return checks.reduce(
    (worst, c) => (VERDICT_RANK[c.verdict] > VERDICT_RANK[worst] ? c.verdict : worst),
    'YES'
  );
}

/**
 * Full pipeline for one message's worth of links, with the assessments kept.
 *
 * The forum handler needs the verdict as data — it drives which status tag
 * gets applied to the post — so the structured results are returned alongside
 * the rendered text rather than being thrown away after formatting.
 *
 * @returns {Promise<{text: string, checks: object[], verdict: string,
 *   alreadyInstalled: boolean, ids: string[]}|null>} null when there was
 *   nothing to check
 */
async function checkRequestDetailed(text, server, { maxItems = 3 } = {}) {
  const ids = parseWorkshopIds(text).slice(0, maxItems);
  if (!ids.length) return null;

  const items = await fetchWorkshopItems(ids);
  if (!items.length) return null;

  const checks = [];
  const blocks = [];
  for (const item of items) {
    const check = assess(item, server);
    // Blocked items are already fully explained by metadata; skip the extra work.
    let note = '';
    if (check.ok) {
      const comments = await fetchComments(item.creator, item.publishedfileid);
      check.facts.commentCount = comments.length;
      applyCommentSignal(check, comments, server);
      note = await describeCaveats(check, server, comments);
    }
    checks.push(check);
    blocks.push(formatReply(check, note));
  }

  return {
    text: blocks.join('\n\n'),
    checks,
    verdict: worstVerdict(checks),
    alreadyInstalled: checks.some((c) => c.facts.alreadyInstalled),
    ids,
  };
}

/**
 * Full pipeline for one message's worth of links.
 * @returns {Promise<string|null>} reply text, or null when there was nothing to check
 */
async function checkRequest(text, server, opts = {}) {
  const result = await checkRequestDetailed(text, server, opts);
  return result ? result.text : null;
}

/**
 * What the server currently runs, read fresh from the ini each time so a mod
 * added at the nightly restart is reflected without restarting the bot.
 *
 * @param {string} iniPath
 * @param {number} gameBuild
 */
function readServerConfig(iniPath, gameBuild, logDir = null) {
  const fs = require('fs');
  const out = {
    gameBuild,
    version: logDir ? detectServerVersion(logDir) : null,
    installedWorkshopIds: [],
    installedMods: [],
  };
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
  checkRequestDetailed,
  formatReply,
  readServerConfig,
  fetchComments,
  detectServerVersion,
};
