const { SlashCommandBuilder } = require('discord.js');
const { checkKickLive } = require('../services/kick');
const { fetchLatestVideo } = require('../services/youtube');
const { getState } = require('../storage/state');

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

      // Check Kick API
      try {
        if (process.env.KICK_CHANNEL_URL) {
          const kickStart = Date.now();
          await checkKickLive(process.env.KICK_CHANNEL_URL);
          status.services.kick_api = {
            status: 'healthy',
            response_time: Date.now() - kickStart
          };
        }
      } catch (e) {
        status.services.kick_api = {
          status: 'error',
          error: e.message
        };
      }

      // Check YouTube API
      try {
        if (process.env.YT_CHANNEL_URL) {
          const ytStart = Date.now();
          await fetchLatestVideo(process.env.YT_CHANNEL_URL);
          status.services.youtube_api = {
            status: 'healthy',
            response_time: Date.now() - ytStart
          };
        }
      } catch (e) {
        status.services.youtube_api = {
          status: 'error',
          error: e.message
        };
      }

      // Check OpenAI API
      try {
        if (process.env.OPENAI_API_KEY) {
          status.services.openai_api = {
            status: 'configured',
            model: process.env.CLIENT_MODEL || 'gpt-4o'
          };
        }
      } catch (e) {
        status.services.openai_api = {
          status: 'error',
          error: e.message
        };
      }

      // Get current state
      const state = getState();
      status.monitoring = {
        kick_channels: {
          main: state.kickLive || false,
          eokafish: state.eokafishKickLive || false,
          allisteras: state.allisterasKickLive || false
        },
        youtube_live: state.youtubeLive || false,
        last_youtube_video: state.lastYouTubeVideoId || 'none'
      };

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

      // Add monitoring status
      embed.fields.push({
        name: '📊 Monitoring Status',
        value: `Kick: ${Object.values(status.monitoring.kick_channels).filter(Boolean).length}/3 online\nYouTube: ${status.monitoring.youtube_live ? 'Live' : 'Offline'}`,
        inline: false
      });

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Health check failed:', error);
      await interaction.editReply('❌ Health check failed. Check bot logs for details.');
    }
  },
};
