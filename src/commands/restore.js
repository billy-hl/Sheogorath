'use strict';
/**
 * `/restore` — the player-facing, once-per-person item restore after the
 * 2026-08-31 wipe.
 *
 * WHY THIS IS PUBLIC WHEN `/pz restore` IS SHERIFF-ONLY
 * The staff version is a general tool for acting on anybody, repeatedly, and
 * belongs behind the gate. This one hands items to one account, once, ever.
 * Nobody has to wait on a moderator to get their gear back.
 *
 * It prefers the caller's verified link and falls back to a typed account name,
 * because most people never linked. A typed name is not proof of ownership, so
 * the claim is locked twice — once per Discord user and once per in-game
 * account. The worst a bad actor can do is trigger somebody else's one restore
 * early, and the items land in that person's inventory, not theirs.
 *
 * WHY ONCE, AND WHY THAT IS ENFORCED IN STATE RATHER THAN BY TRUST
 * The diff is computed against what the player is holding *right now*. Run it,
 * put everything in a crate, run it again, and you would be handed a second
 * copy — indefinitely. The one-shot claim is what stops `/restore` becoming an
 * item printer, so it is recorded in guild state and survives restarts.
 *
 * WHY PLAYERS ARE TOLD TO DROP THEIR ITEMS FIRST
 * Because of that same "against what you hold now" rule. Anything still in the
 * inventory counts as not-missing and will not come back. Somebody whose gear
 * is broken wants the broken copies gone *before* they claim, or they keep the
 * broken ones and get nothing.
 *
 * WHY BICYCLE ITEMS ARE REFUSED OUTRIGHT
 * The bike mod changed its item ids under the save on 2026-08-31, and the
 * entries in people's records now deserialise into garbage — `Bicycle.Crate`
 * stuck in a backpack slot, `Bicycle.RabbitSwampInSidecar`. Handing those back
 * recreates the exact bug this command exists to clean up. They are dropped
 * from every restore and the player is told why.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getGuildState, setGuildState } = require('../storage/state');
const identity = require('../services/zomboid/identity');
const restoreItems = require('../services/zomboid/restoreItems');
const admin = require('../services/zomboid/admin');
const { players: rconPlayers } = require('../services/zomboid/rcon');

const STATE_KEY = 'wipeRestoreClaims';
const COLOR = 0x9b59b6;

/** Items that break on load and must never be handed back. */
const REFUSE = /^Bicycle\./;

function claims(guildId) {
  return getGuildState(guildId)[STATE_KEY] || {};
}

