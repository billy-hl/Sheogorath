const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { fetchPlayerStats, getTotalLevel, SKILLS } = require('../services/osrs');
const { getOSRSStats, setOSRSStats, getOSRSConfig, setOSRSConfig } = require('../storage/state');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('osrs')
    .setDescription('Check OSRS player stats')
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('Check current stats for a player')
        .addStringOption(option =>
          option
            .setName('username')
            .setDescription('OSRS username to check')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('track')
        .setDescription('Start tracking a player for level updates')
        .addStringOption(option =>
          option
            .setName('username')
            .setDescription('OSRS username to track')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('untrack')
        .setDescription('Stop tracking a player')
        .addStringOption(option =>
          option
            .setName('username')
            .setDescription('OSRS username to stop tracking')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all tracked players')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'stats') {
      await handleStats(interaction);
    } else if (subcommand === 'track') {
      await handleTrack(interaction);
    } else if (subcommand === 'untrack') {
      await handleUntrack(interaction);
    } else if (subcommand === 'list') {
      await handleList(interaction);
    }
  },
};

async function handleStats(interaction) {
  await interaction.deferReply();

  const username = interaction.options.getString('username') || 'Alchmore';

  try {
    const stats = await fetchPlayerStats(username);
    const totalLevel = getTotalLevel(stats);

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`📊 OSRS Stats - ${username}`)
      .setURL(`https://secure.runescape.com/m=hiscore_oldschool/hiscorepersonal?user1=${encodeURIComponent(username)}`)
      .setThumbnail('https://oldschool.runescape.wiki/images/thumb/Old_School_RuneScape_logo.png/150px-Old_School_RuneScape_logo.png')
      .setTimestamp();

    // Combat stats
    let combatStats = '';
    const combatSkills = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic'];
    for (const skill of combatSkills) {
      if (stats[skill]) {
        combatStats += `**${skill}**: ${stats[skill].level} (${stats[skill].xp.toLocaleString()} XP)\n`;
      }
    }
    embed.addFields({ name: '⚔️ Combat Skills', value: combatStats, inline: true });

    // Gathering stats
    let gatheringStats = '';
    const gatheringSkills = ['Mining', 'Fishing', 'Woodcutting', 'Farming', 'Hunter'];
    for (const skill of gatheringSkills) {
      if (stats[skill]) {
        gatheringStats += `**${skill}**: ${stats[skill].level} (${stats[skill].xp.toLocaleString()} XP)\n`;
      }
    }
    embed.addFields({ name: '🌲 Gathering Skills', value: gatheringStats, inline: true });

    // Artisan stats
    let artisanStats = '';
    const artisanSkills = ['Cooking', 'Firemaking', 'Crafting', 'Smithing', 'Fletching', 'Herblore', 'Runecraft', 'Construction'];
    for (const skill of artisanSkills) {
      if (stats[skill]) {
        artisanStats += `**${skill}**: ${stats[skill].level} (${stats[skill].xp.toLocaleString()} XP)\n`;
      }
    }
    embed.addFields({ name: '🔨 Artisan Skills', value: artisanStats, inline: false });

    // Support stats
    let supportStats = '';
    const supportSkills = ['Agility', 'Thieving', 'Slayer'];
    for (const skill of supportSkills) {
      if (stats[skill]) {
        supportStats += `**${skill}**: ${stats[skill].level} (${stats[skill].xp.toLocaleString()} XP)\n`;
      }
    }
    embed.addFields({ name: '🎯 Support Skills', value: supportStats, inline: false });

    // Overall stats
    if (stats['Overall']) {
      embed.addFields({ 
        name: '📈 Overall', 
        value: `**Total Level**: ${totalLevel}\n**Total XP**: ${stats['Overall'].xp.toLocaleString()}\n**Rank**: ${stats['Overall'].rank ? stats['Overall'].rank.toLocaleString() : 'Unranked'}`,
        inline: false 
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching OSRS stats:', error);
    const errorMsg = error.message.includes('not found') 
      ? `❌ Player **${username}** not found in the OSRS hiscores.`
      : `❌ Failed to fetch stats for **${username}**. The OSRS API may be temporarily unavailable. Try again later.`;
    await interaction.editReply({ content: errorMsg });
  }
}

async function handleTrack(interaction) {
  // Defer reply immediately to prevent timeout
  await interaction.deferReply();
  
  const username = interaction.options.getString('username');
  const config = getOSRSConfig();

  if (config.trackedPlayers.includes(username)) {
    return interaction.editReply({ content: `**${username}** is already being tracked!` });
  }

  try {
    // Verify the player exists by fetching their stats
    const stats = await fetchPlayerStats(username);
    
    // Save initial stats
    setOSRSStats(username, stats);
    
    // Add to tracked players
    config.trackedPlayers.push(username);
    setOSRSConfig(config);

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Player Tracking Started')
      .setDescription(`Now tracking **${username}** for level updates!\n\nUpdates will be posted to <#${config.notificationChannelId}> every hour (8 AM - 10 PM).`)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error tracking player:', error);
    
    // Determine error message based on error type
    let errorMsg;
    if (error.message.includes('not found')) {
      errorMsg = `❌ Player **${username}** not found in the OSRS hiscores.\n\nMake sure:\n• The username is spelled correctly\n• The player has logged in recently\n• The account has enough stats to appear on hiscores`;
    } else if (error.message.includes('502') || error.message.includes('503') || error.message.includes('504')) {
      errorMsg = `⚠️ The OSRS hiscores API is temporarily down (Error: ${error.message.match(/\d{3}/)?.[0]}).\n\n**The player will still be tracked!** I'll keep trying to fetch their stats every hour. Try \`/osrs stats ${username}\` again later to verify.`;
      
      // Add player to tracking list anyway since the API is just down temporarily
      config.trackedPlayers.push(username);
      setOSRSConfig(config);
      console.log(`Added ${username} to tracking despite API error - will fetch stats on next check`);
    } else if (error.message.includes('timeout')) {
      errorMsg = `⏱️ The OSRS API is taking too long to respond.\n\n**The player will still be tracked!** I'll keep trying to fetch their stats every hour.`;
      
      // Add player to tracking list anyway
      config.trackedPlayers.push(username);
      setOSRSConfig(config);
      console.log(`Added ${username} to tracking despite timeout - will fetch stats on next check`);
    } else {
      errorMsg = `❌ Failed to track **${username}**. Error: ${error.message}\n\nThe OSRS API may be temporarily unavailable. Try again later.`;
    }
    
    await interaction.editReply({ content: errorMsg });
  }
}

async function handleUntrack(interaction) {
  const username = interaction.options.getString('username');
  const config = getOSRSConfig();

  const index = config.trackedPlayers.indexOf(username);
  if (index === -1) {
    return interaction.reply({ 
      content: `**${username}** is not being tracked.`,
      flags: 64 // ephemeral flag
    });
  }

  config.trackedPlayers.splice(index, 1);
  setOSRSConfig(config);

  const embed = new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('🛑 Player Tracking Stopped')
    .setDescription(`Stopped tracking **${username}**.`)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleList(interaction) {
  const config = getOSRSConfig();

  if (config.trackedPlayers.length === 0) {
    return interaction.reply({ 
      content: 'No players are currently being tracked.',
      flags: 64 // ephemeral flag
    });
  }

  const embed = new EmbedBuilder()
    .setColor('#0099FF')
    .setTitle('📋 Tracked OSRS Players')
    .setDescription(config.trackedPlayers.map(p => `• **${p}**`).join('\n'))
    .addFields({ 
      name: 'Notification Channel', 
      value: `<#${config.notificationChannelId}>` 
    })
    .setFooter({ text: 'Stats checked every hour (8 AM - 10 PM)' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
