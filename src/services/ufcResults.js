'use strict';
/**
 * UFC results: every fight as it ends, in a channel of their own, told in as
 * much detail as ESPN has.
 *
 * Every card on ESPN's UFC calendar is followed, Contender Series nights
 * included: pick'em leaves those out of its season, but a result is a result.
 * The public scoreboard services/ufc.js builds the Discord events from marks
 * each bout final with its winner, so that is what is watched, once a minute
 * from a few minutes before the first bout. Outside a fight night it makes no
 * requests at all, beyond looking for the week's cards every few hours.
 *
 * The rest comes from ESPN's FightCenter feed, fetched only when there is a
 * result to tell: how it ended as people say it ("Decision (split)",
 * "Submission (rear naked choke)"), the judges' scorecards, the title if there
 * was one, the odds each fighter went in at, the referee and judges, and both
 * fighters' numbers side by side — strikes, takedowns, knockdowns, control
 * time — with their records and tale of the tape. The scoreboard says no more
 * than KO/TKO, submission or decision, and not always that, so a result
 * FightCenter has not caught up on, or a decision still without its
 * scorecards, waits a few minutes. If FightCenter is down altogether, results
 * go out plainer rather than not at all.
 *
 * Two things can only be known before a card starts, so they are read then,
 * every few hours through fight week: each fighter's record coming in, and who
 * walked in holding the belt a bout is for. After the fight ESPN may already
 * have moved them, and a record would count the night twice. With those, a
 * record is shown as it stands after the fight, and a title fight says whether
 * the belt stayed or changed hands.
 *
 * While a fight is on it has a live card of its own: the round and the clock,
 * the fight's numbers as FightCenter counts them, and the tale of the tape,
 * redrawn every thirty seconds, which is as often as FightCenter moves. It is
 * posted silently and taken down once the result is out, so the result still
 * notifies and the channel ends the night as it always has. For it FightCenter
 * is read twice a minute, but only while a card is under way.
 *
 * When the last bout is in, the whole card is posted again as one message,
 * main event first: the record of the night, for anyone who missed it.
 *
 * What was told lives in guild state, so a restart mid-card tells nothing
 * twice, and results that landed while the bot was down are caught up on its
 * return. A result is marked as told before it is sent: one lost to a Discord
 * outage stays lost, which beats the same result posted twice.
 */
const axios = require('axios');
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');
const { calendarCards, parseBouts, scoreboard, easternDay, fightWeekStart } = require('./ufc');

const FIGHTCENTER_URL = 'https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/fightcenter/';
const UFC_RED = 0xd20a0a;
const TITLE_GOLD = 0xc9a227;
const NO_RESULT_GREY = 0x80848e;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How often the week's cards are looked for, and their start times re-read. */
const SYNC_HOURS = 3;

/** How often a card under way is checked for results. */
const POLL_MINUTES = 1;

/** How often a fight's live card is redrawn. FightCenter itself moves about this often. */
const LIVE_SECONDS = 30;

/** How long before its first bout a card starts being checked. */
const LEAD_MINUTES = 5;

/** How long a result waits for FightCenter's account of it before going out without. */
const HOLD_MINUTES = 3;

/**
 * How long after its first bout a card is closed regardless. Early prelims to
 * a pay-per-view main event runs about seven hours.
 */
const GIVE_UP_HOURS = 12;

/** Finished cards are forgotten after this long. */
const KEEP_DAYS = 45;

/** The widest a cell of the stats table may be, so it still fits a phone. */
const CELL = 14;

