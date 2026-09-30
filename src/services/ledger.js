'use strict';
/**
 * The Ledger: the group's book, and Sheogorath keeps it.
 *
 * His notes and memories are about one person at a time. This is memory about
 * the group, in three parts:
 *
 *   Rulings. "Is a hotdog a sandwich" is decided once and cited ever after. He
 *   rules in chat and records it with [ACTION:ruling]. Whenever the question
 *   comes back, the ruling is in front of him, with the date he made it.
 *
 *   Bets. One member offers, and nothing is on until the other takes it with the
 *   button on the card. That click is the consent a bet between two people
 *   needs: nobody can put anyone else's name to a wager, him included. A bet
 *   with a settle-by date is chased when the date comes. It is settled when the
 *   loser says so, by clicking the winner's button; the winner's own click is
 *   only a claim, and an Owner who is not in the bet can rule either way. A UFC
 *   bet settles itself from ESPN's result, off the same scoreboard pick'em
 *   reads.
 *
 *   Quotes. Anyone can keep something somebody said, from the message's Apps
 *   menu or by asking him in a reply to it. The person quoted can strike it.
 *
 * It lives in data/ledger.json rather than guild state. It is the one record
 * meant to last for years, and state.json is rewritten on every chat message.
 */
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { getGuildConfig, guildIds, hasFeature } = require('../config/guilds');
const { jsonFile } = require('../storage/jsonFile');
const { isAdmin } = require('../utils/permissions');
const { calendarCards, parseBouts, scoreboard, easternDay } = require('./ufc');
const { parseWhen } = require('./events');

const LEDGER_FILE = path.join(__dirname, '..', '..', 'data', 'ledger.json');
const store = jsonFile(LEDGER_FILE);

const PREFIX = 'ledger:';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How often offers are lapsed, settle-by dates chased and UFC results read. */
const TICK_MINUTES = 2;

/** An offer nobody takes lapses after this, or at its settle-by date if sooner. */
const OFFER_DAYS = 7;

/** A bet still unsettled this long after its first chase is chased once more, and then left be. */
const CHASE_AGAIN_DAYS = 3;

/** A UFC bet ESPN has not settled this long after the fight's block starts is settled by hand. */
const UFC_GIVE_UP_HOURS = 24;

/** How far ahead /bet ufc offers fights, and how long that list is trusted. */
const FIGHTS_AHEAD_DAYS = 21;
const FIGHTS_TTL_MS = 30 * MINUTE_MS;

/** A settle-by date given without a time means that evening. */
const SETTLE_BY_TIME = '8pm';

const MAX_TERMS = 200;
const MAX_STAKES = 100;
const MAX_QUESTION = 200;
const MAX_VERDICT = 500;
const MAX_QUOTE = 1000;

const COLOURS = {
  offered: 0xf1c40f,
  open: 0x3498db,
  settled: 0x2ecc71,
};
const GREY = 0x95a5a6;

const unix = (ms) => Math.floor(ms / 1000);
const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;
const timeZoneOf = (guildId) => getGuildConfig(guildId)?.timeZone || 'America/Chicago';
const ledgerGuilds = () => guildIds().filter((id) => hasFeature(id, 'ledger'));
const who = (id) => `<@${id}>`;

// --- The book ------------------------------------------------------------------

/** One guild's book inside the file, with every part present. */
function bookOf(root, guildId) {
  root.guilds = root.guilds || {};
  const book = root.guilds[guildId] || (root.guilds[guildId] = {});
  book.seq = { B: 0, R: 0, Q: 0, ...book.seq };
  book.bets = book.bets || {};
  book.rulings = book.rulings || {};
  book.quotes = book.quotes || {};
  return book;
}

/** One guild's book, to read. */
function read(guildId) {
  return bookOf(store.read(), guildId);
}

/**
 * Read, change and write one guild's book in one synchronous pass. `change`
 * must not await: two clicks landing together would otherwise each read the
 * book before the other wrote it, and one of them would vanish. A throw inside
 * `change` writes nothing.
 */
function mutate(guildId, change) {
  return store.update((root) => change(bookOf(root, guildId)));
}

const nextId = (book, kind) => `${kind}${++book.seq[kind]}`;

// --- Bets: the rules -------------------------------------------------------------

const partiesOf = (bet) => [bet.by, bet.taker].filter(Boolean);
const isParty = (bet, userId) => partiesOf(bet).includes(userId);
const otherParty = (bet, userId) => (bet.by === userId ? bet.taker : bet.by);
const nameOf = (bet, userId) => bet.names?.[userId] || 'Them';
const settlesItself = (bet) => bet.kind === 'ufc' && !bet.manual;

/** When an offer can no longer be taken: the bell, for a fight; otherwise a week, or its settle-by date if sooner. */
function offerDeadline(bet) {
  if (bet.kind === 'ufc') return bet.fight.start;
  const lapse = bet.at + OFFER_DAYS * DAY_MS;
  return bet.settleBy ? Math.min(bet.settleBy, lapse) : lapse;
}

/** A settle-by date as people say it. A date with no time means that evening. */
function parseSettleBy(text, timeZone, now = Date.now()) {
  const first = parseWhen(text, timeZone, now);
  if (!first.error || !/what time/.test(first.error)) return first;
  return parseWhen(`${text} ${SETTLE_BY_TIME}`, timeZone, now);
}

function settle(bet, winner, how, now) {
  Object.assign(bet, { status: 'settled', winner, how, settledAt: now, claims: {}, offVotes: [] });
}

function voidBet(bet, reason, now) {
  Object.assign(bet, { status: 'void', reason, settledAt: now, claims: {}, offVotes: [] });
}