function recordClaim(guildId, discordId, entry) {
  const all = { ...claims(guildId), [discordId]: entry };
  setGuildState(guildId, { [STATE_KEY]: all });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('restore')
    .setDescription('One time only: get back the items you were carrying before the wipe')
    .addStringOption((o) =>
      o
        .setName('account')
        .setDescription('Only if your Discord is not linked: your in-game account name')
        .setRequired(false)),

  async execute(interaction) {
    const guildId = interaction.guildId;
    // Ephemeral: the item list is long and only means anything to the caller.
    await interaction.deferReply({ flags: 64 });

    // A verified link is the trustworthy path. Typing a name is the fallback,
    // because plenty of people never linked and the alternative is them waiting
    // on a moderator who has said they cannot keep up.
    const link = identity.getLink(guildId, interaction.user.id);
    const typed = interaction.options.getString('account');
    const username = link?.username || (typed || '').trim();
    const viaLink = Boolean(link?.username);

    if (!username) {
      await interaction.editReply(
        'I cannot tell which in-game account is yours.\n\n' +
        'Either run `/character link` to link your Discord to your character, ' +
        'or run `/restore account:<your in-game account name>` — the name you ' +
        'type at the server login screen, not your character\'s roleplay name.',
      );
      return;
    }

    // Two locks, because a typed name is not proof of ownership. The per-person
    // lock stops anyone claiming twice; the per-account lock means that even if
    // somebody types a name that is not theirs, that account can still only ever
    // be restored once, and its owner is not quietly robbed of their turn.
    const store = claims(guildId);
    const already = store[interaction.user.id];
    if (already) {
      await interaction.editReply(
        `You have already used your one restore (on ${already.at}, ` +
        `${already.granted} item(s) as **${already.username}**).\n\n` +
        'It only works once per person. If something is genuinely still wrong, ' +
        'post in help and a Sheriff can look.',
      );
      return;
    }
    const claimedBySomeone = Object.values(store).find((c) => c.username === username);
    if (claimedBySomeone) {
      await interaction.editReply(
        `The account **${username}** has already had its restore ` +
        `(${claimedBySomeone.at}). Each in-game account can only be restored ` +
        'once.\n\nIf that was not you, post in help — somebody may have typed ' +
        'your account name by mistake.',
      );
      return;
    }

    const result = restoreItems.preview(guildId, username);
    if (!result.ok) {
      await interaction.editReply(`⚠️ ${result.reason}`);
      return;
    }

    const refused = result.missing.filter((m) => REFUSE.test(m.id));
    const grantable = result.missing.filter((m) => !REFUSE.test(m.id));
    const total = grantable.reduce((n, m) => n + m.count, 0);

    // Nothing to do: do NOT burn their one claim on an empty result.
    if (!total) {
      await interaction.editReply(
        `Nothing is missing from **${username}** compared with before the ` +
        'wipe, so there is nothing to give back — and I have **not** used up ' +
        'your one restore.\n\nIf your items are broken rather than missing, drop ' +
        'them on the ground first, then run `/restore` again.',
      );
      return;
    }

    if (total > restoreItems.MAX_ITEMS) {
      await interaction.editReply(
        `Your restore came back with ${total} items, which is over the ` +
        `${restoreItems.MAX_ITEMS} limit and usually means something has gone ` +
        'wrong with the comparison. Your restore has **not** been used. Please ' +
        'post in help.',
      );
      return;
    }

    let names = null;
    try {
      const online = await rconPlayers(guildId);
      names = Array.isArray(online?.names) ? online.names : null;
    } catch {
      names = null; // could not tell; fall through rather than block
    }
    if (names && !names.includes(username)) {
      await interaction.editReply(
        `You need to be **logged in to the server** for this to work — items are ` +
        'handed straight into your inventory, and there is nowhere to put them ' +
        'if you are offline.\n\nLog in as **' + username + '**, then run ' +
        '`/restore` again. Your restore has not been used.',
      );
      return;
    }

    let granted = 0;
    let failed = 0;
    for (const m of grantable) {
      try {
        await admin.giveItem(guildId, username, m.id, m.count);
        granted += 1;
      } catch {
        failed += 1;
      }
    }

    recordClaim(guildId, interaction.user.id, {
      username: username,
      at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      granted: total,
      entries: grantable.length,
    });

    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('Items restored')
      .setDescription(
        `**${granted}** of ${grantable.length} entries returned to ` +
        `**${username}** (${total} items).`,
      );

    if (failed) {
      embed.addFields({
        name: 'Some did not go through',
        value:
          `${failed} entr${failed === 1 ? 'y' : 'ies'} were refused by the server, ` +
          'usually because the item no longer exists in the current mod list.',
      });
    }
    if (refused.length) {
      embed.addFields({
        name: 'Bicycle items were deliberately skipped',
        value:
          'The bike mod changed its items and the saved ones now load as broken ' +
          'junk that cannot be dropped. Giving them back would recreate the bug. ' +
          `${refused.length} entr${refused.length === 1 ? 'y' : 'ies'} left out.`,
      });
    }
    if (!viaLink) {
      embed.addFields({
        name: 'Sent to a typed account name',
        value:
          `Items went to the in-game account **${username}**, because your ` +
          'Discord is not linked. If that is not your account, say so in help.',
      });
    }
    embed.addFields({
      name: 'This was your one restore',
      value:
        'Condition, ammo and what was inside bags are not preserved — things ' +
        'come back fresh. It cannot be run again.',
    });

    await interaction.editReply({ embeds: [embed] });
  },
};
