const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getAIResponse } = require('../ai/grok');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('weather')
    .setDescription('Get weather information for a location')
    .addStringOption(option =>
      option.setName('location')
        .setDescription('City name or location')
        .setRequired(true)),

  async execute(interaction) {
    const location = interaction.options.getString('location');

    await interaction.deferReply();

    try {
      // Using OpenWeatherMap API (you'll need to add WEATHER_API_KEY to .env)
      const apiKey = process.env.WEATHER_API_KEY;
      if (!apiKey) {
        return await interaction.editReply('❌ Weather service is not configured. Please contact an admin.');
      }

      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${apiKey}&units=metric`
      );

      if (!response.ok) {
        if (response.status === 404) {
          return await interaction.editReply(`❌ Location "${location}" not found. Please check the spelling.`);
        }
        throw new Error(`Weather API error: ${response.status}`);
      }

      const data = await response.json();

      const embed = new EmbedBuilder()
        .setTitle(`🌤️ Weather in ${data.name}, ${data.sys.country}`)
        .setDescription(`**${data.weather[0].description.charAt(0).toUpperCase() + data.weather[0].description.slice(1)}**`)
        .setColor(getWeatherColor(data.weather[0].main))
        .addFields(
          { name: '🌡️ Temperature', value: `${Math.round(data.main.temp)}°C (${Math.round(data.main.temp * 9/5 + 32)}°F)`, inline: true },
          { name: '🤔 Feels Like', value: `${Math.round(data.main.feels_like)}°C (${Math.round(data.main.feels_like * 9/5 + 32)}°F)`, inline: true },
          { name: '💧 Humidity', value: `${data.main.humidity}%`, inline: true },
          { name: '💨 Wind Speed', value: `${data.wind.speed} m/s`, inline: true },
          { name: '🌪️ Pressure', value: `${data.main.pressure} hPa`, inline: true },
          { name: '👁️ Visibility', value: `${Math.round(data.visibility / 1000)} km`, inline: true }
        )
        .setFooter({ text: `Weather data from OpenWeatherMap • ${new Date().toLocaleString()}` })
        .setTimestamp();

      // Add weather icon if available
      if (data.weather[0].icon) {
        embed.setThumbnail(`https://openweathermap.org/img/wn/${data.weather[0].icon}@2x.png`);
      }

      // Add AI commentary about the weather
      try {
        const aiPrompt = `Comment on the weather in ${data.name}: ${data.weather[0].description}, ${Math.round(data.main.temp)}°C, humidity ${data.main.humidity}%, wind ${data.wind.speed} m/s. Make it sarcastic and in Sheogorath's chaotic style.`;
        const aiComment = await getAIResponse(aiPrompt);
        
        embed.addFields({
          name: '🎭 Sheogorath Says',
          value: `*${aiComment}*`,
          inline: false
        });
      } catch (aiError) {
        console.error('AI weather comment failed:', aiError);
        // Fallback to static comment
        embed.addFields({
          name: '🎭 Sheogorath Says',
          value: `*Ah, the weather in ${data.name}! ${data.weather[0].description}? How utterly predictable... or is it?*`,
          inline: false
        });
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Weather command error:', error);
      await interaction.editReply('❌ Failed to get weather information. Please try again later.');
    }
  },
};

function getWeatherColor(weatherMain) {
  const colors = {
    'Clear': 0xffd700,      // Gold
    'Clouds': 0x87ceeb,     // Sky blue
    'Rain': 0x4682b4,       // Steel blue
    'Drizzle': 0x4682b4,    // Steel blue
    'Thunderstorm': 0x2f4f4f, // Dark slate gray
    'Snow': 0xffffff,       // White
    'Mist': 0xd3d3d3,       // Light gray
    'Fog': 0xd3d3d3,        // Light gray
    'Haze': 0xd3d3d3        // Light gray
  };
  return colors[weatherMain] || 0x00ff00;
}
