const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fishingGame = require('../services/fishing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fishing_weather')
    .setDescription('Check or set fishing weather conditions')
    .addStringOption(option =>
      option.setName('weather')
        .setDescription('Set new weather (admin only)')
        .setRequired(false)
        .addChoices(
          { name: 'Sunny', value: 'sunny' },
          { name: 'Cloudy', value: 'cloudy' },
          { name: 'Rainy', value: 'rainy' },
          { name: 'Stormy', value: 'stormy' },
          { name: 'Foggy', value: 'foggy' }
        )),

  async execute(interaction) {
    const newWeather = interaction.options.getString('weather');
    const currentWeather = fishingGame.getCurrentWeather();
    const data = fishingGame.loadData();
    const weatherEffects = data.weather.effects;
    
    await interaction.deferReply();

    try {
      // Check if user is trying to set weather (admin check)
      if (newWeather) {
        // Simple admin check - you might want to use a proper permission system
        const isAdmin = interaction.member.permissions.has('Administrator') || 
                       interaction.user.id === process.env.ADMIN_USER_ID; // Set this in your .env
        
        if (!isAdmin) {
          return await interaction.editReply('❌ Only administrators can change the weather!');
        }
        
        fishingGame.setWeather(newWeather);
        
        const embed = new EmbedBuilder()
          .setTitle('🌤️ Weather Changed!')
          .setDescription(`**${interaction.user.username}** has changed the weather to **${newWeather.charAt(0).toUpperCase() + newWeather.slice(1)}**!`)
          .setColor(0xffa500)
          .addFields({
            name: '📊 Effects',
            value: weatherEffects[newWeather].message,
            inline: true
          })
          .setFooter({
            text: `Weather control by ${interaction.user.username}`,
            iconURL: interaction.user.displayAvatarURL({ dynamic: true })
          })
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
      } else {
        // Just show current weather
        const embed = new EmbedBuilder()
          .setTitle('🌤️ Current Fishing Weather')
          .setDescription(`**${currentWeather.charAt(0).toUpperCase() + currentWeather.slice(1)}**`)
          .setColor(this.getWeatherColor(currentWeather))
          .addFields(
            {
              name: '📊 Catch Rate Multiplier',
              value: `${weatherEffects[currentWeather].catchMultiplier}x`,
              inline: true
            },
            {
              name: '💬 Conditions',
              value: weatherEffects[currentWeather].message,
              inline: true
            }
          )
          .setFooter({
            text: 'Weather affects fishing success rates',
            iconURL: interaction.user.displayAvatarURL({ dynamic: true })
          })
          .setTimestamp();

        // Add weather emoji
        embed.setThumbnail(this.getWeatherEmoji(currentWeather));

        await interaction.editReply({ embeds: [embed] });
      }

    } catch (error) {
      console.error('Weather command error:', error);
      await interaction.editReply('❌ Failed to check weather. Please try again.');
    }
  },

  getWeatherColor(weather) {
    const colors = {
      sunny: 0xffd700,    // Gold
      cloudy: 0x87ceeb,   // Sky blue
      rainy: 0x4682b4,    // Steel blue
      stormy: 0x2f4f4f,   // Dark slate gray
      foggy: 0xd3d3d3     // Light gray
    };
    return colors[weather] || 0x00ff00;
  },

  getWeatherEmoji(weather) {
    const emojis = {
      sunny: '☀️',
      cloudy: '☁️',
      rainy: '🌧️',
      stormy: '⛈️',
      foggy: '🌫️'
    };
    return emojis[weather] || '🌤️';
  }
};
