'use strict';
/**
 * The written word: reference channels, and hand-written notes on disk.
 *
 * The rules and the connection details already exist, in #rules and
 * #server-info, written by the people who run the place and kept current
 * because players read them. Copying them into a file here would create a
 * second copy that goes stale the first time one is edited and not the other,
 * and the stale one would be the one Sheogorath quotes. So he reads the real
 * thing.
 *
 * Two caveats that shape the code below:
 *
 *   Only channels named in config/guilds.json are ever read, and the name-based
 *   fallback matches an exact allowlist. Whatever is in a reference channel
 *   becomes what he tells people, so which channels those are is a decision that
 *   stays in the config file rather than being inferred from whatever happens to
 *   be lying around.
 *
 *   Reference channels should be ones only staff can post in. Anything written
 *   there is being handed to him as fact.
 */
const fs = require('fs');
const path = require('path');
const { getGuildConfig } = require('../../config/guilds');

const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'knowledge');
const CHANNEL_TTL_MS = 10 * 60 * 1000;
const MAX_MESSAGES = 25;
const MAX_DOC_CHARS = 4000;

/**
 * Reference channels, in the order they're offered to retrieval, and the
 * channel names each falls back to when the config doesn't name an ID.
 */
const REFERENCE_CHANNELS = [
  { key: 'rules', title: 'Server rules', names: ['rules'] },
  { key: 'serverInfo', title: 'Connection details and server info', names: ['server-info', 'serverinfo'] },
];

const channelCache = new Map(); // `${guildId}:${key}` -> { at, doc }

/**
 * Resolve a reference channel to an ID.
 *
 * The name fallback exists so this works before anyone edits the config, but it
 * only ever matches the exact names above — it will not go looking for
 * something that seems relevant.
 */
function resolveChannel(guild, spec) {
  const configured = getGuildConfig(guild.id)?.channels?.[spec.key];
  if (configured) return configured;

  const match = guild.channels.cache.find(
    (c) => c.isTextBased?.() && spec.names.includes(c.name?.toLowerCase()),
  );
  return match?.id || null;
}

/**
 * Read one reference channel into a single document.
 *
 * Pinned messages first and in full: a pin is someone saying "this is the
 * important one", which is exactly the signal worth having. Recent messages
 * follow to catch a rule added last week that nobody pinned.
 */
async function readChannel(guild, spec) {
  const cacheKey = `${guild.id}:${spec.key}`;
  const hit = channelCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CHANNEL_TTL_MS) return hit.doc;

  const channelId = resolveChannel(guild, spec);
  if (!channelId) return null;

  try {
    const channel = await guild.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return null;

    const seen = new Set();
    const parts = [];

    const take = (msg) => {
      if (!msg?.id || seen.has(msg.id)) return;
      seen.add(msg.id);
      // Embeds carry the text as often as the message body does — a rules post
      // built as an embed would otherwise read as an empty message.
      const embedText = msg.embeds
        .map((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)]
          .filter(Boolean).join('\n'))
        .join('\n');
      const text = [msg.content, embedText].filter((t) => t && t.trim()).join('\n');
      if (text.trim()) parts.push(text.trim());
    };

    // fetchPins() is the current name; fetchPinned() is deprecated but is all
    // an older discord.js has. Newer versions also wrap each entry as a pin
    // record with the message under `.message`, so both shapes are unwrapped.
    const pinned = await (channel.messages.fetchPins
      ? channel.messages.fetchPins()
      : channel.messages.fetchPinned()).catch(() => null);
    if (pinned) {
      const items = [...(pinned.items ?? pinned.values?.() ?? pinned)];
      items.reverse().forEach((entry) => take(entry?.message ?? entry));
    }

    const recent = await channel.messages.fetch({ limit: MAX_MESSAGES }).catch(() => null);
    if (recent) [...recent.values()].reverse().forEach(take);

    const body = parts.join('\n\n').slice(0, MAX_DOC_CHARS);
    if (!body.trim()) return null;

    const doc = { id: `channel:${spec.key}`, title: spec.title, body, source: `<#${channelId}>` };
    channelCache.set(cacheKey, { at: Date.now(), doc });
    return doc;
  } catch (err) {
    console.warn(`[Knowledge] Could not read #${spec.key}:`, err?.message || err);
    return hit?.doc || null;
  }
}

/** Every reference channel this guild has, as documents. */
async function channelDocs(guild) {
  if (!guild) return [];
  const docs = await Promise.all(REFERENCE_CHANNELS.map((spec) => readChannel(guild, spec)));
  return docs.filter(Boolean);
}

/**
 * Hand-written notes from `data/knowledge/`, for anything that doesn't belong in
 * a player-facing channel — the answer to a question asked weekly that nobody
 * wants pinned, a workaround for a known crash.
 *
 * One markdown file per subject. The first `# heading` is the title; an optional
 * `tags:` line adds words to match on. Files under a guild-named subdirectory
 * are read only for that guild; files at the top level are read for all of them.
 * Read fresh each time — these change by hand, rarely, and a stale answer is
 * worse than a directory listing.
 */
function fileDocs(guildId) {
  const config = getGuildConfig(guildId);
  const dirs = [KNOWLEDGE_DIR];
  if (config?.name) dirs.push(path.join(KNOWLEDGE_DIR, config.name));
  dirs.push(path.join(KNOWLEDGE_DIR, guildId));

  const docs = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // Directory doesn't exist. Perfectly normal.
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name.toLowerCase() === 'readme.md') continue; // Notes to humans, not to him.
      try {
        const raw = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        const doc = parseDoc(raw, entry.name);
        if (doc) docs.push(doc);
      } catch (err) {
        console.warn(`[Knowledge] Could not read ${entry.name}:`, err?.message || err);
      }
    }
  }
  return docs;
}

/**
 * A file with a TODO placeholder still in it is deliberately dropped rather than
 * half-used. A template someone started and didn't finish is not a fact, and
 * feeding him "TODO: connection port" would produce a confident answer built
 * around the word TODO.
 */
function parseDoc(raw, filename) {
  if (/\bTODO\b|\bFIXME\b|<fill in>/i.test(raw)) {
    console.warn(`[Knowledge] Skipping ${filename} — it still has a placeholder in it.`);
    return null;
  }

  const lines = raw.split('\n');
  const titleLine = lines.find((l) => l.startsWith('# '));
  const tagLine = lines.find((l) => /^tags:/i.test(l.trim()));
  const body = lines
    .filter((l) => l !== titleLine && l !== tagLine)
    .join('\n')
    .trim()
    .slice(0, MAX_DOC_CHARS);

  if (!body) return null;

  return {
    id: `file:${filename}`,
    title: titleLine ? titleLine.replace(/^#\s*/, '').trim() : filename.replace(/\.md$/, ''),
    tags: tagLine ? tagLine.replace(/^tags:/i, '').split(',').map((t) => t.trim()).filter(Boolean) : [],
    body,
    source: filename,
  };
}

/** Everything written down, from both sources. */
async function allDocs(guild, guildId) {
  const [channels, files] = [await channelDocs(guild), fileDocs(guildId)];
  return [...channels, ...files];
}

/** Drop the reference-channel cache, so an edited #rules is picked up at once. */
function clearChannelCache() {
  channelCache.clear();
}

module.exports = {
  allDocs,
  channelDocs,
  fileDocs,
  parseDoc,
  clearChannelCache,
  REFERENCE_CHANNELS,
  KNOWLEDGE_DIR,
};
