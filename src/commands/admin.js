const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getUserActivity, getUserNotes } = require('../storage/state');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Bot administration commands (Admin only)')
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('Show bot statistics'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('clear')
        .setDescription('Clear messages from channel')
        .addIntegerOption(option =>
          option.setName('amount')
            .setDescription('Number of messages to delete (1-100)')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('announce')
        .setDescription('Make an announcement')
        .addStringOption(option =>
          option.setName('message')
            .setDescription('Announcement message')
            .setRequired(true))
        .addBooleanOption(option =>
          option.setName('everyone')
            .setDescription('Mention @everyone?')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('userinfo')
        .setDescription('View user activity and notes')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to look up')
            .setRequired(true))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    // Check permissions
    const ADMIN_ROLE_ID = '602514337495646228';
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
                   interaction.user.id === process.env.ADMIN_USER_ID ||
                   interaction.member.roles.cache.has(ADMIN_ROLE_ID);
    
    if (!isAdmin) {
      return await interaction.reply({
        content: '❌ You do not have permission to use admin commands!',
        flags: 64
      });
    }

    switch (subcommand) {
      case 'stats': {
        const uptime = process.uptime();
        const uptimeString = `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;

        const embed = new EmbedBuilder()
          .setTitle('🤖 Bot Statistics')
          .setColor(0x00ff00)
          .addFields(
            { name: '⏱️ Uptime', value: uptimeString, inline: true },
            { name: '🏠 Servers', value: interaction.client.guilds.cache.size.toString(), inline: true },
            { name: '👥 Total Users', value: interaction.client.users.cache.size.toString(), inline: true },
            { name: '💬 Commands', value: interaction.client.commands.size.toString(), inline: true },
            { name: '🧠 Memory Usage', value: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, inline: true },
            { name: '⚡ Node Version', value: process.version, inline: true }
          )
          .setFooter({ text: `Requested by ${interaction.user.username}` })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case 'clear': {
        const amount = interaction.options.getInteger('amount');

        if (amount < 1 || amount > 100) {
          return await interaction.reply({
            content: '❌ Please specify a number between 1 and 100.',
            flags: 64
          });
        }

        try {
          const messages = await interaction.channel.bulkDelete(amount, true);
          const embed = new EmbedBuilder()
            .setTitle('🗑️ Messages Cleared')
            .setDescription(`Successfully deleted ${messages.size} messages.`)
            .setColor(0x00ff00)
            .setTimestamp();

          await interaction.reply({ embeds: [embed], flags: 64 });
        } catch (error) {
          console.error('Error clearing messages:', error);
          await interaction.reply({
            content: '❌ Failed to clear messages. They may be too old or I lack permissions.',
            flags: 64
          });
        }
        break;
      }

      case 'announce': {
        const message = interaction.options.getString('message');
        const mentionEveryone = interaction.options.getBoolean('everyone') || false;

        const embed = new EmbedBuilder()
          .setTitle('📢 Announcement')
          .setDescription(message)
          .setColor(0xffa500)
          .setFooter({ text: `Announced by ${interaction.user.username}` })
          .setTimestamp();

        await interaction.reply({
          content: mentionEveryone ? '@everyone' : undefined,
          embeds: [embed]
        });
        break;
      }

      case 'userinfo': {
        const targetUser = interaction.options.getUser('user');
        const activity = getUserActivity(targetUser.id);
        const notes = getUserNotes(targetUser.id);

        const lastChatDate = activity.lastChat ? new Date(activity.lastChat).toLocaleString() : 'Never';
        const lastVoiceDate = activity.lastVoiceJoin ? new Date(activity.lastVoiceJoin).toLocaleString() : 'Never';

        const notesText = notes.length > 0
          ? notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')
          : 'No notes recorded.';

        const embed = new EmbedBuilder()
          .setTitle(`📋 User Info: ${targetUser.username}`)
          .setColor(0x0099ff)
          .setThumbnail(targetUser.displayAvatarURL())
          .addFields(
            { name: '👤 User ID', value: targetUser.id, inline: true },
            { name: '💬 Last Chat', value: lastChatDate, inline: true },
            { name: '🎤 Last Voice Join', value: lastVoiceDate, inline: true },
            { name: '📝 Notes', value: notesText }
          )
          .setFooter({ text: `Requested by ${interaction.user.username}` })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        break;
      }
    }
  },
};
