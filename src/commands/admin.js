const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Bot administration commands (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
            .setRequired(false))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    // Check permissions
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) || 
                   interaction.user.id === process.env.ADMIN_USER_ID;
    
    if (!isAdmin) {
      return await interaction.reply({
        content: '❌ You need Administrator permissions to use admin commands!',
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
    }
  },
};