/** What the loser owes, said once for the card and the announcement alike. */
const owes = (bet) => (bet.stakes ? ` ${who(otherParty(bet, bet.winner))} owes ${who(bet.winner)} **${bet.stakes}**.` : '');

/**
 * Offer a bet on anything. Nothing is agreed until the other side takes it.
 *
 * @param {object} input
 * @param {string} input.by           who is offering
 * @param {string} [input.byName]
 * @param {string|null} [input.against] who it is put to; null for anyone
 * @param {string} [input.againstName]
 * @param {string} input.terms        what they say will happen
 * @param {string} [input.stakes]     what the loser owes, in their words
 * @param {string} [input.settleBy]   when it will be known, as people say it
 * @throws {Error} with a message fit to show the person offering
 */
function offerBet(guildId, input, now = Date.now()) {
  const terms = clean(input.terms, MAX_TERMS);
  if (!terms) throw new Error('a bet needs something to bet on');
  if (input.against && input.against === input.by) throw new Error('you cannot bet against yourself');

  let settleBy = null;
  if (input.settleBy && clean(input.settleBy, 80)) {
    const when = parseSettleBy(clean(input.settleBy, 80), timeZoneOf(guildId), now);
    if (when.error) throw new Error(`settle by: ${when.error}`);
    settleBy = when.at.getTime();
  }

  return mutate(guildId, (book) => {
    const bet = {
      id: nextId(book, 'B'),
      kind: 'bet',
      by: input.by,
      against: input.against || null,
      taker: null,
      names: {
        [input.by]: input.byName || null,
        ...(input.against ? { [input.against]: input.againstName || null } : {}),
      },
      terms,
      stakes: clean(input.stakes, MAX_STAKES) || null,
      settleBy,
      status: 'offered',
      at: now,
      channelId: input.channelId || null,
      messageId: null,
      claims: {},
      offVotes: [],
      chased: [],
    };
    book.bets[bet.id] = bet;
    return { ...bet };
  });
}

/**
 * Offer a bet on a UFC fight, backing one fighter. Whoever takes it has the
 * other, and ESPN's result settles it.
 *
 * @param {string} input.pick `espnId:boutId:fighterId`, from /bet ufc's list
 * @throws {Error} with a message fit to show the person offering
 */
async function offerUfcBet(guildId, input, now = Date.now()) {
  const [espnId, boutId, fighterId] = String(input.pick || '').split(':');
  if (input.against && input.against === input.by) throw new Error('you cannot bet against yourself');
  let fightList;
  try {
    fightList = await upcomingFights(now);
  } catch (err) {
    console.warn(`[Ledger] Fight list failed: ${err?.response?.status || ''} ${err?.message || err}`);
    throw new Error('ESPN could not be reached for the fight list. Try again in a minute');
  }
  const bout = fightList.find((b) => b.espnId === espnId && b.id === boutId);
  if (!bout) throw new Error('that is not a fight on an upcoming card. Pick one from the list as you type');
  if (bout.start <= now) throw new Error('that fight has already started');
  const backing = bout.fighters.find((f) => f.id === fighterId);
  if (!backing) throw new Error('pick the fighter you are backing from the list');
  const other = bout.fighters.find((f) => f.id !== fighterId);

  return mutate(guildId, (book) => {
    const bet = {
      id: nextId(book, 'B'),
      kind: 'ufc',
      by: input.by,
      against: input.against || null,
      taker: null,
      names: {
        [input.by]: input.byName || null,
        ...(input.against ? { [input.against]: input.againstName || null } : {}),
      },
      terms: `${backing.name} beats ${other.name}`,
      stakes: clean(input.stakes, MAX_STAKES) || null,
      settleBy: null,
      fight: {
        espnId,
        boutId,
        card: bout.card,
        weight: bout.weight || null,
        start: bout.start,
        fighters: bout.fighters,
        backing: backing.id,
      },
      manual: false,
      status: 'offered',
      at: now,
      channelId: input.channelId || null,
      messageId: null,
      claims: {},
      offVotes: [],
      chased: [],
    };
    book.bets[bet.id] = bet;
    return { ...bet };
  });
}

/** Record where a bet's card was posted, so it can be kept up to date. */
function attachCard(guildId, id, message) {
  mutate(guildId, (book) => {
    const bet = book.bets[id];
    if (bet) Object.assign(bet, { channelId: message.channelId, messageId: message.id });
  });
}

function betIn(book, id) {
  const bet = book.bets[id];
  if (!bet) throw new Error('that bet is no longer in the Ledger');
  return bet;
}

/**
 * Take a bet that was offered. Checked against the stored bet, never against
 * what the button said: a custom_id comes from the client.
 */
function take(guildId, id, userId, { name = null } = {}, now = Date.now()) {
  return mutate(guildId, (book) => {
    const bet = betIn(book, id);
    if (bet.status !== 'offered') throw new Error('that bet is not waiting to be taken');
    if (now >= offerDeadline(bet)) throw new Error(bet.kind === 'ufc' ? 'that fight has started' : 'that offer has lapsed');
    if (userId === bet.by) throw new Error('you cannot take your own bet');
    if (bet.against && bet.against !== userId) throw new Error('that bet was put to someone else');
    Object.assign(bet, { taker: userId, status: 'open', takenAt: now });
    bet.names = { ...bet.names, [userId]: name || bet.names?.[userId] || null };
    return { bet: { ...bet }, say: { content: `🤝 ${who(bet.by)}, ${who(userId)} took your bet. It's on.`, ping: [bet.by] } };
  });
}

