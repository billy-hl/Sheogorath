const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('health')
    .setDescription('Check bot health and service status'),
  async execute(interaction) {
    try {
      await interaction.deferReply();

      const status = {
        timestamp: new Date().toISOString(),
        services: {}
      };

      // Check Discord connection
      status.services.discord = {
        status: 'healthy',
        latency: interaction.guild.shard.ping
      };

      // Check Grok API
      try {
        if (process.env.GROK_API_KEY) {
          status.services.grok_api = {
            status: 'configured',
            model: 'grok-code-fast-1'
          };
        }
      } catch (e) {
        status.services.grok_api = {
          status: 'error',
          error: e.message
        };
      }

      // Create response embed
      const embed = {
        title: '🤖 Bot Health Status',
        color: 0x00ff00,
        fields: [],
        timestamp: new Date().toISOString(),
        footer: { text: 'Sheogorath Health Check' }
      };

      // Add service status
      for (const [service, info] of Object.entries(status.services)) {
        const statusEmoji = info.status === 'healthy' ? '✅' : info.status === 'configured' ? '⚙️' : '❌';
        const value = info.response_time ? `${info.response_time}ms` : info.error || 'OK';
        embed.fields.push({
          name: `${statusEmoji} ${service.replace('_', ' ').toUpperCase()}`,
          value: value,
          inline: true
        });
      }

      // Add uptime
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      embed.fields.push({
        name: '⏱️ Uptime',
        value: `${hours}h ${minutes}m`,
        inline: false
      });

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Health check failed:', error);
      await interaction.editReply('❌ Health check failed. Check bot logs for details.');
    }
  },
};
