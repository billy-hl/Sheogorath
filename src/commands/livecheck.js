'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { checkYouTubeLive } = require('../services/youtube');
const { checkKickLive } = require('../services/kick');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('livecheck')
    .setDescription('Check current livestream status on YouTube and/or Kick')
    .addStringOption((opt) =>
      opt
        .setName('platform')
        .setDescription('Which platform to check')
        .addChoices(
          { name: 'youtube', value: 'youtube' },
          { name: 'kick', value: 'kick' },
          { name: 'both', value: 'both' },
        )
    ),
  async execute(interaction) {
    const platform = interaction.options.getString('platform') || 'youtube';
    try {
      await interaction.deferReply();
    } catch (e) {
      console.error('livecheck: deferReply failed:', e);
      return;
    }

    const lines = [];
    const wantYT = platform === 'youtube' || platform === 'both';
    const wantKick = platform === 'kick' || platform === 'both';

    if (wantYT) {
      const ytUrl = process.env.YT_CHANNEL_URL;
      if (!ytUrl) {
        lines.push('YouTube: YT_CHANNEL_URL not set in environment.');
      } else {
        try {
          const info = await checkYouTubeLive(ytUrl);
          if (info.live) {
            lines.push(`YouTube: LIVE — ${info.title} — ${info.url}`);
          } else {
            lines.push('YouTube: Offline');
          }
        } catch (e) {
          console.error('livecheck: YouTube check failed:', e);
          lines.push('YouTube: Error checking status.');
        }
      }
    }

    if (wantKick) {
      const kickUrl = process.env.KICK_CHANNEL_URL;
      if (!kickUrl) {
        lines.push('Kick: KICK_CHANNEL_URL not set in environment.');
      } else {
        try {
          const info = await checkKickLive(kickUrl);
          if (info.live) {
            lines.push(`Kick: LIVE — ${info.title || 'Streaming'} — ${info.url}`);
          } else {
            lines.push('Kick: Offline');
          }
        } catch (e) {
          console.error('livecheck: Kick check failed:', e);
          lines.push('Kick: Error checking status.');
        }
      }
    }

    const msg = lines.join('\n') || 'No platforms selected.';
    try {
      await interaction.editReply(msg);
    } catch (e) {
      console.error('livecheck: editReply failed:', e);
    }
  },
};
