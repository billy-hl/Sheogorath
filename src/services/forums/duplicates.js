'use strict';
/**
 * Duplicate detection across forum posts.
 *
 * Two different problems wearing the same name. A repeated mod request is
 * decidable — two posts naming the same Workshop ID are the same request, full
 * stop — so that one is matched exactly and acted on. A repeated suggestion is
 * a judgement call, so similar titles only ever produce an advisory reply with
 * links; nothing is tagged or closed on the strength of word overlap.
 *
 * Post bodies are indexed into state.json because recovering Workshop IDs
 * means fetching each thread's starter message, and a forum with a few hundred
 * posts would otherwise re-fetch all of them on every new request. Titles come
 * free off the thread objects, so the suggestion side needs no cache at all.
 */
const { getGuildState, setGuildState } = require('../../storage/state');
const { parseWorkshopIds } = require('../zomboid/modCheck');

/** How many archived pages to walk. 100 threads a page; 5 pages is plenty. */
const ARCHIVE_PAGES = 5;

/** Jaccard overlap above which two suggestion titles are worth flagging. */
const SIMILARITY_THRESHOLD = 0.55;

/** Words carrying no signal in a suggestion title. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'to', 'of', 'for', 'in', 'on', 'is', 'it', 'be',
  'we', 'i', 'you', 'can', 'could', 'should', 'would', 'add', 'please',
  'suggestion', 'idea', 'server', 'make', 'more', 'some', 'that', 'this',
  'with', 'have', 'has', 'need', 'want', 'new',
]);

function tokenize(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Every thread in a forum, active and archived, oldest-first is not guaranteed. */
async function allThreads(channel) {
  const out = new Map();
  try {
    const active = await channel.threads.fetchActive();
    for (const [id, thread] of active.threads) out.set(id, thread);
  } catch (err) {
    console.warn('[Forums] Could not fetch active threads:', err?.message || err);
  }

  let before;
  for (let page = 0; page < ARCHIVE_PAGES; page++) {
    let batch;
    try {
      batch = await channel.threads.fetchArchived({ type: 'public', limit: 100, before });
    } catch (err) {
      console.warn('[Forums] Could not fetch archived threads:', err?.message || err);
      break;
    }
    if (!batch.threads.size) break;
    for (const [id, thread] of batch.threads) out.set(id, thread);
    if (!batch.hasMore) break;
    before = batch.threads.last()?.archivedAt ?? undefined;
    if (!before) break;
  }
  return [...out.values()];
}

function readIndex(guildId, channelId) {
  const forums = getGuildState(guildId).forums || {};
  return forums[channelId] || { posts: {} };
}

function writeIndex(guildId, channelId, index) {
  const forums = { ...(getGuildState(guildId).forums || {}) };
  forums[channelId] = index;
  setGuildState(guildId, { forums });
}

/**
 * Record one post's Workshop IDs so later requests can be matched against it.
 * Called for every vetted request, which is what keeps the index warm.
 */
function indexPost(guildId, channelId, thread, workshopIds) {
  const index = readIndex(guildId, channelId);
  index.posts[thread.id] = {
    title: thread.name,
    ids: workshopIds,
    author: thread.ownerId || null,
    at: new Date().toISOString(),
  };
  writeIndex(guildId, channelId, index);
}

/**
 * Bring the cached index up to date with the channel.
 *
 * Only threads absent from the cache have their starter message fetched, so
 * the first run pays for the whole forum and every run after it pays for
 * whatever was posted in between. Threads that have since been deleted are
 * dropped.
 */
async function refreshIndex(guildId, channel) {
  const index = readIndex(guildId, channel.id);
  const threads = await allThreads(channel);
  const live = new Set(threads.map((t) => t.id));

  for (const id of Object.keys(index.posts)) {
    if (!live.has(id)) delete index.posts[id];
  }

  let fetched = 0;
  for (const thread of threads) {
    if (index.posts[thread.id]) {
      // Titles are free and can change; keep them current.
      index.posts[thread.id].title = thread.name;
      continue;
    }
    let ids = [];
    try {
      const starter = await thread.fetchStarterMessage();
      ids = starter ? parseWorkshopIds(`${thread.name}\n${starter.content}`) : [];
      fetched++;
    } catch {
      // Starter message deleted or unreadable — index the title alone rather
      // than dropping the post out of duplicate detection entirely.
      ids = parseWorkshopIds(thread.name);
    }
    index.posts[thread.id] = {
      title: thread.name,
      ids,
      author: thread.ownerId || null,
      at: thread.createdAt ? thread.createdAt.toISOString() : null,
    };
  }

  index.scannedAt = new Date().toISOString();
  writeIndex(guildId, channel.id, index);
  if (fetched) console.log(`[Forums] Indexed ${fetched} new post(s) in #${channel.name}.`);
  return index;
}

/**
 * Posts already claiming any of these Workshop IDs.
 *
 * @returns {Promise<Array<{threadId: string, title: string, id: string}>>}
 */
async function findWorkshopDuplicates(guildId, channel, workshopIds, excludeThreadId) {
  if (!workshopIds.length) return [];
  const index = await refreshIndex(guildId, channel);

  const hits = [];
  for (const [threadId, post] of Object.entries(index.posts)) {
    if (threadId === excludeThreadId) continue;
    const shared = (post.ids || []).find((id) => workshopIds.includes(id));
    if (shared) hits.push({ threadId, title: post.title, id: shared });
  }
  return hits;
}

/**
 * Suggestions whose titles overlap enough to be worth a look.
 *
 * Titles only — no starter messages are fetched, so this is cheap enough to
 * run inline on every new post.
 *
 * @returns {Promise<Array<{threadId: string, title: string, score: number}>>}
 */
async function findSimilarSuggestions(channel, title, excludeThreadId, limit = 3) {
  const target = tokenize(title);
  if (target.size < 2) return []; // too thin to say anything useful

  const threads = await allThreads(channel);
  return threads
    .filter((t) => t.id !== excludeThreadId)
    .map((t) => ({ threadId: t.id, title: t.name, score: jaccard(target, tokenize(t.name)) }))
    .filter((m) => m.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = {
  findWorkshopDuplicates,
  findSimilarSuggestions,
  refreshIndex,
  indexPost,
  tokenize,
  jaccard,
  SIMILARITY_THRESHOLD,
};
