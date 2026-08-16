'use strict';
/**
 * `/character` — the player-facing half of the roleplay character sheets.
 *
 * `/pz info` already reports a character's skills and survival time, but it is
 * Sheriff-gated, because it sits beside teleport and kick. This is its public
 * sibling: the same facts, only about characters people have chosen to write up,
 * with the story attached.
 *
 * Nothing here trusts a typed name. Every write goes through the Steam ID on the
 * caller's verified link, so the only character a player can edit is one they
 * have proved in-game that they hold.
 */
const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
} = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const { isStaff } = require('../utils/permissions');
const identity = require('../services/zomboid/identity');
const sheets = require('../services/zomboid/characterSheet');
const { lookupPlayer } = require('../services/zomboid/players');

const MODAL_ID = 'character:sheet';
const COLOR = 0x7a8b6f;

/** Build the authoring modal, prefilled with whatever the player wrote last. */
function buildModal(existingFields = {}) {
  const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('Your character');

  for (const field of sheets.FIELDS) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setMaxLength(field.maxLength)
      .setRequired(field.required);

    if (field.placeholder) input.setPlaceholder(field.placeholder);
    const prior = existingFields[field.id];
    if (prior) input.setValue(String(prior).slice(0, field.maxLength));

    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  return modal;
}

/** The reply every path uses when the guild has no sheets set up. */
const NOT_CONFIGURED =
  'Character sheets are not set up on this server yet. An admin needs to run ' +
  '`/forums apply` to create the characters forum.';

const NOT_LINKED =
  'Your Discord account is not linked to a game account yet. Run `/character link` ' +
  'first — it takes about a minute and happens in-game.';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('character')
    .setDescription('Roleplay character sheets')
    .addSubcommand((s) =>
      s
        .setName('link')
        .setDescription('Link your Discord to your in-game account'))
    .addSubcommand((s) =>
      s
        .setName('sheet')
        .setDescription('Write or edit your character sheet'))
    .addSubcommand((s) =>
      s
        .setName('refresh')
        .setDescription('Update your sheet with your latest survival stats'))
    .addSubcommand((s) =>
      s
        .setName('view')
        .setDescription("Look up someone's character")
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Character name')
            .setRequired(true)
            .setAutocomplete(true)))
    .addSubcommand((s) =>
      s
        .setName('whois')
        .setDescription('Which character a Discord member plays')
        .addUserOption((o) =>
          o.setName('member').setDescription('Who to look up').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('unlink')
        .setDescription('Unlink a game account (yours, or anyone\'s if you are staff)')
        .addUserOption((o) =>
          o
            .setName('member')
            .setDescription('Whose link to remove — staff only, defaults to you')
            .setRequired(false))),

  /** Character names of everyone with a live sheet. */
  async autocomplete(interaction) {
    let choices = [];
    try {
      const query = interaction.options.getFocused().toLowerCase();
      choices = identity
        .allSheets(interaction.guildId)
        .filter((s) => (s.name || '').toLowerCase().includes(query))
        .slice(0, 25)
        .map((s) => ({ name: s.name.slice(0, 100), value: s.name.slice(0, 100) }));
    } catch (err) {
      console.warn('[Characters] Autocomplete failed:', err?.message || err);
    }
    await interaction.respond(choices).catch(() => {});
  },

  async execute(interaction) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    // showModal has to be the first response to an interaction — it cannot
    // follow a deferReply — so `sheet` is routed before anything defers.
    if (sub === 'sheet') return openSheetModal(interaction, guildId);

    // `view` is the one people run to point at someone in conversation, so it
    // answers in the channel. Everything else is about the caller's own account.
    await interaction.deferReply(sub === 'view' ? {} : { flags: 64 });

    switch (sub) {
      case 'link':
        return handleLink(interaction, guildId);
      case 'unlink':
        return handleUnlink(interaction, guildId);
      case 'refresh':
        return handleRefresh(interaction, guildId);
      case 'view':
        return handleView(interaction, guildId);
      case 'whois':
        return handleWhois(interaction, guildId);
      default:
        return interaction.editReply('Unknown subcommand.');
    }
  },

  /** Routed from the InteractionCreate handler in index.js. */
  async handleModal(interaction) {
    if (interaction.customId !== MODAL_ID) return;
    await interaction.deferReply({ flags: 64 });

    const guildId = interaction.guildId;
    const link = identity.getLink(guildId, interaction.user.id);
    if (!link) return interaction.editReply(NOT_LINKED);

    const fields = {};
    for (const field of sheets.FIELDS) {
      fields[field.id] = (interaction.fields.getTextInputValue(field.id) || '').trim();
    }

    try {
      const { thread, created } = await sheets.upsertSheet(interaction.client, guildId, {
        discordId: interaction.user.id,
        steamid: link.steamid,
        username: link.username,
        fields,
      });

      await interaction.editReply(
        `${created ? '📋 Sheet posted' : '✏️ Sheet updated'}: <#${thread.id}>\n` +
        'Your survival stats refresh with `/character refresh`.',
      );
    } catch (err) {
      console.error('[Characters] Sheet write failed:', err?.message || err);
      await interaction.editReply(`❌ ${err.message}`);
    }
  },
};

async function openSheetModal(interaction, guildId) {
  if (!sheets.sheetConfig(guildId)) {
    return interaction.reply({ content: NOT_CONFIGURED, flags: 64 });
  }

  const link = identity.getLink(guildId, interaction.user.id);
  if (!link) return interaction.reply({ content: NOT_LINKED, flags: 64 });

  // Deliberately not derived here: resolving the character reads the save and
  // walks the PerkLog, and a modal has to be shown inside Discord's three-second
  // interaction window. The write path does the lookup instead.
  const existing = identity.getSheet(guildId, link.steamid);
  return interaction.showModal(buildModal(existing?.fields || {}));
}

