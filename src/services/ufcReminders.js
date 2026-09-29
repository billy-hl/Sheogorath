'use strict';
/**
 * A DM before each UFC card: everyone holding `ufc.dmRole` hears from
 * Sheogorath `ufc.dmMinutes` (default 30) before the first bout.
 *
 * The cards come from the same ESPN scoreboard services/ufc.js builds the
 * Discord events from, looked for every few hours through fight week. Their
 * start times are kept in guild state and checked once a minute, so the only
 * ESPN request near the card is one fresh read when the DMs are due, which
 * also catches a card that has moved.
 *
 * Contender Series nights are left out unless `ufc.dmContender` is true: a DM
 * every Tuesday of the summer is more than anybody signed up for.
 *
 * A card is marked as sent before the first DM goes, so a restart mid-send
 * never DMs anybody twice. A restart after the card has started sends nothing:
 * a reminder for fights already under way is only noise. Somebody with DMs
 * closed is skipped and counted in the log.
 */
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');
const { upcomingCards } = require('./ufc');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How often the week's cards are looked for, and their start times re-read. */
const SYNC_HOURS = 3;

/** A breath between DMs, so a whole role at once does not look like spam to Discord. */
const GAP_MS = 1000;

/** Cards are forgotten this long after they start. */
const KEEP_MS = 14 * 24 * HOUR_MS;

const reminderGuilds = () => guildIds().filter((id) => getGuildConfig(id)?.ufc?.dmRole);
const wanted = (cfg, card) => !card.contender || cfg.dmContender;
const at = (date) => `<t:${Math.floor(date.getTime() / 1000)}:t>`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** This guild's record: espnId -> { name, start, sent }. */
function stateOf(guildId) {
  return getGuildState(guildId).ufcReminders || {};
}

function save(guildId, record) {
  const cutoff = Date.now() - KEEP_MS;
  const kept = Object.fromEntries(Object.entries(record).filter(([, c]) => c.start > cutoff));
  setGuildState(guildId, { ufcReminders: kept });
}

/** The DM itself: the card, when each part starts in the reader's own time, and where to watch. */
function reminderText(guildId, card, minutes) {
  const lines = card.main.map((b, i) =>
    `${i === 0 && !card.contender ? '**Main event:** ' : '• '}${b.fighters.join(' vs ')}${b.weight ? ` (${b.weight})` : ''}`);
  const when = card.prelimsStart
    ? `Prelims ${at(card.prelimsStart)}, main card ${at(card.mainStart)}, on ${card.broadcast}.`
    : `Starts ${at(card.start)}, on ${card.broadcast}.`;
  const eventId = getGuildState(guildId).ufcEvents?.[card.espnId]?.eventId;
  const link = eventId ? `\n\nhttps://discord.com/events/${guildId}/${eventId}` : '';
  return `🥊 **${card.name}** starts in ${minutes} minutes.\n\n${lines.join('\n')}\n\n${when}${link}`.slice(0, 2000);
}

/** DM everyone in the role. Returns how many it reached, and how many it could not. */
async function sendTo(guild, roleId, content) {
  await guild.members.fetch().catch(() => null);
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    console.warn(`[UFC] ${guild.id}: DM role ${roleId} does not exist.`);
    return { sent: 0, failed: 0 };
  }
  let sent = 0;
  let failed = 0;
  for (const member of role.members.values()) {
    if (member.user.bot) continue;
    try {
      await member.send({ content, allowedMentions: { parse: [] } });
      sent++;
    } catch {
      failed++;
    }
    await sleep(GAP_MS);
  }
  return { sent, failed };
}

let syncing = false;

/** Follow this fight week's cards, and keep each one's start in step with ESPN until it is sent. */
async function discover() {
  const guilds = reminderGuilds();
  if (!guilds.length || syncing) return;
  syncing = true;
  try {
    let cards;
    try {
      cards = await upcomingCards();
    } catch (err) {
      console.warn(`[UFC] Reminders: ESPN lookup failed: ${err?.response?.status || ''} ${err?.message || err}`);
      return;
    }
    for (const guildId of guilds) {
      const cfg = getGuildConfig(guildId).ufc;
      const record = stateOf(guildId);
      for (const card of cards.filter((c) => wanted(cfg, c))) {
        const stored = record[card.espnId];
        if (stored?.sent) continue;
        record[card.espnId] = { name: card.name, start: card.start.getTime(), sent: null };
      }
      save(guildId, record);
    }
  } finally {
    syncing = false;
  }
}

let checking = false;

/** Any card due its DMs, sent. Outside the half hour before a card, no requests at all. */
async function check(client, now = Date.now()) {
  if (checking) return;
  checking = true;
  try {
    let fresh = null;
    for (const guildId of reminderGuilds()) {
      const cfg = getGuildConfig(guildId).ufc;
      const lead = cfg.dmMinutes * MINUTE_MS;
      const due = Object.entries(stateOf(guildId)).filter(([, c]) => !c.sent && now >= c.start - lead && now < c.start);
      if (!due.length) continue;

      // One fresh read, shared by every guild: the card may have moved, or lost a bout.
      if (!fresh) {
        try {
          fresh = await upcomingCards(new Date(now));
        } catch (err) {
          console.warn(`[UFC] Reminders: ESPN lookup failed; trying again next minute: ${err?.message || err}`);
          return;
        }
      }
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      for (const [espnId, stored] of due) {
        const card = fresh.find((c) => c.espnId === espnId);
        const record = stateOf(guildId);
        if (!card || now >= card.start.getTime()) {
          // Gone from ESPN, or already under way: nothing worth a DM.
          record[espnId] = { ...stored, sent: now };
          save(guildId, record);
          continue;
        }
        if (now < card.start.getTime() - lead) {
          // Pushed back: wait for its new time.
          record[espnId] = { ...stored, start: card.start.getTime() };
          save(guildId, record);
          continue;
        }
        record[espnId] = { ...stored, sent: now };
        save(guildId, record);

        const minutes = Math.max(1, Math.round((card.start.getTime() - now) / MINUTE_MS));
        const { sent, failed } = await sendTo(guild, cfg.dmRole, reminderText(guildId, card, minutes));
        console.log(`[UFC] ${guildId}: DMed ${sent} member(s) about "${card.name}"${failed ? `; ${failed} had DMs closed` : ''}.`);
      }
    }
  } finally {
    checking = false;
  }
}

function scheduleUfcReminders(client) {
  const guilds = reminderGuilds();
  if (!guilds.length) return;
  setInterval(() => { discover().catch(() => {}); }, SYNC_HOURS * HOUR_MS);
  setInterval(() => { check(client).catch(() => {}); }, MINUTE_MS);
  discover().then(() => check(client)).catch(() => {});
  console.log(`[UFC] DMing a role before each card in ${guilds.length} guild(s).`);
}

module.exports = { scheduleUfcReminders, discover, check, reminderText, sendTo };