/** Withdraw an offer (whoever made it) or decline one (whoever it was put to). */
function backOut(guildId, id, userId, now = Date.now()) {
  return mutate(guildId, (book) => {
    const bet = betIn(book, id);
    if (bet.status !== 'offered') throw new Error('that bet is not an open offer any more');
    if (userId === bet.by) {
      Object.assign(bet, { status: 'withdrawn', settledAt: now });
      return { bet: { ...bet } };
    }
    if (userId === bet.against) {
      Object.assign(bet, { status: 'declined', settledAt: now });
      return { bet: { ...bet }, say: { content: `${who(bet.by)}, ${who(userId)} turned your bet down.`, ping: [bet.by] } };
    }
    throw new Error(bet.against ? 'only the two people in it can back out' : 'only whoever offered it can take it back');
  });
}

/**
 * Someone clicked "<name> wins".
 *
 * The loser saying so settles it. The winner saying so is a claim the other has
 * to agree to. An Owner outside the bet rules outright; an Owner inside it is
 * just one of the two.
 */
function win(guildId, id, clickerId, winnerId, { owner = false } = {}, now = Date.now()) {
  return mutate(guildId, (book) => {
    const bet = betIn(book, id);
    if (bet.status !== 'open') throw new Error('that bet is not waiting to be settled');
    if (settlesItself(bet)) throw new Error('this one settles itself from the result');
    if (!isParty(bet, winnerId)) throw new Error('that is not one of the two in this bet');
    const loser = otherParty(bet, winnerId);

    if (clickerId === loser) {
      settle(bet, winnerId, 'conceded', now);
      return {
        bet: { ...bet },
        say: { content: `🏆 ${who(winnerId)}, ${who(loser)} concedes **${bet.id}**.${owes(bet)}`, ping: [winnerId] },
      };
    }
    if (clickerId === winnerId) {
      if (bet.claims?.[clickerId]) throw new Error('you have already said you won. It is theirs to agree');
      bet.claims = { ...bet.claims, [clickerId]: now };
      if (bet.claims[loser]) {
        return { bet: { ...bet }, say: { content: `⚖️ Both of you say you won **${bet.id}**. An Owner will have to rule.`, ping: [] } };
      }
      return {
        bet: { ...bet },
        say: {
          content: `⚖️ ${who(loser)}, ${who(clickerId)} says they won **${bet.id}**. If they did, click **${nameOf(bet, clickerId)} wins** on the card.`,
          ping: [loser],
        },
      };
    }
    if (owner) {
      settle(bet, winnerId, 'owner', now);
      return {
        bet: { ...bet },
        say: { content: `🏆 An Owner has ruled **${bet.id}** for ${who(winnerId)}.${owes(bet)}`, ping: [winnerId, loser] },
      };
    }
    throw new Error('that is not your bet');
  });
}

/** Both of them, or an Owner outside it, can call a bet off. */
function callOff(guildId, id, clickerId, { owner = false } = {}, now = Date.now()) {
  return mutate(guildId, (book) => {
    const bet = betIn(book, id);
    if (bet.status !== 'open') throw new Error('that bet is not on');
    if (isParty(bet, clickerId)) {
      const votes = new Set(bet.offVotes || []);
      if (votes.has(clickerId)) throw new Error('you have already asked. It is theirs to agree');
      votes.add(clickerId);
      bet.offVotes = [...votes];
      if (partiesOf(bet).every((p) => votes.has(p))) {
        voidBet(bet, 'both of them called it off', now);
        return { bet: { ...bet } };
      }
      const other = otherParty(bet, clickerId);
      return {
        bet: { ...bet },
        say: { content: `🕊️ ${who(other)}, ${who(clickerId)} wants to call **${bet.id}** off. Click **Call it off** if you agree.`, ping: [other] },
      };
    }
    if (owner) {
      voidBet(bet, 'an Owner called it off', now);
      return { bet: { ...bet } };
    }
    throw new Error('that is not your bet');
  });
}

/** The winner says the stakes have been paid. So can an Owner, unless they are the one who owed. */
function markPaid(guildId, id, clickerId, { owner = false } = {}, now = Date.now()) {
  return mutate(guildId, (book) => {
    const bet = betIn(book, id);
    if (bet.status !== 'settled' || !bet.stakes) throw new Error('there is nothing owed on that bet');
    if (bet.paid) throw new Error('that has already been paid');
    const loser = otherParty(bet, bet.winner);
    if (clickerId !== bet.winner && !(owner && clickerId !== loser)) {
      throw new Error(`only ${nameOf(bet, bet.winner)} can say it has been paid`);
    }
    bet.paid = now;
    return { bet: { ...bet } };
  });
}

// --- Bets: the card ----------------------------------------------------------------

function fightersOf(bet) {
  const backing = bet.fight.fighters.find((f) => f.id === bet.fight.backing);
  const other = bet.fight.fighters.find((f) => f.id !== bet.fight.backing);
  return { backing, other };
}

function statusLine(bet, now) {
  switch (bet.status) {
    case 'offered':
      return bet.against
        ? `Waiting on ${who(bet.against)} to take it, until <t:${unix(offerDeadline(bet))}:R>.`
        : `Anyone may take it, until <t:${unix(offerDeadline(bet))}:R>.`;
    case 'open': {
      if (settlesItself(bet)) return "It's on. It settles itself when ESPN has the result.";
      const claims = Object.keys(bet.claims || {});
      if (claims.length === 2) return '⚖️ Both of them say they won. An Owner will have to rule.';
      if (claims.length === 1) {
        return `⚖️ ${who(claims[0])} says they won. ${who(otherParty(bet, claims[0]))}, click their button if so.`;
      }
      if (bet.offVotes?.length) return `🕊️ ${who(bet.offVotes[0])} wants to call it off.`;
      const late = bet.settleBy && now >= bet.settleBy ? ', and past its date' : '';
      const espn = bet.manual ? 'ESPN never gave a result. ' : '';
      return `${espn}It's on${late}. The loser settles it by clicking the winner's button.`;
    }
    case 'settled': {
      const how = { owner: ' (an Owner ruled)', espn: '' }[bet.how] ?? '';
      const paid = bet.paid ? ` Paid up <t:${unix(bet.paid)}:R>.` : owes(bet);
      return `🏆 ${who(bet.winner)} won${how}.${paid}`;
    }
    case 'void': return `🤷 Off: ${bet.reason}. Nobody owes anybody.`;
    case 'declined': return `${who(bet.against)} turned it down.`;
    case 'withdrawn': return `${who(bet.by)} took it back.`;
    case 'expired': return bet.kind === 'ufc' ? 'Nobody took it before the fight.' : 'Nobody took it.';
    case 'struck': return 'Struck from the Ledger.';
    default: return '';
  }
}

