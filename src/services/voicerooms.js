'use strict';
/**
 * Voice rooms that exist only while someone is in them.
 *
 * Joining the lobby makes you a room and moves you into it; the room is deleted
 * when the last person leaves. Nothing is created by a command and nothing has
 * to be tidied up afterwards, which is the point — a server that makes rooms on
 * request accumulates dead ones nobody will admit to owning.
 *
 * Two things this has to survive:
 *
 *   A restart. Which channels are ours is kept in guild state rather than
 *   inferred from names, so a room made before a restart is still deleted when
 *   it empties, and a channel somebody else made that happens to look like ours
 *   is never touched. Rooms already empty at startup are swept then.
 *
 *   Somebody holding the join button down. Joining the lobby is free and
 *   repeatable, so without a cap it is a one-click way to fill the channel list
 *   and the audit log. Past their limit, a member is moved into a room they
 *   already own instead of getting another.
 */
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');

const NAME_MAX = 100;

const roomsFor = (guildId) => getGuildState(guildId).voiceRooms || {};
const saveRooms = (guildId, rooms) => setGuildState(guildId, { voiceRooms: rooms });

function nameFor(member, pattern) {
  const raw = (pattern || "{user}'s room").replace('{user}', member.displayName);
  return raw.slice(0, NAME_MAX);
}

/** Create a room for `member` and move them into it. */
async function spawn(member, cfg) {
  const guild = member.guild;
  const lobby = guild.channels.cache.get(cfg.lobby);
  const parent = cfg.category || lobby?.parentId || null;

  const channel = await guild.channels.create({
    name: nameFor(member, cfg.namePattern),
    type: ChannelType.GuildVoice,
    parent,
    // Inherits the category, so an open category makes open rooms. The owner
    // gets manage rights over this one channel and nothing else: rename it, set a
    // user limit, drag people out of it.
    permissionOverwrites: [
      { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] },
    ],
    reason: `voice room for ${member.user.username}`,
  });

  const rooms = roomsFor(guild.id);
  rooms[channel.id] = member.id;
  saveRooms(guild.id, rooms);

  // If they left the lobby between joining and this point, the move throws and
  // the room is deleted on the next empty check rather than lingering.
  await member.voice.setChannel(channel).catch(() => {});
  console.log(`[VoiceRooms] ${guild.name}: made "${channel.name}" for ${member.user.username}.`);
  return channel;
}

async function onVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  const cfg = getGuildConfig(guild.id)?.voiceRooms;
  if (!cfg?.lobby) return;

  // --- Someone left a room of ours: delete it once it is empty. ---
  const left = oldState.channelId;
  if (left && left !== newState.channelId) {
    const rooms = roomsFor(guild.id);
    if (rooms[left]) {
      const channel = guild.channels.cache.get(left);
      if (!channel) {
        delete rooms[left];
        saveRooms(guild.id, rooms);
      } else if (channel.members.filter((m) => !m.user.bot).size === 0) {
        await channel.delete('voice room empty').catch(() => {});
        delete rooms[left];
        saveRooms(guild.id, rooms);
        console.log(`[VoiceRooms] ${guild.name}: removed "${channel.name}".`);
      }
    }
  }

  // --- Someone joined the lobby: give them a room. ---
  if (newState.channelId !== cfg.lobby) return;
  const member = newState.member;
  if (!member || member.user.bot) return;

  const rooms = roomsFor(guild.id);
  const live = Object.entries(rooms).filter(([id]) => guild.channels.cache.has(id));
  const mine = live.filter(([, ownerId]) => ownerId === member.id);

  if (mine.length >= (cfg.maxPerUser || 2)) {
    // At their limit. Put them in one they already own rather than leaving them
    // sitting in the lobby wondering why nothing happened.
    const existing = guild.channels.cache.get(mine[0][0]);
    if (existing) await member.voice.setChannel(existing).catch(() => {});
    console.log(`[VoiceRooms] ${guild.name}: ${member.user.username} is at their room limit.`);
    return;
  }
  if (live.length >= (cfg.maxTotal || 10)) {
    console.warn(`[VoiceRooms] ${guild.name}: at ${cfg.maxTotal} rooms, refusing to make another.`);
    return;
  }

  try {
    await spawn(member, cfg);
  } catch (err) {
    console.warn(`[VoiceRooms] ${guild.name}: could not make a room: ${err?.message || err}`);
  }
}

/**
 * Delete rooms that emptied while the bot was down.
 *
 * Without this a room whose last occupant left during a restart is never seen
 * to empty, and stays forever.
 */
async function sweepOrphans(client) {
  for (const guildId of guildIds()) {
    const cfg = getGuildConfig(guildId)?.voiceRooms;
    if (!cfg?.lobby) continue;
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;
    await guild.channels.fetch().catch(() => {});

    const rooms = roomsFor(guildId);
    let removed = 0;
    for (const id of Object.keys(rooms)) {
      const channel = guild.channels.cache.get(id);
      if (!channel) { delete rooms[id]; removed++; continue; }
      if (channel.members.filter((m) => !m.user.bot).size === 0) {
        await channel.delete('voice room empty at startup').catch(() => {});
        delete rooms[id];
        removed++;
      }
    }
    if (removed) {
      saveRooms(guildId, rooms);
      console.log(`[VoiceRooms] ${guild.name}: swept ${removed} empty room(s) left from before.`);
    }
  }
}

module.exports = { onVoiceStateUpdate, sweepOrphans };