const resultGuilds = () => guildIds().filter((id) => getGuildConfig(id)?.ufc?.results?.channel);
const fightcenterLink = (espnId) => `https://www.espn.com/mma/fightcenter/_/id/${espnId}/league/ufc`;
const capitalised = (text) => (text ? text[0].toUpperCase() + text.slice(1) : null);
const isTitle = (result) => !!result.title || /title/i.test(result.billing || '');
// Decided on the judges' cards: a decision or a draw.
const onTheCards = (method) => /^(decision|draw)/i.test(method || '');
// A decision or a draw; without a method, a fight that ended on the bell.
const wentTheDistance = (result) => onTheCards(result.method) || (!result.method && result.clock === '5:00');
// ESPN writes "D'amato" and "Mcmahon".
const properCase = (name) => name.replace(/\b(Mc|D'|O')([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase());

// --- The stored record ------------------------------------------------------

/** This guild's results record, with every part present. */
function stateOf(guildId) {
  return { cards: getGuildState(guildId).ufcResults?.cards || {} };
}

/** Read, change and write one guild's record in a single synchronous pass. `change` must not await. */
function mutate(guildId, change) {
  const record = stateOf(guildId);
  const result = change(record);
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  for (const [id, card] of Object.entries(record.cards)) {
    if (card.finished && card.finished < cutoff) delete record.cards[id];
  }
  setGuildState(guildId, { ufcResults: record });
  return result;
}

// --- Reading ESPN -----------------------------------------------------------

/**
 * One corner as FightCenter has it. Fight stats appear once the bout is under
 * way; before it, ESPN keeps career averages there under other names, so
 * `stats` stays null until the fight's own numbers exist.
 */
function cornerOf(p) {
  const a = p.athlete || {};
  const stat = (name) => p.stats?.find((s) => s.name === name)?.displayValue ?? null;
  return {
    id: String(p.id || a.id || ''),
    name: a.displayName || null,
    lastName: a.lastName || a.displayName?.split(' ').pop() || '?',
    headshot: a.headshot?.href || null,
    record: p.displayRecord || null,
    odds: p.bets?.odds?.find((o) => o.type === 'moneyline')?.values?.[0]?.odds || null,
    belts: (a.accolades || []).filter((x) => x.type === 'Belt').map((x) => x.name),
    tape: {
      age: a.age ? String(a.age) : null,
      height: a.displayHeight?.replace(/\s+/g, '') || null,
      reach: a.displayReach || null,
      stance: a.stance?.text || null,
      country: a.country || a.flag?.alt || null,
    },
    stats: stat('sigStrikes') ? {
      sig: stat('sigStrikes'),
      head: stat('headStrikes'),
      body: stat('bodyStrikes'),
      leg: stat('legStrikes'),
      total: stat('totalStrikes'),
      takedowns: stat('takedowns'),
      knockdowns: stat('knockDowns'),
      submissions: stat('submissions'),
      control: stat('timeInControl'),
    } : null,
  };
}

/**
 * FightCenter's account of each bout on a card, by bout id. Another
 * unofficial feed, so a shape change here costs detail, never a result.
 */
function parseFightcenter(data) {
  const bouts = new Map();
  for (const segment of Object.values(data?.cards || {})) {
    for (const c of segment?.competitions || []) {
      // A finish lists a placeholder "Judge 1": there were no cards to read.
      const officials = [...(c.officials || [])]
        .sort((x, y) => (x.order || 0) - (y.order || 0))
        .filter((o) => o.firstName && o.lastName && !/^judge$/i.test(o.firstName))
        .map((o) => ({ role: o.position?.name || '', name: properCase(`${o.firstName} ${o.lastName}`) }));
      const state = c.status?.type?.state || 'pre';
      bouts.set(String(c.id), {
        state,
        final: state === 'post',
        cancelled: /cancel|postpone/i.test(c.status?.type?.name || ''),
        start: new Date(c.date || c.startDate).getTime(),
        // "R2, 3:12" while it is on, in ESPN's own words.
        status: c.status?.type?.shortDetail || null,
        winner: String((c.competitors || []).find((p) => p.winner === true)?.id || '') || null,
        method: c.status?.result?.displayName || null,
        detail: c.status?.result?.displayDescription || null,
        note: c.note || null,
        title: (c.types || []).map((t) => t.text).find((t) => /title/i.test(t || '')) || null,
        scores: c.judgesScores || null,
        referee: officials.find((o) => o.role === 'Referee')?.name || null,
        judges: officials.filter((o) => o.role === 'Judge').map((o) => o.name),
        // In the scoreboard's order, so a fight is named the same way everywhere.
        corners: [...(c.competitors || [])].sort((x, y) => (x.order || 0) - (y.order || 0)).map(cornerOf),
      });
    }
  }
  return bouts;
}

async function fightcenter(espnId) {
  const res = await axios.get(FIGHTCENTER_URL + espnId, {
    params: { region: 'us', lang: 'en', contentorigin: 'espn' },
    timeout: 15000,
  });
  return parseFightcenter(res.data);
}

/**
 * What can only be read before a card: each fighter's record coming in, and
 * who holds the belt a bout is for. Bouts already under way are left out.
 * A record of 0-0-0 is ESPN not knowing it, not a debut.
 */
function snapshot(extras) {
  const out = {};
  for (const [id, x] of extras) {
    if (x.state !== 'pre') continue;
    out[id] = {
      records: Object.fromEntries(x.corners
        .filter((c) => /^\d+-\d+-\d+/.test(c.record || '') && !/^0-0-0/.test(c.record))
        .map((c) => [c.id, c.record])),
      holders: x.title
        ? x.corners.filter((c) => c.belts.some((b) => b.toLowerCase() === x.title.toLowerCase())).map((c) => c.id)
        : [],
    };
  }
  return out;
}

/**
 * Each block of the card by its start time: main card, prelims, early prelims.
 * A card that is all one block, like a Contender Series night, names none.
 */
function blockNames(bouts) {
  const starts = [...new Set(bouts.map((b) => b.start))].sort((a, b) => b - a);
  if (starts.length < 2) return new Map();
  const names = ['Main card', 'Prelims', 'Early prelims'];
  return new Map(starts.map((start, i) => [start, names[Math.min(i, names.length - 1)]]));
}

/**
 * The judges' cards, winner's score first. ESPN lists them by corner rather
 * than by winner, so they are turned to agree with the result: the winner is
 * whoever took the majority of cards.
 */
function scorecards(raw, hasWinner) {
  const cards = String(raw || '').split('|')
    .map((s) => /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(s))
    .filter(Boolean)
    .map((m) => [Number(m[1]), Number(m[2])]);
  if (!cards.length) return null;
  const flip = hasWinner && cards.filter(([a, b]) => b > a).length > cards.filter(([a, b]) => a > b).length;
  return cards.map(([a, b]) => (flip ? `${b}-${a}` : `${a}-${b}`));
}

/**
 * FightCenter's account of a bout, if it can be trusted: finished, with the
 * same winner as the scoreboard. Two feeds caught a moment apart must not tell
 * half of one result each.
 */
const agreeing = (bout, extra) => (extra?.final && extra.winner === bout.result.winner ? extra : null);

/** What is kept of a decided bout, and told from. */
function resultOf(bout, index, block, extra) {
  const fc = agreeing(bout, extra);
  const winner = bout.fighters.find((f) => f.id === bout.result.winner) || null;
  const loser = winner && bout.fighters.find((f) => f !== winner);
  return {
    id: bout.id,
    index,
    start: bout.start,
    block: block || null,
    fighters: bout.fighters.map((f) => f.name),
    ids: bout.fighters.map((f) => f.id),
    winner: winner?.name || null,
    winnerId: winner?.id || null,
    loser: loser?.name || null,
    loserId: loser?.id || null,
    method: fc?.method || capitalised(bout.result.method),
    detail: fc?.detail || null,
    round: bout.result.round,
    clock: bout.result.clock,
    // "Flyweight - Main Event - Title Fight", or the bare division without FightCenter.
    billing: fc?.note || bout.weight.replace(/^W /, "Women's ") || null,
    title: fc?.title || null,
    scores: scorecards(fc?.scores, !!winner),
    headshot: (winner && fc?.corners.find((c) => c.id === winner.id)?.headshot) || null,
  };
}

// --- What people see --------------------------------------------------------

/** "Decision - Split" as "Decision (split)", with the finishing move where there was one. */
function methodText(result) {
  const [head, ...kind] = String(result.method || '').split(' - ');
  const extra = [...kind, result.detail].filter(Boolean).map((s) => s.toLowerCase());
  return head ? `${head}${extra.length ? ` (${extra.join(', ')})` : ''}` : null;
}

/** The card's title: how it ended and when. "KO/TKO (punches) · Round 2 · 3:19", "Decision (split) · 3 rounds". */
function resultTitle(result) {
  const method = methodText(result);
  let when = null;
  if (result.round) {
    when = wentTheDistance(result)
      ? `${result.round} rounds`
      : `Round ${result.round}${result.clock ? ` · ${result.clock}` : ''}`;
  }
  if (method) return when ? `${method} · ${when}` : method;
  if (when) return wentTheDistance(result) ? `Went the distance · ${when}` : when;
  return result.winner ? 'Final' : 'No winner';
}

/** "Flyweight · Main Event · UFC Flyweight Title": the division, and what the bout was billed as. */
function billingLine(result) {
  return String(result.billing || '').split(' - ').filter(Boolean)
    .map((part) => (result.title && /^title fight$/i.test(part) ? result.title : part))
    .join(' · ') || null;
}

/** The same, cut down to a line of the full card: "KO/TKO (punches), R2 3:19". Null when there is nothing to say. */
function shortHow(result) {
  const method = methodText(result);
  if (wentTheDistance(result)) {
    const how = method || (result.round ? `${result.round} rounds` : null);
    return [how, result.scores?.join(', ')].filter(Boolean).join(' · ') || null;
  }
  const when = result.round ? `R${result.round}${result.clock ? ` ${result.clock}` : ''}` : null;
  return [method, when].filter(Boolean).join(', ') || (result.winner ? null : 'no winner');
}

/** Plain text, so a notification says who won, and whether a belt changed hands. */
function headline(result, before) {
  if (!result.winner) return `➖ ${result.fighters.join(' vs ')} · ${methodText(result) || 'no winner'}`;
  const won = `**${result.winner}** def. ${result.loser}`;
  if (!isTitle(result)) return `🏆 ${won}`;
  if (!result.title) return `👑 ${won}`;
  const holders = before?.holders || [];
  if (holders.includes(result.loserId)) return `👑 **New champion!** ${won} for the ${result.title}`;
  if (holders.includes(result.winnerId)) return `👑 ${won} and keeps the ${result.title}`;
  return `👑 ${won} for the ${result.title}`;
}

/** Winner first; with no winner, in ESPN's order. */
const cornerOrder = (result) => (result.winnerId ? [result.winnerId, result.loserId] : result.ids);

/**
 * The small labelled tiles under the title: the judges' cards, the moneyline
 * each went in at as ESPN carried it (and whether the underdog won), and the
 * referee. The judges themselves go at the foot, well away from the cards:
 * ESPN does not say which judge gave which, and side by side they would look
 * as though it did.
 */
function tiles(result, fc) {
  const out = [];
  if (result.scores) out.push({ name: 'Scorecards', value: result.scores.join('\n'), inline: true });
  const corners = cornerOrder(result).map((id) => fc?.corners.find((c) => c.id === id));
  if (corners.every((c) => c?.odds)) {
    const price = (odds) => Number(String(odds).replace('+', ''));
    const upset = result.winnerId && price(corners[0].odds) > price(corners[1].odds);
    const lines = corners.map((c) => `${c.lastName} ${c.odds}`);
    out.push({ name: 'Odds', value: [...lines, upset && '*Underdog won*'].filter(Boolean).join('\n'), inline: true });
  }
  if (fc?.referee) out.push({ name: 'Referee', value: fc.referee, inline: true });
  return out;
}

/** A record as it stands after tonight: one more win, loss or draw. A no contest leaves it alone. */
function recordAfter(record, outcome) {
  const m = /^(\d+)-(\d+)-(\d+)(.*)$/.exec(record || '');
  if (!m) return null;
  const [w, l, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const next = { W: [w + 1, l, d], L: [w, l + 1, d], D: [w, l, d + 1] }[outcome] || [w, l, d];
  return `${next.join('-')}${m[4]}`;
}

/**
 * The fight's numbers and the tale of the tape, each a table with both
 * fighters side by side, winner first. Code blocks, so the columns line up on
 * a phone as well as a desktop; the two share their column widths, so one sits
 * squarely under the other. Rows neither fighter has a value for are left out,
 * and a table with no rows left is not drawn.
 */
function tables(result, fc, before) {
  const corners = cornerOrder(result).map((id) => fc?.corners.find((c) => c.id === id) || null);
  if (!corners.every(Boolean)) return { stats: null, tape: null };
  const landed = (v) => (v ? String(v).split('/')[0] : null);
  const accuracy = (v) => {
    const [hit, thrown] = String(v || '').split('/').map(Number);
    return thrown ? `${Math.round((hit / thrown) * 100)}%` : null;
  };
  const outcome = (id) => {
    if (result.winnerId) return id === result.winnerId ? 'W' : 'L';
    return /^draw/i.test(result.method || '') ? 'D' : null;
  };
  const cell = (v) => (v ? String(v) : '—').slice(0, CELL);
  const row = (label, value) => [label, ...corners.map((c) => value(c))];
  const kept = (rows) => rows.filter((r) => r[1] || r[2]).map((r) => [r[0], cell(r[1]), cell(r[2])]);
  const stats = kept([
    row('Sig. strikes', (c) => c.stats?.sig),
    row('  Accuracy', (c) => accuracy(c.stats?.sig)),
    row('  Head', (c) => landed(c.stats?.head)),
    row('  Body', (c) => landed(c.stats?.body)),
    row('  Leg', (c) => landed(c.stats?.leg)),
    row('Total strikes', (c) => c.stats?.total),
    row('Takedowns', (c) => c.stats?.takedowns),
    row('Knockdowns', (c) => c.stats?.knockdowns),
    row('Sub attempts', (c) => c.stats?.submissions),
    row('Control time', (c) => c.stats?.control),
  ]);
  const tape = kept([
    row('Record', (c) => recordAfter(before?.records?.[c.id], outcome(c.id))),
    row('Age', (c) => c.tape.age),
    row('Height', (c) => c.tape.height),
    row('Reach', (c) => c.tape.reach),
    row('Stance', (c) => c.tape.stance),
    row('Country', (c) => c.tape.country),
  ]);

  const head = ['', ...corners.map((c) => cell(c.lastName))];
  const width = (i) => Math.max(head[i].length, ...[...stats, ...tape].map((r) => r[i].length));
  const line = (r) => `${r[0].padEnd(width(0))}  ${r[1].padStart(width(1))}  ${r[2].padStart(width(2))}`.trimEnd();
  const rule = line(['', '─'.repeat(width(1)), '─'.repeat(width(2))]);
  const draw = (rows) => (rows.length ? ['```', line(head), rule, ...rows.map(line), '```'].join('\n') : null);
  return { stats: draw(stats), tape: draw(tape) };
}

/**
 * One result, as it happens, as a single card: how it ended as the title and
 * the billing under it, tiles for the cards, the odds and the referee, then
 * the fight's numbers and the tale of the tape under headings of their own,
 * and the judges at the foot.
 */
function resultMessage(card, espnId, result, fc, before) {
  const embed = new EmbedBuilder()
    .setColor(!result.winner ? NO_RESULT_GREY : isTitle(result) ? TITLE_GOLD : UFC_RED)
    .setAuthor({ name: [card.name, result.block].filter(Boolean).join(' · ').slice(0, 256), url: fightcenterLink(espnId) })
    .setTitle(resultTitle(result).slice(0, 256));
  const billing = billingLine(result);
  if (billing) embed.setDescription(billing);
  if (result.headshot) embed.setThumbnail(result.headshot);
  const { stats, tape } = tables(result, fc, before);
  embed.addFields(
    ...tiles(result, fc),
    ...(stats ? [{ name: 'Fight stats', value: stats }] : []),
    ...(tape ? [{ name: 'Tale of the tape', value: tape }] : []),
  );
  if (fc?.judges?.length) embed.setFooter({ text: `Judges: ${fc.judges.join(', ')}` });
  return { content: headline(result, before), embeds: [embed], allowedMentions: { parse: [] } };
}

/** "Round 2 · 3:12 left", or ESPN's own words between rounds. */
function liveTitle(fc) {
  if (fc.state === 'post') return 'Fight over · the result is on its way';
  const m = /^R(\d+),\s*(\d+:\d\d)$/.exec(fc.status || '');
  return m ? `Round ${m[1]} · ${m[2]} left` : fc.status || 'Under way';
}

/**
 * A fight while it is on, redrawn every LIVE_SECONDS until its result takes
 * over: the round and clock as the title, then what a result card carries so
 * far, in the scoreboard's corner order since nobody has won yet.
 */
function liveMessage(card, espnId, fc, block, before, now = Date.now()) {
  const fight = { ids: fc.corners.map((c) => c.id), winnerId: null, scores: null, method: null, billing: fc.note, title: fc.title };
  const embed = new EmbedBuilder()
    .setColor(isTitle(fight) ? TITLE_GOLD : UFC_RED)
    .setAuthor({ name: [card.name, block].filter(Boolean).join(' · ').slice(0, 256), url: fightcenterLink(espnId) })
    .setTitle(liveTitle(fc).slice(0, 256))
    .setFooter({ text: `Live from ESPN every ${LIVE_SECONDS} seconds, a little behind the broadcast` })
    .setTimestamp(now);
  const billing = billingLine(fight);
  if (billing) embed.setDescription(billing);
  const { stats, tape } = tables(fight, fc, before);
  embed.addFields(
    ...tiles(fight, fc),
    { name: 'Fight stats', value: stats || 'Waiting on ESPN for the first numbers.' },
    ...(tape ? [{ name: 'Tale of the tape', value: tape }] : []),
  );
  const [a, b] = fc.corners.map((c) => c.name || c.lastName);
  return { content: `${fc.state === 'post' ? '🏁' : '🔴'} **${a}** vs **${b}**`, embeds: [embed], allowedMentions: { parse: [] } };
}

/** The whole card once it is over: main card first, each block with its main event on top. */
function summaryMessage(card, espnId) {
  const starts = [...new Set(card.results.map((r) => r.start))].sort((a, b) => b - a);
  const sections = starts.map((start) => {
    const rows = card.results.filter((r) => r.start === start).sort((a, b) => b.index - a.index);
    const lines = rows.map((r) => {
      const who = r.winner ? `**${r.winner}** def. ${r.loser}` : r.fighters.join(' vs ');
      const how = shortHow(r);
      return `${isTitle(r) ? '👑 ' : ''}${who}${how ? ` · ${how}` : ''}`;
    });
    return [rows[0].block && `__${rows[0].block}__`, ...lines].filter(Boolean).join('\n');
  });
  const fights = card.results.length;
  const finishes = card.results.filter((r) => r.winner && /^(ko|tko|submission)/i.test(r.method || '')).length;
  const embed = new EmbedBuilder()
    .setColor(UFC_RED)
    .setTitle(`🏁 ${card.name} · Full results`.slice(0, 256))
    .setURL(fightcenterLink(espnId))
    .setDescription(sections.join('\n\n').slice(0, 4096))
    .setFooter({ text: `${fights} fight${fights === 1 ? '' : 's'} · ${finishes} finish${finishes === 1 ? '' : 'es'}` });
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

// --- The loops --------------------------------------------------------------

/**
 * When each result still waiting on FightCenter was first seen, so the wait
 * has an end. Kept in memory: a restart only ends the wait sooner.
 */
const firstSeen = new Map();

const resultsChannel = async (client, guildId) => {
  const channelId = getGuildConfig(guildId)?.ufc?.results?.channel;
  return (channelId && await client.channels.fetch(channelId).catch(() => null)) || null;
};

/** Take a fight's live card down: its result is out, or there is nothing left to show. */
async function dropLive(channel, guildId, espnId, boutId) {
  const messageId = mutate(guildId, (record) => {
    const live = record.cards[espnId]?.live;
    const id = live?.[boutId];
    if (live) delete live[boutId];
    return id;
  });
  if (messageId) await channel.messages.delete(messageId).catch(() => {});
}

/**
 * One look at a card under way: each newly decided bout told, and the whole
 * card posted once the last is in.
 *
 * `sources` reads ESPN and is shared across a pass, so two guilds on the same
 * card cost one request each way.
 */
async function pollCard(client, guildId, espnId, sources, now = Date.now()) {
  const before = stateOf(guildId).cards[espnId];
  if (!before || before.finished) return;
  const channel = await resultsChannel(client, guildId);
  if (!channel) {
    console.warn(`[UFC] ${guildId}: results channel ${getGuildConfig(guildId)?.ufc?.results?.channel} is unreachable.`);
    return;
  }

  const events = await sources.eventsOn(easternDay(new Date(before.start)));
  const event = events.find((e) => String(e.id) === espnId);
  const bouts = (event && parseBouts(event))?.bouts || [];
  const told = new Set(before.results.map((r) => r.id));

  // Decided and not yet told, in the order they were fought.
  const decided = bouts.filter((b) => b.final && !b.cancelled && !told.has(b.id));
  const extras = decided.length ? await sources.detailsFor(espnId) : null;
  const ready = decided.filter((b) => {
    const extra = extras?.get(b.id);
    // Told in full: how it ended, and for a decision, the cards.
    if (extra?.final && extra.method && (!onTheCards(extra.method) || extra.scores)) return true;
    // FightCenter is down, so there is no detail worth waiting for.
    if (!extras && b.result.method) return true;
    if (!firstSeen.has(b.id)) firstSeen.set(b.id, now);
    return now - firstSeen.get(b.id) >= HOLD_MINUTES * MINUTE_MS;
  });

  const blocks = blockNames(bouts);
  let closing = false;
  const { card, fresh } = mutate(guildId, (record) => {
    const stored = record.cards[espnId];
    if (!stored || stored.finished) return { card: null, fresh: [] };
    // A reply missing most of the card is taken for a bad one, and closes nothing.
    const whole = bouts.length > 0 && bouts.length >= Math.ceil(stored.size / 2);
    if (whole) stored.size = bouts.length;
    const known = new Set(stored.results.map((r) => r.id));
    const out = ready.filter((b) => !known.has(b.id))
      .map((b) => resultOf(b, bouts.indexOf(b), blocks.get(b.start), extras?.get(b.id)));
    stored.results.push(...out);
    out.forEach((r) => known.add(r.id));
    const over = whole && bouts.every((b) => b.cancelled || known.has(b.id));
    if (over || now >= stored.start + GIVE_UP_HOURS * HOUR_MS) {
      stored.finished = now;
      closing = true;
    }
    return { card: stored, fresh: out };
  });
  if (!card) return;

  for (const result of fresh) {
    firstSeen.delete(result.id);
    const bout = bouts.find((b) => b.id === result.id);
    const fc = agreeing(bout, extras?.get(result.id));
    await channel.send(resultMessage(card, espnId, result, fc, card.before?.[result.id])).catch((err) =>
      console.warn(`[UFC] ${guildId}: could not post a result from "${card.name}": ${err.message}`));
    await dropLive(channel, guildId, espnId, result.id);
  }
  if (fresh.length) console.log(`[UFC] ${guildId}: told ${fresh.length} result(s) from "${card.name}".`);

  if (closing) {
    bouts.forEach((b) => firstSeen.delete(b.id));
    for (const id of Object.keys(stateOf(guildId).cards[espnId]?.live || {})) await dropLive(channel, guildId, espnId, id);
    // A card that closed with nothing told, cancelled or never reported, has nothing to sum up.
    if (!card.results.length) return;
    await channel.send(summaryMessage(card, espnId)).catch((err) =>
      console.warn(`[UFC] ${guildId}: could not post the full results of "${card.name}": ${err.message}`));
    console.log(`[UFC] ${guildId}: posted the full results of "${card.name}".`);
  }
}

/**
 * One card's live cards brought up to date: one posted for a fight that has
 * begun, each one up redrawn, and any whose fight is told, scratched or gone
 * from ESPN taken down. A fight over but not yet told keeps its card, marked
 * as over, until the result replaces it; one that starts and ends between two
 * looks never gets one.
 *
 * `read` is FightCenter for a card, shared across a pass; null when it could
 * not be read, and then what is up stays as it is.
 */
async function liveCard(client, guildId, espnId, read, now = Date.now()) {
  const channel = await resultsChannel(client, guildId);
  if (!channel) return;
  const extras = stateOf(guildId).cards[espnId]?.finished ? new Map() : await read(espnId);
  const card = stateOf(guildId).cards[espnId];
  if (!extras || !card) return;

  const live = card.live || {};
  const told = new Set(card.results.map((r) => r.id));
  const showing = (id) => {
    const x = extras.get(id);
    if (!x || card.finished || told.has(id) || x.cancelled) return false;
    return x.state === 'in' || (x.state === 'post' && !!live[id]);
  };
  for (const id of Object.keys(live)) {
    if (!showing(id)) await dropLive(channel, guildId, espnId, id);
  }

  const blocks = blockNames([...extras.values()]);
  for (const [id, x] of extras) {
    if (!showing(id)) continue;
    const message = liveMessage(card, espnId, x, blocks.get(x.start), card.before?.[id], now);
    if (live[id]) {
      await channel.messages.edit(live[id], message).catch((err) => {
        // Deleted by hand: forgotten, so the next look posts it afresh.
        if (err.code === 10008) {
          mutate(guildId, (record) => { delete record.cards[espnId]?.live?.[id]; });
        } else console.warn(`[UFC] ${guildId}: could not redraw a live card from "${card.name}": ${err.message}`);
      });
      continue;
    }
    const sent = await channel.send({ ...message, flags: MessageFlags.SuppressNotifications }).catch((err) => {
      console.warn(`[UFC] ${guildId}: could not post a live card from "${card.name}": ${err.message}`);
      return null;
    });
    if (sent) {
      mutate(guildId, (record) => {
        const stored = record.cards[espnId];
        if (stored) stored.live = { ...stored.live, [id]: sent.id };
      });
    }
  }
}

let liveWatching = false;

/** Every fight under way, its live card redrawn. Outside a fight night, no requests at all. */
async function watchLive(client, now = Date.now()) {
  if (liveWatching) return;
  liveWatching = true;
  try {
    const details = new Map();
    // A failed read is not logged here: twice a minute through an outage would
    // drown the log, and the results loop says so when it needs FightCenter.
    const read = (espnId) => {
      if (!details.has(espnId)) details.set(espnId, fightcenter(espnId).catch(() => null));
      return details.get(espnId);
    };
    for (const guildId of resultGuilds()) {
      for (const [espnId, card] of Object.entries(stateOf(guildId).cards)) {
        const underWay = !card.finished && now >= card.start - LEAD_MINUTES * MINUTE_MS;
        if (!underWay && !Object.keys(card.live || {}).length) continue;
        await liveCard(client, guildId, espnId, read, now).catch((err) =>
          console.warn(`[UFC] ${guildId}: live card for "${card.name}" failed: ${err?.message || err}`));
      }
    }
  } finally {
    liveWatching = false;
  }
}

let watching = false;

/** Every card under way, checked for results. Outside a fight night, no requests at all. */
async function watch(client, now = Date.now()) {
  if (watching) return;
  watching = true;
  try {
    const days = new Map();
    const details = new Map();
    const sources = {
      eventsOn: (day) => {
        if (!days.has(day)) days.set(day, scoreboard(day).then((d) => d.events || []));
        return days.get(day);
      },
      detailsFor: (espnId) => {
        if (!details.has(espnId)) {
          details.set(espnId, fightcenter(espnId).catch((err) => {
            console.warn(`[UFC] FightCenter for ${espnId} failed; results go out plainer: ${err?.response?.status || ''} ${err?.message || err}`);
            return null;
          }));
        }
        return details.get(espnId);
      },
    };
    for (const guildId of resultGuilds()) {
      for (const [espnId, card] of Object.entries(stateOf(guildId).cards)) {
        if (card.finished || now < card.start - LEAD_MINUTES * MINUTE_MS) continue;
        await pollCard(client, guildId, espnId, sources, now).catch((err) =>
          console.warn(`[UFC] ${guildId}: results for "${card.name}" failed: ${err?.response?.status || ''} ${err?.message || err}`));
      }
    }
  } finally {
    watching = false;
  }
}

let discovering = false;

/**
 * Follow this fight week's cards, keep each one's start in step with ESPN
 * until it begins, and read what can only be read before it does.
 */
async function discover(now = new Date(), readBefore = fightcenter) {
  const guilds = resultGuilds();
  if (!guilds.length || discovering) return;
  discovering = true;
  try {
    let cards;
    try {
      cards = await calendarCards((c) => new Date(c.endDate || c.startDate) > now
        && fightWeekStart(new Date(c.startDate)) <= now, parseBouts);
    } catch (err) {
      console.warn(`[UFC] Results: ESPN lookup failed: ${err?.response?.status || ''} ${err?.message || err}`);
      return;
    }
    const snapshots = new Map();
    for (const parsed of cards) {
      if (now.getTime() >= Math.min(...parsed.bouts.map((b) => b.start))) continue;
      try {
        snapshots.set(parsed.espnId, snapshot(await readBefore(parsed.espnId)));
      } catch (err) {
        console.warn(`[UFC] Results: FightCenter before "${parsed.name}" failed: ${err?.response?.status || ''} ${err?.message || err}`);
      }
    }
    for (const guildId of guilds) {
      const added = mutate(guildId, (record) => {
        const names = [];
        for (const parsed of cards) {
          const fields = { name: parsed.name, start: Math.min(...parsed.bouts.map((b) => b.start)), size: parsed.bouts.length };
          if (snapshots.has(parsed.espnId)) fields.before = snapshots.get(parsed.espnId);
          const card = record.cards[parsed.espnId];
          if (!card) {
            record.cards[parsed.espnId] = { before: {}, ...fields, results: [], finished: null };
            names.push(parsed.name);
          } else if (!card.finished && now.getTime() < card.start) {
            // Until its first bout, a card follows ESPN; after, it is watched from where it began.
            Object.assign(card, fields);
          }
        }
        return names;
      });
      for (const name of added) console.log(`[UFC] ${guildId}: following "${name}" for results.`);
    }
  } finally {
    discovering = false;
  }
}

function scheduleUfcResults(client) {
  const guilds = resultGuilds();
  if (!guilds.length) return;
  setInterval(() => { discover().catch(() => {}); }, SYNC_HOURS * HOUR_MS);
  setInterval(() => { watch(client).catch(() => {}); }, POLL_MINUTES * MINUTE_MS);
  setInterval(() => { watchLive(client).catch(() => {}); }, LIVE_SECONDS * 1000);
  discover().then(() => watch(client)).catch(() => {});
  console.log(`[UFC] Posting results to ${guilds.length} guild(s), checked every ${POLL_MINUTES}m while a card is under way, `
    + `with a live card per fight redrawn every ${LIVE_SECONDS}s.`);
}

module.exports = {
  scheduleUfcResults,
  // For tests and scripts.
  discover,
  watch,
  watchLive,
  pollCard,
  liveCard,
  liveMessage,
  fightcenter,
  parseFightcenter,
  snapshot,
  scorecards,
  resultOf,
  resultMessage,
  summaryMessage,
  tables,
  resultTitle,
  shortHow,
  stateOf,
};
