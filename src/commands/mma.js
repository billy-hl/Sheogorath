const { SlashCommandBuilder } = require('discord.js');
const { fetchRSSFeed } = require('../services/rss-feed');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mma')
    .setDescription('Get the latest MMA news from Sherdog'),
  
  async execute(interaction) {
    await interaction.deferReply();
    
    try {
      const SHERDOG_RSS = 'https://www.sherdog.com/rss/news.xml';
      const feed = await fetchRSSFeed(SHERDOG_RSS);
      
      if (!feed.items || feed.items.length === 0) {
        return await interaction.editReply('❌ No MMA news available at the moment.');
      }
      
      // Get the latest article
      const article = feed.items[0];
      
      const embed = {
        color: 0xE31C23, // Sherdog red
        author: {
          name: 'Sherdog MMA News',
          icon_url: 'https://www.sherdog.com/favicon.ico',
          url: 'https://www.sherdog.com/news'
        },
        title: `🥊 ${article.title}`,
        url: article.link,
        description: `**${article.content || 'Click to read the full article'}**`,
        image: {
          url: 'https://dmxg5wxfqgb4u.cloudfront.net/styles/card/s3/2024-08/081724-UFC-306-Sean-OMalley-Merab-Dvalishvili-Press-Conference-THUMB-GettyImages-2165279081.jpg?itok=_XdXLNh7'
        },
        fields: article.categories && article.categories.length > 0 ? [
          {
            name: '📁 Category',
            value: article.categories[0],
            inline: true
          }
        ] : [],
        timestamp: new Date(article.pubDate).toISOString(),
        footer: { 
          text: 'Sherdog',
          icon_url: 'https://www.sherdog.com/favicon.ico'
        }
      };
      
      await interaction.editReply({ embeds: [embed] });
      
    } catch (error) {
      console.error('MMA command error:', error);
      await interaction.editReply('❌ Failed to fetch MMA news. Please try again later.');
    }
  },
};