function buttonsFor(bet) {
  const button = (suffix, label, style) => new ButtonBuilder()
    .setCustomId(`${PREFIX}${suffix}`)
    .setLabel(label.slice(0, 80))
    .setStyle(style);
  const row = (...buttons) => [new ActionRowBuilder().addComponents(...buttons)];

  if (bet.status === 'offered') {
    return row(
      button(`take:${bet.id}`, 'Take the bet', ButtonStyle.Success),
      button(`back:${bet.id}`, 'Back out', ButtonStyle.Secondary),
    );
  }
  if (bet.status === 'open') {
    const buttons = settlesItself(bet) ? [] : partiesOf(bet).map((id) =>
      button(`win:${bet.id}:${id}`, `${nameOf(bet, id).slice(0, 60)} wins`, ButtonStyle.Primary));
    return row(...buttons, button(`off:${bet.id}`, 'Call it off', ButtonStyle.Secondary));
  }
  if (bet.status === 'settled' && bet.stakes && !bet.paid) {
    return row(button(`paid:${bet.id}`, 'Paid up', ButtonStyle.Success));
  }
  return [];
}

/** The card for a bet, as it stands. */
function cardMessage(bet, now = Date.now()) {
  const lines = [];
  let title;
  if (bet.kind === 'ufc') {
    const { backing, other } = fightersOf(bet);
    title = `🥊 ${backing.name} vs ${other.name}`;
    lines.push(`${who(bet.by)} backs **${backing.name}**${bet.taker ? `, ${who(bet.taker)} has **${other.name}**` : ''}.`);
    lines.push(`${bet.fight.card}${bet.fight.weight ? ` · ${bet.fight.weight}` : ''} · <t:${unix(bet.fight.start)}:F>`);
  } else {
    title = `🎲 ${bet.terms}`;
    lines.push(`${who(bet.by)} says yes${bet.taker ? `, ${who(bet.taker)} says no` : bet.against ? `, put to ${who(bet.against)}` : ''}.`);
    if (bet.settleBy) lines.push(`Settle by <t:${unix(bet.settleBy)}:F> (<t:${unix(bet.settleBy)}:R>)`);
  }
  lines.push(`Stakes: **${bet.stakes || 'bragging rights'}**`, '', statusLine(bet, now));

  const embed = new EmbedBuilder()
    .setColor(COLOURS[bet.status] ?? GREY)
    .setTitle(title.slice(0, 256))
    .setDescription(lines.join('\n').slice(0, 4096))
    .setFooter({ text: `${bet.id} · kept in the Ledger` });
  return { embeds: [embed], components: buttonsFor(bet) };
}

/** The first post of a bet: the card, pinging whoever it was put to. */
function offerMessage(bet) {
  return {
    ...cardMessage(bet),
    content: bet.against ? `${who(bet.against)}, ${who(bet.by)} has a bet for you.` : undefined,
    allowedMentions: { users: bet.against ? [bet.against] : [] },
  };
}

/** The card's message, or null if it has gone. */
async function cardOf(client, bet) {
  if (!bet.channelId || !bet.messageId) return null;
  const channel = await client.channels.fetch(bet.channelId).catch(() => null);
  return channel?.messages?.fetch(bet.messageId).catch(() => null) ?? null;
}

/** Redraw a bet's card, and post anything that needs saying underneath it. */
async function redraw(client, bet, say = null) {
  const message = await cardOf(client, bet);
  if (message) await message.edit(cardMessage(bet)).catch((err) => console.warn(`[Ledger] Could not redraw ${bet.id}: ${err.message}`));
  if (!say) return;
  const payload = { content: say.content, allowedMentions: { users: say.ping || [] } };
  if (message) {
    await message.reply(payload).catch((err) => console.warn(`[Ledger] Could not post on ${bet.id}: ${err.message}`));
    return;
  }
  const channel = bet.channelId && await client.channels.fetch(bet.channelId).catch(() => null);
  await channel?.send(payload).catch((err) => console.warn(`[Ledger] Could not post about ${bet.id}: ${err.message}`));
}

// --- Bets: the buttons -------------------------------------------------------------

const isLedgerButton = (interaction) =>
  typeof interaction.customId === 'string' && interaction.customId.startsWith(PREFIX);

async function handleButton(interaction) {
  const [, kind, id, arg] = interaction.customId.split(':');
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const ctx = { owner: isAdmin(interaction.member), name: interaction.member?.displayName || interaction.user.username };

  let result;
  try {
    if (kind === 'take') result = take(guildId, id, userId, ctx);
    else if (kind === 'back') result = backOut(guildId, id, userId);
    else if (kind === 'win') result = win(guildId, id, userId, arg, ctx);
    else if (kind === 'off') result = callOff(guildId, id, userId, ctx);
    else if (kind === 'paid') result = markPaid(guildId, id, userId, ctx);
    else throw new Error('that button has gone stale');
  } catch (err) {
    return interaction.reply({ content: `❌ ${sentence(err.message)}`, flags: MessageFlags.Ephemeral });
  }

  await interaction.update(cardMessage(result.bet));
  if (result.say) {
    await interaction.message.reply({ content: result.say.content, allowedMentions: { users: result.say.ping || [] } })
      .catch((err) => console.warn(`[Ledger] Could not post on ${id}: ${err.message}`));
  }
}

