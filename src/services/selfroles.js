'use strict';
/**
 * Roles people give themselves, from a button.
 *
 * The role ID travels in the button's custom_id, so the posted message keeps
 * working across restarts with nothing held in memory and no message ID written
 * down anywhere.
 *
 * That same property is the thing to be careful about: a custom_id arrives from
 * the client, and a crafted one naming the Warden role must not be a way to
 * become staff. So the ID is never used as given — it is looked up in this
 * guild's `selfRoles` allowlist first, and anything not on that list is
 * refused. The allowlist is the security boundary; the button is only a
 * convenient way to reach it.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');

const PREFIX = 'selfrole:';
const GOLD = 0xe8b652;

const isSelfRoleButton = (interaction) =>
  typeof interaction.customId === 'string' && interaction.customId.startsWith(PREFIX);

const specsFor = (guildId) => getGuildConfig(guildId)?.selfRoles || [];

/** The posted message: one embed, and a button per self-assignable role. */
function buildMessage(guild) {
  const specs = specsFor(guild.id);
  if (!specs.length) return null;

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle('Pick your pings')
    .setDescription(
      'Take a role to be findable when people are looking for a group, and drop it ' +
      'when you would rather not be. Press again to remove it. These grant nothing ' +
      'else — no channels, no powers, no standing.'
    )
    .addFields(specs.map((s) => ({
      name: `${s.emoji ? `${s.emoji} ` : ''}${s.label}`,
      value: s.description || 'Ping this role for groups.',
    })));

  // Five buttons to a row is Discord's limit, not a style choice.
  const rows = [];
  for (let i = 0; i < specs.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      specs.slice(i, i + 5).map((s) => {
        const b = new ButtonBuilder()
          .setCustomId(`${PREFIX}${s.role}`)
          .setLabel(s.label)
          .setStyle(ButtonStyle.Secondary);
        if (s.emoji) b.setEmoji(s.emoji);
        return b;
      })
    ));
  }
  return { embeds: [embed], components: rows };
}

async function handleButton(interaction) {
  const wanted = interaction.customId.slice(PREFIX.length);

  // The allowlist check. Not a sanity check — the authorisation check.
  const spec = specsFor(interaction.guild.id).find((s) => s.role === wanted);
  if (!spec) {
    await interaction.reply({ content: 'That button is not wired to anything any more.', ephemeral: true });
    return;
  }

  const role = interaction.guild.roles.cache.get(spec.role)
    || await interaction.guild.roles.fetch(spec.role).catch(() => null);
  if (!role) {
    await interaction.reply({ content: 'That role has been deleted. Tell a Warden.', ephemeral: true });
    return;
  }

  const me = interaction.guild.members.me;
  if (!me || role.position >= me.roles.highest.position) {
    console.warn(`[SelfRoles] ${interaction.guild.name}: "${role.name}" sits at or above my highest role.`);
    await interaction.reply({ content: 'I am not allowed to hand that one out. Tell a Warden.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  const had = member.roles.cache.has(role.id);
  try {
    if (had) await member.roles.remove(role, 'self-assign button');
    else await member.roles.add(role, 'self-assign button');
    await interaction.reply({
      content: had ? `Dropped **${role.name}**.` : `Took **${role.name}**.`,
      ephemeral: true,
    });
  } catch (err) {
    console.warn(`[SelfRoles] ${interaction.guild.name}: toggle of "${role.name}" failed: ${err?.message || err}`);
    await interaction.reply({ content: 'That did not work. Tell a Warden.', ephemeral: true });
  }
}

module.exports = { isSelfRoleButton, handleButton, buildMessage };
