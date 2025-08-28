const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Get information about a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to get info about (defaults to yourself)')
        .setRequired(false)),

  async execute(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const targetMember = interaction.guild.members.cache.get(targetUser.id);

    const embed = new EmbedBuilder()
      .setTitle(`${targetUser.username}'s Info`)
      .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
      .setColor(targetMember ? targetMember.displayHexColor : 0x00ff00)
      .addFields(
        { name: '👤 Username', value: targetUser.username, inline: true },
        { name: '🆔 User ID', value: targetUser.id, inline: true },
        { name: '🤖 Bot', value: targetUser.bot ? 'Yes' : 'No', inline: true },
        { name: '📅 Account Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:F>`, inline: true }
      )
      .setTimestamp();

    if (targetMember) {
      embed.addFields(
        { name: '📍 Joined Server', value: `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:F>`, inline: true },
        { name: '🎭 Display Name', value: targetMember.displayName, inline: true },
        { name: '🏷️ Roles', value: targetMember.roles.cache.size > 1 ? targetMember.roles.cache.filter(r => r.name !== '@everyone').map(r => r.toString()).join(', ') : 'None', inline: false }
      );

      // Add status if available
      if (targetMember.presence) {
        const status = targetMember.presence.status;
        const statusEmoji = {
          online: '🟢',
          idle: '🟡',
          dnd: '🔴',
          offline: '⚫'
        };
        embed.addFields({
          name: '📊 Status',
          value: `${statusEmoji[status] || '⚫'} ${status.charAt(0).toUpperCase() + status.slice(1)}`,
          inline: true
        });
      }
    }

    await interaction.reply({ embeds: [embed] });
  },
};