// --- UFC fights ----------------------------------------------------------------------

let fights = { at: 0, list: [] };
let fightsLoading = null;

/**
 * Every fight on the cards in the next three weeks that has not started, main
 * events first within each card. Read from ESPN at most every half hour.
 */
function upcomingFights(now = Date.now()) {
  if (now - fights.at < FIGHTS_TTL_MS) return Promise.resolve(fights.list);
  if (!fightsLoading) {
    fightsLoading = calendarCards((c) => new Date(c.endDate || c.startDate).getTime() > now
      && new Date(c.startDate).getTime() < now + FIGHTS_AHEAD_DAYS * DAY_MS, parseBouts)
      .then((cards) => {
        const list = cards.flatMap((card) => card.bouts
          .filter((b) => b.state === 'pre' && !b.cancelled)
          .reverse()
          .map((b) => ({
            espnId: card.espnId,
            card: card.name,
            id: b.id,
            start: b.start,
            weight: b.weight,
            fighters: b.fighters,
          })));
        fights = { at: Date.now(), list };
        return list;
      })
      .finally(() => { fightsLoading = null; });
  }
  return fightsLoading;
}

/**
 * The fight list for /bet ufc's picker: an entry per fighter, "X to beat Y".
 * Answers from what it has within `waitMs`, so the picker never misses
 * Discord's three seconds.
 */
async function fightChoices(typed, timeZone, { now = Date.now(), waitMs = 2000 } = {}) {
  let list = fights.list;
  const pending = upcomingFights(now).catch(() => fights.list);
  if (!list.length || now - fights.at >= FIGHTS_TTL_MS) {
    list = await Promise.race([pending, new Promise((r) => setTimeout(() => r(fights.list), waitMs))]);
  }
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  const want = String(typed || '').toLowerCase().trim();
  const out = [];
  for (const bout of list) {
    if (bout.start <= now) continue;
    for (const f of bout.fighters) {
      const other = bout.fighters.find((x) => x.id !== f.id);
      const name = `${f.name} to beat ${other.name} · ${bout.card} · ${day.format(new Date(bout.start))}`;
      if (want && !name.toLowerCase().includes(want)) continue;
      out.push({ name: name.slice(0, 100), value: `${bout.espnId}:${bout.id}:${f.id}` });
    }
  }
  return out.slice(0, 25);
}

/**
 * What ESPN's latest reading of a card means for a bet on one of its fights.
 *
 * @param {object|null} card parseBouts() of the event, or null if it could not be read
 * @returns {{kind: 'wait'} | {kind: 'manual'} | {kind: 'won', winner: string}
 *   | {kind: 'void', reason: string}}
 */
function fightOutcome(bet, card, now = Date.now()) {
  const late = now >= bet.fight.start + UFC_GIVE_UP_HOURS * HOUR_MS;
  const bout = card?.bouts.find((b) => b.id === bet.fight.boutId);
  if (!bout) {
    // Gone from a card ESPN still lists: scratched. A reading with only a
    // couple of bouts left in it is a bad response, not a wave of scratches.
    if (card && card.bouts.length >= 3) return { kind: 'void', reason: 'the fight was scratched' };
    return late ? { kind: 'manual' } : { kind: 'wait' };
  }
  if (bout.cancelled) return { kind: 'void', reason: 'the fight was called off' };
  const ids = (list) => list.map((f) => f.id).sort().join(',');
  if (ids(bout.fighters) !== ids(bet.fight.fighters)) return { kind: 'void', reason: 'the matchup changed' };
  if (!bout.final) return late ? { kind: 'manual' } : { kind: 'wait' };
  const winner = bout.result?.winner;
  if (!winner) return { kind: 'void', reason: 'it ended without a winner' };
  return { kind: 'won', winner: winner === bet.fight.backing ? bet.by : bet.taker };
}

/** Every open UFC bet whose fight has started, read against ESPN and settled if it can be. */
async function settleFights(guildId, eventsOn, now) {
  const due = Object.values(read(guildId).bets)
    .filter((b) => b.status === 'open' && settlesItself(b) && now >= b.fight.start);
  const outcomes = [];
  for (const bet of due) {
    let card = null;
    try {
      const events = await eventsOn(easternDay(new Date(bet.fight.start)));
      const event = events.find((e) => String(e.id) === bet.fight.espnId);
      card = event ? parseBouts(event) : null;
    } catch (err) {
      console.warn(`[Ledger] ${guildId}: ESPN read for ${bet.id} failed: ${err?.response?.status || ''} ${err?.message || err}`);
    }
    const outcome = fightOutcome(bet, card, now);
    if (outcome.kind !== 'wait') outcomes.push({ id: bet.id, outcome });
  }
  if (!outcomes.length) return [];

  return mutate(guildId, (book) => outcomes.map(({ id, outcome }) => {
    const bet = book.bets[id];
    if (!bet || bet.status !== 'open' || !settlesItself(bet)) return null;
    const pair = partiesOf(bet);
    let say;
    if (outcome.kind === 'won') {
      settle(bet, outcome.winner, 'espn', now);
      const { backing, other } = fightersOf(bet);
      const fighter = outcome.winner === bet.by ? backing.name : other.name;
      say = { content: `🏆 ${fighter} won, so ${who(outcome.winner)} wins **${bet.id}**.${owes(bet)}`, ping: pair };
    } else if (outcome.kind === 'void') {
      voidBet(bet, outcome.reason, now);
      say = { content: `🤷 **${bet.id}** is off: ${outcome.reason}. Nobody owes anybody.`, ping: pair };
    } else {
      bet.manual = true;
      say = {
        content: `ESPN never gave a result for **${bet.id}**. ${pair.map(who).join(' ')}, the loser settles it with the winner's button.`,
        ping: pair,
      };
    }
    return { bet: { ...bet }, say };
  }).filter(Boolean));
}

