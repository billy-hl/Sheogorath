const Parser = require('rss-parser');
const parser = new Parser();

/**
 * Fetch and parse RSS feed
 * @param {string} feedUrl - RSS feed URL
 * @returns {Promise<Object>} Parsed feed data
 */
async function fetchRSSFeed(feedUrl) {
  try {
    const feed = await parser.parseURL(feedUrl);
    return {
      title: feed.title,
      description: feed.description,
      link: feed.link,
      items: feed.items.map(item => ({
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        content: item.contentSnippet || item.content,
        guid: item.guid || item.link,
        categories: item.categories || []
      }))
    };
  } catch (error) {
    console.error('RSS Feed Error:', error.message);
    throw new Error(`Failed to fetch RSS feed: ${error.message}`);
  }
}

/**
 * Get new articles since last check
 * @param {string} feedUrl - RSS feed URL
 * @param {string} lastGuid - GUID of last seen article
 * @returns {Promise<Array>} Array of new articles
 */
async function getNewArticles(feedUrl, lastGuid) {
  const feed = await fetchRSSFeed(feedUrl);
  
  if (!lastGuid) {
    // First run - return only the most recent article
    return feed.items.slice(0, 1);
  }
  
  const newArticles = [];
  for (const item of feed.items) {
    if (item.guid === lastGuid) {
      break;
    }
    newArticles.push(item);
  }
  
  return newArticles;
}

module.exports = {
  fetchRSSFeed,
  getNewArticles
};
