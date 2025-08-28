const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set a reminder')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('What should I remind you about?')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('minutes')
        .setDescription('How many minutes from now?')
        .setRequired(true)),

  async execute(interaction) {
    const message = interaction.options.getString('message');
    const minutes = interaction.options.getInteger('minutes');

    // Validate input
    if (minutes < 1 || minutes > 1440) { // Max 24 hours
      return await interaction.reply({
        content: '❌ Please specify a time between 1 and 1440 minutes (24 hours).',
        flags: 64
      });
    }

    const reminderTime = new Date(Date.now() + minutes * 60 * 1000);

    const embed = new EmbedBuilder()
      .setTitle('⏰ Reminder Set!')
      .setDescription(`**Message:** ${message}\n**Time:** <t:${Math.floor(reminderTime.getTime() / 1000)}:R>`)
      .setColor(0x00ff00)
      .setFooter({ text: `Set by ${interaction.user.username}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    // Set up the reminder
    setTimeout(async () => {
      try {
        const reminderEmbed = new EmbedBuilder()
          .setTitle('⏰ REMINDER!')
          .setDescription(`**${message}**`)
          .setColor(0xffa500)
          .setFooter({ text: `Originally set ${minutes} minutes ago` })
          .setTimestamp();

        await interaction.user.send({ embeds: [reminderEmbed] });

        // Also try to send in the channel if possible
        try {
          await interaction.followUp({
            content: `${interaction.user}, here's your reminder: **${message}**`,
            flags: 64
          });
        } catch (error) {
          // Ignore if followUp fails (might be expired)
        }
      } catch (error) {
        console.error('Error sending reminder:', error);
      }
    }, minutes * 60 * 1000);
  },
};