// --- The tick --------------------------------------------------------------------------

/** Whether a bet's offer has lapsed, or its settle-by date is owed a chase. */
function isDue(bet, now) {
  if (bet.status === 'offered') return now >= offerDeadline(bet);
  if (bet.status !== 'open' || bet.kind !== 'bet' || !bet.settleBy || now < bet.settleBy) return false;
  const chased = bet.chased || [];
  return !chased.length || (chased.length === 1 && now >= chased[0] + CHASE_AGAIN_DAYS * DAY_MS);
}

/** Offers past their time, lapsed; settle-by dates come round, chased. */
function lapseAndChase(guildId, now) {
  // Looked at first, so a quiet tick writes nothing.
  if (!Object.values(read(guildId).bets).some((bet) => isDue(bet, now))) return [];
  return mutate(guildId, (book) => {
    const changed = [];
    for (const bet of Object.values(book.bets)) {
      if (bet.status === 'offered' && now >= offerDeadline(bet)) {
        Object.assign(bet, { status: 'expired', settledAt: now });
        changed.push({ bet: { ...bet } });
        continue;
      }
      if (bet.status !== 'open' || bet.kind !== 'bet' || !bet.settleBy || now < bet.settleBy) continue;
      const chased = bet.chased || [];
      const pair = partiesOf(bet);
      if (!chased.length) {
        bet.chased = [now];
        changed.push({
          bet: { ...bet },
          say: {
            content: `⏰ The day has come for **${bet.id}**: *${bet.terms}*. ${pair.map(who).join(' ')}, which of you won? `
              + "The loser clicks the winner's button on the card.",
            ping: pair,
          },
        });
      } else if (chased.length === 1 && now >= chased[0] + CHASE_AGAIN_DAYS * DAY_MS) {
        bet.chased = [...chased, now];
        changed.push({
          bet: { ...bet },
          say: {
            content: `⏰ **${bet.id}** is still unsettled, ${CHASE_AGAIN_DAYS} days past its date. ${pair.map(who).join(' ')}, `
              + "the Mad God's patience is not a renewable resource. Settle it.",
            ping: pair,
          },
        });
      }
    }
    return changed;
  });
}

let ticking = false;

async function tick(client, now = Date.now()) {
  if (ticking) return;
  ticking = true;
  try {
    // One ESPN read per day per pass, shared by every bet and guild in it.
    const days = new Map();
    const eventsOn = (day) => {
      if (!days.has(day)) days.set(day, scoreboard(day).then((d) => d.events || []));
      return days.get(day);
    };
    for (const guildId of ledgerGuilds()) {
      const changed = [...lapseAndChase(guildId, now), ...await settleFights(guildId, eventsOn, now)];
      for (const { bet, say } of changed) await redraw(client, bet, say);
    }
  } catch (err) {
    console.warn(`[Ledger] Tick failed: ${err?.message || err}`);
  } finally {
    ticking = false;
  }
}

function scheduleLedger(client) {
  const guilds = ledgerGuilds();
  if (!guilds.length) return;
  setInterval(() => { tick(client).catch(() => {}); }, TICK_MINUTES * MINUTE_MS);
  tick(client).catch(() => {});
  // Warm the fight list, so the first /bet ufc answers inside Discord's three seconds.
  upcomingFights().catch(() => {});
  console.log(`[Ledger] Keeping the book in ${guilds.length} guild(s): offers lapse, settle-by dates are chased, UFC bets settle from ESPN.`);
}

// --- Rulings ------------------------------------------------------------------------------

const normal = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Enter a ruling. The same question asked in the same words replaces the old
 * ruling under the same number rather than standing beside it.
 */
function addRuling(guildId, { question, verdict, by = null, byName = null, url = null }, now = Date.now()) {
  const q = clean(question, MAX_QUESTION);
  const v = clean(verdict, MAX_VERDICT);
  if (!q || !v) throw new Error('a ruling needs a question and a verdict');
  return mutate(guildId, (book) => {
    const existing = Object.values(book.rulings).find((r) => normal(r.question) === normal(q));
    const ruling = { id: existing?.id || nextId(book, 'R'), question: q, verdict: v, by, byName, url, at: now };
    book.rulings[ruling.id] = ruling;
    return { ...ruling, replaced: !!existing };
  });
}

// --- Quotes --------------------------------------------------------------------------------

/** Keep what somebody said, word for word. The same message kept twice is one quote. */
function keepQuote(guildId, input, now = Date.now()) {
  const text = String(input.text || '').trim().slice(0, MAX_QUOTE);
  if (!text) throw new Error('there are no words in that message to keep');
  return mutate(guildId, (book) => {
    const existing = Object.values(book.quotes).find((q) => q.messageId && q.messageId === input.messageId);
    if (existing) return { quote: { ...existing }, already: true };
    const quote = {
      id: nextId(book, 'Q'),
      text,
      authorId: input.authorId,
      authorName: input.authorName || null,
      channelId: input.channelId || null,
      messageId: input.messageId || null,
      url: input.url || null,
      saidAt: input.saidAt || now,
      keptBy: input.keptBy || null,
      at: now,
    };
    book.quotes[quote.id] = quote;
    return { quote: { ...quote }, already: false };
  });
}

