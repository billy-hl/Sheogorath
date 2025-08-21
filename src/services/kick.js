'use strict';
const fetch = require('node-fetch');

// Returns { live: boolean, title?: string, url: string }
async function checkKickLive(channelUrl) {
  // Extract username from Kick URL
  const m = channelUrl.match(/kick\.com\/(\w+)/);
  const username = m ? m[1] : null;
  if (!username) throw new Error('Invalid Kick channel URL');
  // Use Kick's public API
  const apiUrl = `https://kick.com/api/v2/channels/${username}`;
  const res = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Kick request failed: ${res.status}`);
  const json = await res.json();
  const live = !!json?.livestream;
  const title = json?.livestream?.session_title || json?.livestream?.recent_categories?.[0]?.name;
  const url = `https://kick.com/${username}`;
  const thumbnail = json?.livestream?.thumbnail?.url;
  const banner = json?.banner_image?.url || json?.banner_image;
  return { live, title, url, thumbnail, banner, json };
}

module.exports = { checkKickLive };
