const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Moderation commands (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('warn')
        .setDescription('Warn a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to warn')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for warning')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('kick')
        .setDescription('Kick a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to kick')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for kick')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('ban')
        .setDescription('Ban a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to ban')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for ban')
            .setRequired(false))
        .addIntegerOption(option =>
          option.setName('days')
            .setDescription('Days of messages to delete (0-7)')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('timeout')
        .setDescription('Timeout a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to timeout')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('minutes')
            .setDescription('Timeout duration in minutes')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for timeout')
            .setRequired(false))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    // Check permissions
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return await interaction.reply({
        content: '❌ You need Administrator permissions to use moderation commands!',
        ephemeral: true
      });
    }

    // Can't moderate yourself
    if (targetUser.id === interaction.user.id) {
      return await interaction.reply({
        content: '❌ You cannot moderate yourself!',
        ephemeral: true
      });
    }

    // Can't moderate the bot
    if (targetUser.id === interaction.guild.members.me.id) {
      return await interaction.reply({
        content: '❌ You cannot moderate the bot!',
        ephemeral: true
      });
    }

    try {
      switch (subcommand) {
        case 'warn': {
          const embed = new EmbedBuilder()
            .setTitle('⚠️ Warning Issued')
            .setDescription(`**User:** ${targetUser}\n**Moderator:** ${interaction.user}\n**Reason:** ${reason}`)
            .setColor(0xffa500)
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });

          // Try to DM the user
          try {
            const dmEmbed = new EmbedBuilder()
              .setTitle(`⚠️ Warning from ${interaction.guild.name}`)
              .setDescription(`You have been warned for: **${reason}**`)
              .setColor(0xffa500)
              .setTimestamp();

            await targetUser.send({ embeds: [dmEmbed] });
          } catch (error) {
            await interaction.followUp({
              content: '⚠️ Could not DM the user about their warning.',
              ephemeral: true
            });
          }
          break;
        }

        case 'kick': {
          const member = await interaction.guild.members.fetch(targetUser.id);
          await member.kick(reason);

          const embed = new EmbedBuilder()
            .setTitle('👢 User Kicked')
            .setDescription(`**User:** ${targetUser}\n**Moderator:** ${interaction.user}\n**Reason:** ${reason}`)
            .setColor(0xff6b6b)
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
          break;
        }

        case 'ban': {
          const days = interaction.options.getInteger('days') || 0;
          const member = await interaction.guild.members.fetch(targetUser.id);
          await member.ban({ reason, days });

          const embed = new EmbedBuilder()
            .setTitle('🔨 User Banned')
            .setDescription(`**User:** ${targetUser}\n**Moderator:** ${interaction.user}\n**Reason:** ${reason}\n**Messages deleted:** ${days} days`)
            .setColor(0xff0000)
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
          break;
        }

        case 'timeout': {
          const minutes = interaction.options.getInteger('minutes');
          const member = await interaction.guild.members.fetch(targetUser.id);

          const timeoutDuration = minutes * 60 * 1000; // Convert to milliseconds
          await member.timeout(timeoutDuration, reason);

          const embed = new EmbedBuilder()
            .setTitle('⏰ User Timed Out')
            .setDescription(`**User:** ${targetUser}\n**Moderator:** ${interaction.user}\n**Duration:** ${minutes} minutes\n**Reason:** ${reason}`)
            .setColor(0xffd700)
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
          break;
        }
      }
    } catch (error) {
      console.error('Moderation command error:', error);
      await interaction.reply({
        content: `❌ Failed to ${subcommand} the user. They may have higher permissions or the bot may lack permissions.`,
        ephemeral: true
      });
    }
  },
};