/** Keep a Discord message. */
function keepMessage(guildId, message, keptBy) {
  return keepQuote(guildId, {
    text: message.content,
    authorId: message.author.id,
    authorName: message.member?.displayName || message.author.globalName || message.author.username,
    channelId: message.channelId,
    messageId: message.id,
    url: message.url,
    saidAt: message.createdTimestamp,
    keptBy,
  });
}

function randomQuote(guildId, authorId = null) {
  const all = Object.values(read(guildId).quotes).filter((q) => !authorId || q.authorId === authorId);
  return all.length ? all[Math.floor(Math.random() * all.length)] : null;
}

/** A quote as it is shown in the channel. */
function quoteText(quote) {
  const body = quote.text.split('\n').map((l) => `> ${l}`).join('\n');
  const link = quote.url ? `[${quote.id}](${quote.url})` : quote.id;
  return `${body}\n— **${quote.authorName || 'someone'}**, <t:${unix(quote.saidAt)}:D> · ${link}`;
}

// --- Striking ---------------------------------------------------------------------------------

/** What one member may take out of the book: their own quotes, or anything for an Owner. */
function mayStrike(entry, kind, member) {
  if (isAdmin(member)) return true;
  return kind === 'Q' && (entry.authorId === member?.id || entry.keptBy === member?.id);
}

/**
 * Take an entry out of the book.
 * @returns {{ kind: 'bet'|'ruling'|'quote', entry: object }}
 * @throws {Error} with a message fit to show the person asking
 */
function strike(guildId, id, member) {
  const key = String(id || '').trim().toUpperCase();
  const kind = key[0];
  const shelf = { B: 'bets', R: 'rulings', Q: 'quotes' }[kind];
  return mutate(guildId, (book) => {
    const entry = shelf && book[shelf][key];
    if (!entry) throw new Error(`there is nothing in the Ledger called ${key || 'that'}`);
    if (!mayStrike(entry, kind, member)) {
      throw new Error(kind === 'Q'
        ? 'only the person quoted, whoever kept it, or an Owner can strike a quote'
        : 'only an Owner can strike that');
    }
    delete book[shelf][key];
    return { kind: { B: 'bet', R: 'ruling', Q: 'quote' }[kind], entry: { ...entry } };
  });
}

/** Entries a member may strike, matching what they have typed, for the picker. */
function strikeChoices(guildId, member, typed) {
  const book = read(guildId);
  const want = String(typed || '').toLowerCase();
  const entries = [
    ...Object.values(book.quotes).map((q) => ({ kind: 'Q', entry: q, label: `"${q.text}" — ${q.authorName || 'someone'}` })),
    ...Object.values(book.rulings).map((r) => ({ kind: 'R', entry: r, label: `${r.question} — ${r.verdict}` })),
    ...Object.values(book.bets).map((b) => ({ kind: 'B', entry: b, label: `${b.terms} (${b.status})` })),
  ];
  return entries
    .filter(({ kind, entry }) => mayStrike(entry, kind, member))
    .map(({ entry, label }) => ({ name: `${entry.id} · ${label}`.replace(/\s+/g, ' ').slice(0, 100), value: entry.id }))
    .filter((c) => !want || c.name.toLowerCase().includes(want))
    .reverse()
    .slice(0, 25);
}

// --- Views ------------------------------------------------------------------------------------

/** One line per bet, for /ledger bets. */
function betLine(bet, now) {
  const pair = bet.taker ? `${who(bet.by)} vs ${who(bet.taker)}` : `${who(bet.by)} → ${bet.against ? who(bet.against) : 'anyone'}`;
  const stakes = bet.stakes ? ` · ${bet.stakes}` : '';
  const when = bet.kind === 'ufc'
    ? ` · fight <t:${unix(bet.fight.start)}:R>`
    : bet.settleBy ? ` · settle by <t:${unix(bet.settleBy)}:R>${now >= bet.settleBy ? ' ⏰' : ''}` : '';
  return `**${bet.id}** · ${pair} · *${bet.terms}*${stakes}${when}`;
}

/** Bets on, offers waiting, who owes whom, and lately settled. Optionally just one person's. */
function betsEmbed(guildId, whoId = null, now = Date.now()) {
  const all = Object.values(read(guildId).bets)
    .filter((b) => !whoId || b.by === whoId || b.taker === whoId || b.against === whoId);
  const embed = new EmbedBuilder().setColor(0x3498db).setTitle(whoId ? '📒 The Ledger: their bets' : '📒 The Ledger: bets');
  const section = (name, rows) => rows.length && embed.addFields({ name, value: rows.join('\n').slice(0, 1024) });

  section('On', all.filter((b) => b.status === 'open').map((b) => betLine(b, now)));
  section('Waiting to be taken', all.filter((b) => b.status === 'offered').map((b) => betLine(b, now)));
  section('Owed', all.filter((b) => b.status === 'settled' && b.stakes && !b.paid)
    .map((b) => `${who(otherParty(b, b.winner))} owes ${who(b.winner)} **${b.stakes}** (${b.id}, <t:${unix(b.settledAt)}:R>)`));
  section('Settled lately', all
    .filter((b) => ['settled', 'void'].includes(b.status) && now - b.settledAt < 30 * DAY_MS)
    .sort((a, b) => b.settledAt - a.settledAt)
    .slice(0, 5)
    .map((b) => (b.status === 'void'
      ? `**${b.id}** · *${b.terms}* · off`
      : `**${b.id}** · ${who(b.winner)} beat ${who(otherParty(b, b.winner))} · *${b.terms}*`)));

  if (whoId) {
    const settled = all.filter((b) => b.status === 'settled' && isParty(b, whoId));
    const won = settled.filter((b) => b.winner === whoId).length;
    embed.setDescription(`${who(whoId)}: **${won}** won, **${settled.length - won}** lost.`);
  }
  if (!embed.data.fields?.length && !embed.data.description) {
    embed.setDescription('No bets in the Ledger. `/bet offer` puts one to somebody.');
  }
  return embed;
}

