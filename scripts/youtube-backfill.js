#!/usr/bin/env node
'use strict';
/**
 * Posts uploads that predate the watcher.
 *
 * services/youtube.js deliberately says nothing about videos that already
 * existed when it first saw a feed — otherwise switching it on dumps fifteen
 * announcements into a channel. This is the other half of that decision: when
 * you *do* want the back catalogue posted, you ask for it here, and say how far
 * back to go.
 *
 * Announcing also marks the whole current feed as seen, so the watcher picks up
 * from this point rather than repeating what was just posted.
 *
 *   node scripts/youtube-backfill.js                  # plan, last 7 days
 *   node scripts/youtube-backfill.js --days 14
 *   node scripts/youtube-backfill.js --days 7 --apply
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { getGuildConfig } = require('../src/config/guilds');
const { fetchFeed } = require('../src/services/youtube');
const { getGuildState, setGuildState } = require('../src/storage/state');

const GUILD = process.argv.find((a) => /^\d{17,20}$/.test(a)) || '1547233037765578822';
const APPLY = process.argv.includes('--apply');
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 7;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const cfg = getGuildConfig(GUILD)?.youtube;
    if (!cfg?.channel || !cfg.feeds.length) return console.log('No youtube config for this guild.');

    const cutoff = Date.now() - DAYS * 86400 * 1000;
    const channel = await client.channels.fetch(cfg.channel);
    const seen = getGuildState(GUILD).youtubeSeen || {};
    const next = { ...seen };
    let posted = 0;

    for (const feed of cfg.feeds) {
      const videos = await fetchFeed(feed.channelId);           // oldest-first
      const wanted = videos.filter((v) => v.published && Date.parse(v.published) >= cutoff);
      console.log(`${feed.name}: ${videos.length} in feed, ${wanted.length} within ${DAYS} day(s)`);
      for (const v of wanted) {
        console.log(`   ${v.published.slice(0, 10)}  ${v.id}  ${v.title}`);
      }
      if (!APPLY) continue;

      for (const v of wanted) {
        await channel.send({
          content: `**${feed.name}** — https://www.youtube.com/watch?v=${v.id}`,
          allowedMentions: { parse: [] },
        });
        posted++;
      }
      // Everything currently in the feed counts as handled, posted or not, so
      // the watcher starts from here instead of announcing the rest as "new".
      next[feed.channelId] = videos.map((v) => v.id).slice(-50);
    }

    if (!APPLY) return console.log(`\n(plan — pass --apply to post into #${channel.name})`);
    setGuildState(GUILD, { youtubeSeen: next });
    console.log(`\nposted ${posted} video(s) into #${channel.name}, and marked the feed as seen.`);
  } catch (err) {
    console.error(err); process.exitCode = 1;
  } finally { await client.destroy(); }
});

client.login(process.env.DISCORD_TOKEN);
