'use strict';
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const parser = new Parser();

function channelRssUrl(channelUrl) {
  const m = channelUrl.match(/channel\/([A-Za-z0-9_-]+)/);
  if (m) return `https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}`;
  if (channelUrl.includes('feeds/videos.xml')) return channelUrl;
  return null;
}

async function fetchLatestVideo(channelUrlOrRss) {
  const rss = channelUrlOrRss.startsWith('http') && channelUrlOrRss.includes('feeds/videos.xml')
    ? channelUrlOrRss
    : channelRssUrl(channelUrlOrRss);
  if (!rss) throw new Error('Could not derive YouTube RSS URL from channel input.');
  const feed = await parser.parseURL(rss);
  const item = feed.items?.[0];
  if (!item) return null;
  return {
    id: item.id || item.guid || item.link,
    title: item.title,
    url: item.link,
    published: item.isoDate || item.pubDate,
  };
}

module.exports = { fetchLatestVideo };

// --- Livestream detection ---

function extractChannelId(input) {
  const m = input.match(/channel\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const url = new URL(input, 'https://www.youtube.com');
  const cid = url.searchParams.get('channel_id');
  return cid || null;
}

async function checkYouTubeLive(channelUrlOrId) {
  const id = channelUrlOrId.startsWith('UC')
    ? channelUrlOrId
    : extractChannelId(channelUrlOrId);
  if (!id) throw new Error('Could not determine channel ID for YouTube live check.');
  const liveUrl = `https://www.youtube.com/channel/${id}/live`;
  const res = await fetch(liveUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  const finalUrl = res.url || liveUrl;
  const html = await res.text();

  // Helper to extract JSON from inline player response
  function extractJsonVar(name) {
    const patterns = [
      new RegExp('(?:var\\s+)?' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\});'),
      new RegExp('(?:window\\.|self\\.)' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\});'),
      new RegExp('\\[\\s*[\"\']' + name + '[\"\']\\s*\\]\\s*=\\s*(\\{[\\s\\S]*?\\});'),
    ];
    for (const rx of patterns) {
      const m = html.match(rx);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch (_) {
          // try next pattern
        }
      }
    }
    return null;
  }

  const player = extractJsonVar('ytInitialPlayerResponse');
  const data = extractJsonVar('ytInitialData');

  const liveByUrl = /\/watch\?v=/.test(finalUrl);
  const liveFlag = /"isLiveNow"\s*:\s*true/.test(html)
    || player?.videoDetails?.isLiveContent === true
    || !!player?.playabilityStatus?.liveStreamability;

  let videoId = null;
  let title = 'Live Stream';

  if (player) {
    videoId = player?.videoDetails?.videoId || videoId;
    title = player?.videoDetails?.title || title;
  }
  if (!videoId && data) {
    // Fallback: try to find first watch URL in data blob
  const watchMatch = html.match(/watch\?v=([A-Za-z0-9_-]{6,})/);
    if (watchMatch) videoId = watchMatch[1];
  }

  if (!(liveByUrl || liveFlag) || !videoId) {
    return { live: false, url: liveUrl };
  }

  const watchUrl = /watch\?v=/.test(finalUrl) ? finalUrl : `https://www.youtube.com/watch?v=${videoId}`;
  return { live: true, url: watchUrl, title, videoId };
}

module.exports.checkYouTubeLive = checkYouTubeLive;

// Check live status directly from a watch URL
async function checkYouTubeWatchUrl(watchUrl) {
  if (!/^https?:\/\/www\.youtube\.com\/watch\?v=/.test(watchUrl)) {
    return { live: false, url: watchUrl };
  }
  const res = await fetch(watchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await res.text();

  function extractJsonVar(name) {
    const patterns = [
      new RegExp('(?:var\\s+)?' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\});'),
      new RegExp('(?:window\\.|self\\.)' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\});'),
      new RegExp('\\[\\s*[\"\']' + name + '[\"\']\\s*\\]\\s*=\\s*(\\{[\\s\\S]*?\\});'),
    ];
    for (const rx of patterns) {
      const m = html.match(rx);
      if (m) {
        try { return JSON.parse(m[1]); } catch (_) {}
      }
    }
    return null;
  }

  const player = extractJsonVar('ytInitialPlayerResponse');
  const liveFlag = /"isLiveNow"\s*:\s*true/.test(html)
    || player?.videoDetails?.isLiveContent === true
    || !!player?.playabilityStatus?.liveStreamability;

  const videoId = player?.videoDetails?.videoId || (watchUrl.match(/[?&]v=([A-Za-z0-9_-]{6,})/)?.[1] ?? null);
  const title = player?.videoDetails?.title || 'Live Stream';

  return { live: !!liveFlag, url: watchUrl, title, videoId };
}

module.exports.checkYouTubeWatchUrl = checkYouTubeWatchUrl;