/** What he has ruled, newest first, optionally only what matches `search`. */
function rulingsEmbed(guildId, search = null) {
  const want = normal(search || '').split(' ').filter(Boolean);
  const rulings = Object.values(read(guildId).rulings)
    .filter((r) => want.every((w) => normal(`${r.question} ${r.verdict}`).includes(w)))
    .sort((a, b) => b.at - a.at);
  const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle('📜 The Ledger: rulings');
  if (!rulings.length) {
    return embed.setDescription(search
      ? `Nothing ruled on that. Ask him: he will.`
      : 'The Mad God has ruled on nothing yet. Bring him an argument.');
  }
  return embed.setDescription(rulings.slice(0, 15)
    .map((r) => `**${r.id}** · *${r.question}*\n${r.verdict} · <t:${unix(r.at)}:D>`)
    .join('\n\n').slice(0, 4096));
}

// --- What he knows ------------------------------------------------------------------------------

/**
 * The Ledger for his knowledge block: rulings that bear on what was said, quotes
 * that do, and where the person talking to him stands.
 */
function ledgerFacts(guildId, { question = '', requester = null, now = Date.now() } = {}) {
  const book = read(guildId);
  const { terms } = require('./knowledge');
  const want = terms(question);
  const hits = (text) => want.reduce((n, t) => n + (String(text).toLowerCase().includes(t) ? 1 : 0), 0);
  const day = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: timeZoneOf(guildId), day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
  const short = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

  const rulings = Object.values(book.rulings);
  const quotes = Object.values(book.quotes);
  const bets = Object.values(book.bets);
  const lines = [`It holds ${rulings.length} ruling(s), ${quotes.length} kept quote(s) and `
    + `${bets.filter((b) => b.status === 'open').length} bet(s) still on.`];

  const bearing = rulings.map((r) => ({ r, n: hits(`${r.question} ${r.verdict}`) }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
  if (bearing.length) {
    lines.push("Rulings of yours that bear on this. They stand: cite them, and when you made them, rather than ruling again:");
    for (const { r } of bearing) {
      lines.push(`• ${r.id}, ${day(r.at)}${r.byName ? `, asked by ${r.byName}` : ''}: ${r.question} — ${short(r.verdict, 300)}`);
    }
  }

  const said = quotes.map((q) => ({ q, n: hits(q.text) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 2);
  const theirs = requester ? quotes.filter((q) => q.authorId === requester.id).sort((a, b) => b.saidAt - a.saidAt).slice(0, 2) : [];
  const kept = [...new Map([...said.map((x) => x.q), ...theirs].map((q) => [q.id, q])).values()];
  if (kept.length) {
    lines.push('Kept quotes worth throwing back at people:');
    for (const q of kept) lines.push(`• ${q.id}: "${short(q.text, 200)}" — ${q.authorName || 'someone'}, ${day(q.saidAt)}`);
  }

  if (requester) {
    const me = requester.id;
    const name = requester.displayName || 'they';
    const theirBets = bets.filter((b) => isParty(b, me) || b.against === me);
    const other = (b) => b.names?.[otherParty(b, me)] || b.names?.[b.against] || 'anyone';
    for (const b of theirBets.filter((x) => x.status === 'open')) {
      const late = b.settleBy && now >= b.settleBy ? `, ${Math.floor((now - b.settleBy) / DAY_MS)} day(s) past its settle-by date` : '';
      lines.push(`${name} has a bet on with ${other(b)} (${b.id}): "${b.terms}"${b.stakes ? `, for ${b.stakes}` : ''}${late}.`);
    }
    for (const b of theirBets.filter((x) => x.status === 'offered' && x.against === me)) {
      lines.push(`${b.names?.[b.by] || 'Someone'} has put a bet to ${name} (${b.id}) that ${name} has not taken: "${b.terms}".`);
    }
    for (const b of bets.filter((x) => x.status === 'settled' && x.stakes && !x.paid && isParty(x, me))) {
      lines.push(b.winner === me
        ? `${b.names?.[otherParty(b, me)] || 'Someone'} still owes ${name} ${b.stakes} (${b.id}).`
        : `${name} still owes ${b.names?.[b.winner] || 'someone'} ${b.stakes} (${b.id}), since ${day(b.settledAt)}.`);
    }
    const settled = bets.filter((b) => b.status === 'settled' && isParty(b, me));
    if (settled.length) {
      const won = settled.filter((b) => b.winner === me).length;
      lines.push(`${name}'s record in the Ledger: ${won} won, ${settled.length - won} lost.`);
    }
  }
  return lines;
}

module.exports = {
  scheduleLedger,
  isLedgerButton,
  handleButton,
  // Bets
  offerBet,
  offerUfcBet,
  attachCard,
  offerMessage,
  cardMessage,
  redraw,
  take,
  backOut,
  win,
  callOff,
  markPaid,
  fightChoices,
  upcomingFights,
  // Rulings and quotes
  addRuling,
  keepQuote,
  keepMessage,
  randomQuote,
  quoteText,
  strike,
  strikeChoices,
  // Views and knowledge
  betsEmbed,
  rulingsEmbed,
  ledgerFacts,
  // For tests.
  read,
  fightOutcome,
  lapseAndChase,
  settleFights,
  tick,
  offerDeadline,
  parseSettleBy,
  LEDGER_FILE,
};
