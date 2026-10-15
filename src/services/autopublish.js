'use strict';
/**
 * Publishes what he posts in a guild's `autoPublish` channels, so it reaches
 * every server that follows them.
 *
 * A post in an Announcement channel goes no further than the channel until it
 * is published, and Discord leaves that to whoever posted it. Everything he
 * puts in #announcements is meant for the followers (the YouTube watcher, the
 * devlog notes, Steam news), so he publishes his own there as each lands. That
 * includes posts made by scripts over REST: they are his messages too, and the
 * gateway tells him of them like any other.
 *
 * Only his own: a person posting in the channel gets Discord's own Publish
 * button and decides for themselves. Discord allows ten publishes an hour per
 * channel; past that one is refused and logged, not retried.
 */
const { ChannelType } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');

function watchOwnPosts(client) {
  client.on('messageCreate', async (message) => {
    if (message.author.id !== client.user.id || !message.guildId) return;
    if (!getGuildConfig(message.guildId)?.autoPublish.includes(message.channelId)) return;
    if (message.channel.type !== ChannelType.GuildAnnouncement || !message.crosspostable) return;
    try {
      await message.crosspost();
    } catch (err) {
      console.warn(`[AutoPublish] ${message.guild?.name}: could not publish ${message.id}: ${err?.message || err}`);
    }
  });
}

module.exports = { watchOwnPosts };
