const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Get detailed information about the server'),

  async execute(interaction) {
    const guild = interaction.guild;

    // Get member counts
    const totalMembers = guild.memberCount;
    const onlineMembers = guild.members.cache.filter(m => m.presence?.status === 'online').size;
    const botCount = guild.members.cache.filter(m => m.user.bot).size;

    // Get channel counts
    const textChannels = guild.channels.cache.filter(c => c.type === 0).size;
    const voiceChannels = guild.channels.cache.filter(c => c.type === 2).size;
    const categoryChannels = guild.channels.cache.filter(c => c.type === 4).size;

    // Get role count
    const roleCount = guild.roles.cache.size;

    // Get emoji counts
    const staticEmojis = guild.emojis.cache.filter(e => !e.animated).size;
    const animatedEmojis = guild.emojis.cache.filter(e => e.animated).size;

    // Get boost info
    const boostLevel = guild.premiumTier;
    const boostCount = guild.premiumSubscriptionCount;

    const embed = new EmbedBuilder()
      .setTitle(`${guild.name} Server Info`)
      .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
      .setColor(0x00ff00)
      .addFields(
        { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
        { name: '🆔 Server ID', value: guild.id, inline: true },
        { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: true },

        { name: '👥 Members', value: `${totalMembers}`, inline: true },
        { name: '🟢 Online', value: `${onlineMembers}`, inline: true },
        { name: '🤖 Bots', value: `${botCount}`, inline: true },

        { name: '💬 Text Channels', value: `${textChannels}`, inline: true },
        { name: '🔊 Voice Channels', value: `${voiceChannels}`, inline: true },
        { name: '📁 Categories', value: `${categoryChannels}`, inline: true },

        { name: '🏷️ Roles', value: `${roleCount}`, inline: true },
        { name: '😀 Static Emojis', value: `${staticEmojis}`, inline: true },
        { name: '🎯 Animated Emojis', value: `${animatedEmojis}`, inline: true },

        { name: '🚀 Boost Level', value: `${boostLevel}`, inline: true },
        { name: '💎 Boosts', value: `${boostCount}`, inline: true },
        { name: '🔒 Verification', value: guild.verificationLevel.toString(), inline: true }
      )
      .setFooter({ text: `Requested by ${interaction.user.username}` })
      .setTimestamp();

    // Add features if any
    if (guild.features.length > 0) {
      embed.addFields({
        name: '✨ Features',
        value: guild.features.map(f => f.replace(/_/g, ' ').toLowerCase()).join(', '),
        inline: false
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