async function handleLink(interaction, guildId) {
  const zomboid = getGuildConfig(guildId)?.zomboid;
  if (!zomboid?.logDir || !zomboid?.playersDb) {
    return interaction.editReply('This server has no Project Zomboid save configured.');
  }

  const existing = identity.getLink(guildId, interaction.user.id);
  if (existing) {
    const character = lookupPlayer(zomboid.playersDb, { steamid: existing.steamid });
    return interaction.editReply(
      `You are already linked to **${existing.username}**` +
      `${character?.name ? ` — playing **${character.name}**` : ''}.\n` +
      'Run `/character unlink` first if you need to change it.',
    );
  }

  const { code, expiresAt } = identity.startVerification(guildId, interaction.user.id);
  const minutes = Math.round((expiresAt - Date.now()) / 60000);

  return interaction.editReply(
    `**Say this in-game to prove the account is yours:**\n` +
    `# ${code}\n` +
    `Log into the server and type it in any chat channel — General is fine, so is a ` +
    `whisper to yourself. I check every 30 seconds and will DM you when it lands.\n` +
    `The code is good for ${minutes} minutes. Only you can see this message.\n\n` +
    // The DM is best-effort: plenty of people have DMs from server members
    // turned off, and without this line a link that actually worked looks like
    // one that failed, so they burn another code and see nothing again.
    `*No DM? It may still have worked — DMs from server members are off for some ` +
    `people. Just run \`/character sheet\` and see.*`,
  );
}

async function handleUnlink(interaction, guildId) {
  const target = interaction.options.getUser('member');
  const self = !target || target.id === interaction.user.id;

  if (!self && !isStaff(interaction.member)) {
    return interaction.editReply('❌ Only staff can unlink someone else\'s account.');
  }

  const userId = self ? interaction.user.id : target.id;
  const link = identity.getLink(guildId, userId);
  if (!link) {
    return interaction.editReply(self ? 'You are not linked to a game account.' : 'They are not linked.');
  }

  identity.removeLink(guildId, userId);

  // The sheet itself is left alone. It is a public thread other players may
  // have replied to, and unlinking is an identity operation, not a deletion —
  // relinking the same account picks the sheet straight back up.
  return interaction.editReply(
    `🔗 Unlinked ${self ? 'you' : `<@${userId}>`} from **${link.username}**. ` +
    'Any character sheet stays where it is.',
  );
}

async function handleRefresh(interaction, guildId) {
  const link = identity.getLink(guildId, interaction.user.id);
  if (!link) return interaction.editReply(NOT_LINKED);

  try {
    const result = await sheets.refreshSheet(interaction.client, guildId, {
      discordId: interaction.user.id,
      steamid: link.steamid,
      username: link.username,
    });
    if (!result) {
      return interaction.editReply(
        'You have no character sheet yet — run `/character sheet` to write one.',
      );
    }
    return interaction.editReply(`♻️ Refreshed <#${result.thread.id}>.`);
  } catch (err) {
    console.error('[Characters] Refresh failed:', err?.message || err);
    return interaction.editReply(`❌ ${err.message}`);
  }
}

async function handleView(interaction, guildId) {
  const name = interaction.options.getString('name');
  const match = identity
    .allSheets(guildId)
    .find((s) => (s.name || '').toLowerCase() === name.toLowerCase());

  if (!match) {
    // Retired characters stay findable — being able to look up someone who died
    // is most of why the threads are kept.
    const dead = identity
      .retiredSheets(guildId)
      .find((r) => (r.name || '').toLowerCase() === name.toLowerCase());
    if (dead) {
      return interaction.editReply({
        content:
          `⚰️ **${dead.name}** did not survive.\n` +
          `Their sheet: <#${dead.threadId}>` +
          (dead.eulogyUrl ? `\nTheir eulogy: ${dead.eulogyUrl}` : ''),
        allowedMentions: { parse: [] },
      });
    }
    return interaction.editReply(`No character sheet for **${name}**.`);
  }

  return interaction.editReply({
    content: `📋 **${match.name}** — <#${match.threadId}>`,
    allowedMentions: { parse: [] },
  });
}

async function handleWhois(interaction, guildId) {
  const member = interaction.options.getUser('member');
  const link = identity.getLink(guildId, member.id);
  if (!link) {
    return interaction.editReply(`<@${member.id}> has not linked a game account.`);
  }

  const cfg = sheets.sheetConfig(guildId);
  const derived = cfg ? sheets.derive(cfg, { steamid: link.steamid, username: link.username }) : null;
  const sheet = identity.getSheet(guildId, link.steamid);
  const buried = identity.retiredSheets(guildId, { steamid: link.steamid });

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(derived?.name || link.username)
    .setDescription(`Played by <@${member.id}> · account \`${link.username}\``);

  if (derived?.hours != null) {
    embed.addFields({
      name: 'Survived',
      value: `${derived.hours} hours (${Math.floor(derived.hours / 24)} days)`,
      inline: true,
    });
  }
  if (derived?.skills?.length) {
    embed.addFields({
      name: 'Top skills',
      value: derived.skills.slice(0, 3).map(([s, l]) => `${s} ${l}`).join(', '),
      inline: true,
    });
  }
  embed.addFields({
    name: 'Sheet',
    value: sheet ? `<#${sheet.threadId}>` : '_None written yet._',
    inline: false,
  });
  if (buried.length) {
    embed.addFields({
      name: 'Previous characters',
      value: buried.slice(0, 5).map((r) => `${r.name} — <#${r.threadId}>`).join('\n'),
      inline: false,
    });
  }

  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
