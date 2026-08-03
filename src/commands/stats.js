'use strict';
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

const startTime = Date.now();
const commandStats = new Map();

function trackCommand(commandName) {
  const count = commandStats.get(commandName) || 0;
  commandStats.set(commandName, count + 1);
}

function getUptime() {
  const ms = Date.now() - startTime;
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

module.exports = {
  trackCommand,
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show bot statistics (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  
  async execute(interaction) {
    const mem = process.memoryUsage();

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Bot Statistics')
      .addFields(
        { name: '⏱️ Uptime', value: getUptime(), inline: true },
        { name: '💾 Memory', value: `${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB`, inline: true },
        { name: '📝 Commands Used', value: Array.from(commandStats.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([cmd, count]) => `\`/${cmd}\`: ${count}`)
          .join('\n') || 'None yet', inline: false }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed], flags: 64 });
  },
};
