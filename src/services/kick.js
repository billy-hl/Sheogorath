'use strict';
const fetch = require('node-fetch');

// Simple cache to reduce API calls
const cache = new Map();
const CACHE_DURATION = 30 * 1000; // 30 seconds

// Rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30; // Max 30 requests per minute per username

// Returns { live: boolean, title?: string, url: string }
async function checkKickLive(channelUrl) {
  // Extract username from Kick URL
  const m = channelUrl.match(/kick\.com\/(\w+)/);
  const username = m ? m[1] : null;
  if (!username) throw new Error('Invalid Kick channel URL');

  const cacheKey = `kick_${username}`;
  const rateLimitKey = `rate_${username}`;
  const now = Date.now();

  // Rate limiting check
  const currentRequests = requestCounts.get(rateLimitKey) || { count: 0, windowStart: now };
  if (now - currentRequests.windowStart > RATE_LIMIT_WINDOW) {
    // Reset window
    currentRequests.count = 0;
    currentRequests.windowStart = now;
  }

  if (currentRequests.count >= MAX_REQUESTS_PER_WINDOW) {
    throw new Error(`Rate limit exceeded for ${username}. Please wait before retrying.`);
  }

  // Check cache first
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (now - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }
  }

  // Increment request count
  currentRequests.count++;
  requestCounts.set(rateLimitKey, currentRequests);

  try {
    // Use Kick's public API
    const apiUrl = `https://kick.com/api/v2/channels/${username}`;
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      timeout: 10000 // 10 second timeout
    });

    if (!res.ok) {
      throw new Error(`Kick request failed: ${res.status}`);
    }

    const json = await res.json();
    const live = !!json?.livestream;
    const title = json?.livestream?.session_title || json?.livestream?.recent_categories?.[0]?.name;
    const url = `https://kick.com/${username}`;
    const thumbnail = json?.livestream?.thumbnail?.url;
    const banner = json?.banner_image?.url || json?.banner_image;

    const result = { live, title, url, thumbnail, banner, json };

    // Cache the result
    cache.set(cacheKey, {
      data: result,
      timestamp: now
    });

    return result;
  } catch (error) {
    // If API fails, return cached data if available (even if expired)
    if (cache.has(cacheKey)) {
      console.warn(`Kick API failed for ${username}, using stale cache:`, error.message);
      return cache.get(cacheKey).data;
    }
    throw error;
  }
}

module.exports = { checkKickLive };

// Periodic cleanup of old cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION * 2) {
      cache.delete(key);
    }
  }

  // Clean up old rate limit entries
  for (const [key, value] of requestCounts.entries()) {
    if (now - value.windowStart > RATE_LIMIT_WINDOW * 2) {
      requestCounts.delete(key);
    }
  }
}, 5 * 60 * 1000); // Clean up every 5 minutes
