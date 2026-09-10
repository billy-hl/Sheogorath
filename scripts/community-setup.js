#!/usr/bin/env node
'use strict';
/**
 * Stands up the Wabbajack Community guild: role ladder, categories, channels,
 * and the config/guilds.json entry that makes the bot recognise any of it.
 *
 * The server is a community hall that happens to be playing something, not a
 * server for one game. Wardogs gets its own category and its own pingable role
 * and nothing else — so when the group moves on, retiring a game is deleting a
 * category and a role, not unpicking it from the rest of the structure. That is
 * the whole reason the ladder is Owner/Warden/Veteran/Member and not something
 * with dogs in it.
 *
 * Follows the same contract as services/forums/setup.js: `plan()` is pure and
 * prints what would happen, `apply()` only runs when asked, and everything is
 * idempotent — existing roles and channels are adopted by name rather than
 * duplicated, so a second run repairs whatever was deleted by hand.
 *
 *   node scripts/community-setup.js                 # dry run
 *   node scripts/community-setup.js --apply
 *   node scripts/community-setup.js <guildId>       # explicit target
 *
 * Config is read and written as raw JSON rather than through
 * src/config/guilds.js, for the same reason pz-roles.js does it: the running
 * bot caches its config, so this process writing through the normaliser would
 * neither refresh the service nor be guaranteed to round-trip a key the
 * checked-out code doesn't know. Restart the service afterwards.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'guilds.json');
const APPLY = process.argv.includes('--apply');
const ARG_ID = process.argv.find((a) => /^\d{17,20}$/.test(a)) || null;
const GUILD_NAME = 'Wabbajack Community';

// Lifted from the server icon so the member list and the avatar agree.
const GOLD = 0xe8b652;
const MAGENTA = 0xc648aa;
const PLUM = 0x9b6fbf;
const MUTED = 0x6e7480;
const GREEN = 0x80d878;
const TWITCH = 0x9146ff;
const TEAM_RED = 0xe0453e;
const TEAM_GREEN = 0x3ba55d;
const TEAM_BLUE = 0x4a8fe0;

/**
 * The ladder, highest first. Created bottom-up so Discord's "new roles go at
 * the bottom" lands them in this order without a second reposition call.
 *
 * Owner carries no Discord permissions at all — it is the bot-admin marker,
 * recorded as roles.admin, and the human who owns the guild already outranks
 * everything by owning it. Warden is the tier that actually moderates, and is
 * the only role here granted anything by Discord itself.
 */
const ROLES = [
  { key: 'admin', name: 'Owner', color: GOLD, hoist: true, perms: [] },
  { key: 'staff', name: 'Warden', color: MAGENTA, hoist: true, mentionable: true, perms: [
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.MuteMembers,
      PermissionFlagsBits.DeafenMembers,
      PermissionFlagsBits.MoveMembers,
    ] },
  // The teams sit directly under Warden, and the position is the whole point.
  // Discord colours a member by their highest COLOURED role and files them in
  // the member list under their highest HOISTED one, so a team only shows if it
  // outranks Wardogs and Streams — which are coloured too, and which most people
  // will also be holding.
  //
  // They stop below Warden rather than going to the top, because position is
  // also the moderation hierarchy: a Warden can only act on members whose
  // highest role is beneath their own. Teams above Warden would quietly cost
  // the Wardens the ability to moderate anyone on a team.
  //
  // Self-assignable, and sticky: a faction is picked once and the buttons will
  // not move you afterwards. Each gates its own voice room below.
  { key: null, name: 'Lonestar', color: TEAM_BLUE, hoist: true, perms: [], mentionable: true, team: true,
    selfAssign: { emoji: '🟦', description: 'Blue team.', group: 'team', sticky: true } },
  { key: null, name: 'Valkyra', color: TEAM_RED, hoist: true, perms: [], mentionable: true, team: true,
    selfAssign: { emoji: '🟥', description: 'Red team.', group: 'team', sticky: true } },
  { key: null, name: 'Manticore', color: TEAM_GREEN, hoist: true, perms: [], mentionable: true, team: true,
    selfAssign: { emoji: '🟩', description: 'Green team.', group: 'team', sticky: true } },
  { key: 'veteran', name: 'Veteran', color: PLUM, hoist: false, perms: [] },
  { key: 'member', name: 'Member', color: MUTED, hoist: false, perms: [] },
  // Not part of the ladder and not recorded in config: a pingable opt-in for
  // whoever wants LFG noise. Mentionable by anyone, grants nothing.
  { key: null, name: 'Wardogs', color: GREEN, hoist: false, perms: [], mentionable: true,
    selfAssign: { emoji: '🐕', description: 'Pinged when people are getting a Wardogs group together.' } },
  { key: null, name: 'Streams', color: TWITCH, hoist: false, perms: [], mentionable: true,
    selfAssign: { emoji: '🔴', description: 'Pinged when Allisteras or Fish go live on Twitch.' } },
];

/**
 * `locked` — everyone can read, only staff can post (announcements, rules).
 * `staffOnly` — hidden from everyone but Owner and Warden.
 * `configKey` — where the created channel's ID is recorded in guilds.json.
 */
const TREE = [
  { category: 'INFORMATION', channels: [
      { name: 'rules', configKey: 'rules', locked: true,
        topic: 'How this place works. Sheogorath quotes this channel when asked, so keep it current.' },
      { name: 'announcements', locked: true,
        topic: 'Server news. Staff post, everyone reads.' },
    ] },
  { category: 'COMMUNITY', channels: [
      { name: 'general', topic: 'The common room.' },
      { name: 'media', topic: 'Clips, screenshots, and whatever you found funny.' },
      { name: 'help', configKey: 'help',
        topic: 'Ask here. Sheogorath answers in this channel without being called by name.' },
      { name: 'music', configKey: 'music',
        topic: 'Now-playing cards and music controls.' },
      { name: 'live', twitchChannel: true, locked: true, postFrom: 'veteran',
        topic: 'Twitch announcements. Veterans and above can talk here; take the Streams role in #roles for the ping.' },
      // Not locked: the bot announces the house channel's uploads here, and
      // everyone else is welcome to post their own alongside them.
      // A destination for Discord's channel-following, not a room anyone types
      // in. Followed announcements arrive over a webhook, which ignores the
      // SendMessages overwrite entirely — so locking it to staff costs the
      // feature nothing and keeps the feed clean.
      { name: 'game-updates', locked: true,
        topic: 'Patch notes and news, followed in from other servers. Nobody posts here directly.' },
      { name: 'videos', youtubeChannel: true,
        topic: 'Videos. The bot posts new uploads from the house channel; post your own too.' },
    ] },
  { category: 'WARDOGS', channels: [
      { name: 'wardogs-general', topic: 'Wardogs talk.' },
      { name: 'wardogs-lfg', topic: 'Looking for a group. Ping @Wardogs.' },
      { name: 'wardogs-clips', topic: 'Wardogs clips and highlights.' },
      { name: 'Lonestar', type: ChannelType.GuildVoice, restrictTo: 'Lonestar' },
      { name: 'Valkyra', type: ChannelType.GuildVoice, restrictTo: 'Valkyra' },
      { name: 'Manticore', type: ChannelType.GuildVoice, restrictTo: 'Manticore' },
    ] },
  { category: 'VOICE', channels: [
      // Staff room, and the channel the companion app falls back to. Still
      // recorded as defaultVoice: the bot joins it whether or not anyone else
      // may, and restricting Connect does not restrict the bot.
      { name: 'Admin Voice', type: ChannelType.GuildVoice, configKey: 'defaultVoice', staffVoice: true },
      // Join it and you get a room of your own; it is deleted when the last
      // person leaves. Sits above the fixed squads because it is the one people
      // are meant to click.
      { name: '➕ New Room', type: ChannelType.GuildVoice, voiceLobby: true },
      { name: 'Squad One', type: ChannelType.GuildVoice },
      { name: 'Squad Two', type: ChannelType.GuildVoice },
    ] },
  { category: 'STAFF', staffOnly: true, channels: [
      { name: 'staff-chat', topic: 'Warden and Owner only.' },
      { name: 'command-log', configKey: 'commandLog',
        topic: 'Privileged command invocations, and what Sheogorath wants permission to do.' },
      // Discord's own moderator notices, required as the public-updates channel
      // once the guild is a Community server. Kept apart from command-log,
      // which staff are expected to act on.
      { name: 'mod-updates',
        topic: 'Discord posts moderator and community notices here. Not the bot.' },
    ] },
];

const YOUTUBE_FEEDS = [
  { channelId: 'UCimHc9QeZGIDuwZsyj5MTQA', name: 'Allisteras', handle: '@Allisteras' },
];

const STREAMERS = [
  { login: 'allisteras', name: 'Allisteras' },
  { login: 'stickmanfish', name: 'Fish' },
];

const FEATURES = ['ai', 'music', 'moderation', 'instagram', 'textImageMod', 'automod'];

const STANDING =
  "This is the Wabbajack Community's common room — a social hall that gathers " +
  'around whatever game is current, Wardogs for the moment. You are its host and ' +
  'its resident lunatic: you greet, you needle, you remember what people tell you, ' +
  'and you keep the room civil without ever being the reason someone leaves it. ' +
  'The Wardens hold the authority here; you hold the room’s attention.';

// Everything the social hall gives him, minus kick. A guild whose members have
// not met him yet does not need him reaching for the door on his own.
const POWERS = ['note', 'memory', 'clearnotes', 'flag', 'delete', 'timeout', 'title',
  'untitle', 'dm', 'say', 'react', 'pin', 'thread', 'poll', 'nick', 'channel'];

const REQUIRED = [
  ['ManageRoles', PermissionFlagsBits.ManageRoles],
  ['ManageChannels', PermissionFlagsBits.ManageChannels],
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
];

const lower = (s) => String(s).toLowerCase();
const findRole = (guild, name) =>
  guild.roles.cache.find((r) => lower(r.name) === lower(name)) || null;
const findChannel = (guild, name, type) =>
  guild.channels.cache.find((c) => lower(c.name) === lower(name) && c.type === type) || null;

function plan(guild) {
  const steps = [];
  const blocked = guild.members.me
    ? REQUIRED.filter(([, f]) => !guild.members.me.permissions.has(f)).map(([n]) => n)
    : REQUIRED.map(([n]) => n);

  for (const spec of ROLES) {
    const existing = findRole(guild, spec.name);
    steps.push({ kind: 'role', spec, existing,
      action: existing ? 'adopt' : 'create',
      detail: existing ? `already exists (${existing.id})` : `create, ${spec.perms.length} permission(s)` });
  }
  for (const cat of TREE) {
    const existingCat = findChannel(guild, cat.category, ChannelType.GuildCategory);
    steps.push({ kind: 'category', spec: cat, existing: existingCat,
      action: existingCat ? 'adopt' : 'create',
      detail: existingCat ? `already exists (${existingCat.id})` : (cat.staffOnly ? 'create, staff-only' : 'create') });
    for (const ch of cat.channels) {
      const type = ch.type || ChannelType.GuildText;
      const existing = findChannel(guild, ch.name, type);
      const misparented = existing && (!existingCat || existing.parentId !== existingCat.id);
      steps.push({ kind: 'channel', spec: ch, parent: cat, existing,
        action: existing ? (misparented ? 'adopt+move' : 'adopt') : 'create',
        detail: existing
          ? `exists (${existing.id})${misparented ? `, move into ${cat.category}` : ''}${ch.configKey ? ` → channels.${ch.configKey}` : ''}`
          : `create in ${cat.category}${ch.locked ? ', read-only' : ''}${ch.configKey ? ` → channels.${ch.configKey}` : ''}` });
    }
  }
  return { steps, blocked };
}

async function apply(guild) {
  const roleIds = {};
  const selfRoles = [];
  const retinted = [];
  let liveChannelId = null;
  let youtubeChannelId = null;
  let lobbyChannelId = null;
  let streamsRoleId = null;
  const teamRoleIds = {};
  const created = { roles: 0, channels: 0 };
  let moved = 0;
  let reordered = false;
  const channelIds = {};

  // Top-down: Discord drops each new role at position 1 and pushes the
  // existing ones up, so creating the HIGHEST rung first leaves the ladder in
  // the intended order. (Creating bottom-up inverts it — which is exactly what
  // the first run of this script did.)
  const ladder = [];
  for (const spec of ROLES) {
    let role = findRole(guild, spec.name);
    if (!role) {
      role = await guild.roles.create({
        name: spec.name,
        color: spec.color,
        hoist: spec.hoist,
        mentionable: !!spec.mentionable,
        permissions: spec.perms,
        reason: 'Wabbajack Community setup',
      });
      created.roles++;
    }
    // Appearance is reconciled on every run, not just at creation. These are
    // exactly the properties someone gets wrong first time — the colours below
    // were assigned to the wrong three teams — and a script that can only set
    // them once is no use the moment that happens.
    const patch = {};
    if (role.color !== spec.color) patch.color = spec.color;
    if (role.hoist !== !!spec.hoist) patch.hoist = !!spec.hoist;
    if (role.mentionable !== !!spec.mentionable) patch.mentionable = !!spec.mentionable;
    if (Object.keys(patch).length && role.editable) {
      await role.edit({ ...patch, reason: 'Wabbajack Community setup' });
      retinted.push(`${role.name} (${Object.keys(patch).join(', ')})`);
    }

    if (spec.key) roleIds[spec.key] = role.id;
    // Everyone who joins is given Member, by services/autorole.js.
    if (spec.key === 'member') roleIds.onJoin = role.id;
    if (spec.selfAssign) selfRoles.push({ role: role.id, label: spec.name, ...spec.selfAssign });
    if (spec.name === 'Streams') streamsRoleId = role.id;
    if (spec.team) teamRoleIds[spec.name] = role.id;
    ladder.push(role);
  }

  // Creation order only gets it right on a virgin guild. Setting positions
  // explicitly makes a re-run repair a ladder that has drifted or was built by
  // an earlier, wronger version of this script. Positions are 1-based from the
  // bottom, and everything here must stay below the bot's own highest role —
  // Discord refuses edits at or above it — so the top of our ladder is
  // ladder.length, not the top of the guild.
  // One call per role, highest first. The bulk endpoint (roles.setPositions)
  // returns 50013 here: it submits the whole ordering, and the arrangement it
  // computes touches the bot's own managed role, which no bot may move. Moving
  // them one at a time never names that role and is accepted.
  // The ladder occupies the positions directly below the bot's own role. If
  // somebody has dragged a role above the bot, that ceiling drops and the top of
  // the ladder no longer fits — Discord answers that with a bare 50013, so it is
  // worth saying plainly rather than failing the whole run over cosmetics.
  const ceiling = guild.members.me?.roles.highest.position ?? 0;
  for (let i = 0; i < ladder.length; i++) {
    const want = ladder.length - i;
    if (want >= ceiling) {
      console.warn(`  ! cannot place "${ladder[i].name}" at ${want}: my own highest role sits at ${ceiling}. Drag it above the ladder and re-run.`);
      break;
    }
    if (ladder[i].position === want) continue;
    await ladder[i].setPosition(want);
    reordered = true;
  }

  /**
   * A read-only room, opened back up from a given rung down-ladder.
   *
   * `postFrom: 'veteran'` lets Veterans post as well as staff — for a channel
   * that is a feed by default but which regulars should be able to talk in.
   * Omitted, it stays staff-only.
   */
  const lockedFor = (postFrom) => [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] },
    ...(postFrom === 'veteran' && roleIds.veteran
      ? [{ id: roleIds.veteran, allow: [PermissionFlagsBits.SendMessages] }]
      : []),
    { id: roleIds.staff, allow: [PermissionFlagsBits.SendMessages] },
    { id: roleIds.admin, allow: [PermissionFlagsBits.SendMessages] },
  ];

  // Hidden from everyone but the team, and staff.
  //
  // These were visible-but-locked at first, on the reasoning that a hidden
  // channel makes the category look broken to anyone outside it. That held
  // while people had no faction; now that everyone is on one, the only thing
  // being spared is the sight of two rooms nobody can enter.
  const teamVoice = (roleId) => [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    { id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    { id: roleIds.staff, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    { id: roleIds.admin, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
  ];

  // Hidden outright, like the team rooms. The bot is exempt by holding
  // Administrator, which matters here: this channel is also `defaultVoice`, and
  // the companion app parks him in it whether or not anyone can see it.
  const staffVoice = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    { id: roleIds.staff, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    { id: roleIds.admin, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
  ];

  const staffView = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: roleIds.staff, allow: [PermissionFlagsBits.ViewChannel] },
    { id: roleIds.admin, allow: [PermissionFlagsBits.ViewChannel] },
  ];

  for (const cat of TREE) {
    let parent = findChannel(guild, cat.category, ChannelType.GuildCategory);
    if (!parent) {
      parent = await guild.channels.create({
        name: cat.category,
        type: ChannelType.GuildCategory,
        permissionOverwrites: cat.staffOnly ? staffView : undefined,
        reason: 'Wabbajack Community setup',
      });
      created.channels++;
    }
    for (const ch of cat.channels) {
      const type = ch.type || ChannelType.GuildText;
      let channel = findChannel(guild, ch.name, type);
      if (channel) {
        // Discord's auto-created #general and General sit in categories it made
        // itself. Adopting without moving would leave the tree half-built.
        if (channel.parentId !== parent.id) {
          await channel.setParent(parent.id, { lockPermissions: false, reason: 'Wabbajack Community setup' });
          moved++;
        }
        if (ch.locked) await channel.permissionOverwrites.set(lockedFor(ch.postFrom), 'Wabbajack Community setup');
        if (ch.staffVoice) await channel.permissionOverwrites.set(staffVoice, 'Wabbajack Community setup');
        if (ch.restrictTo) await channel.permissionOverwrites.set(teamVoice(teamRoleIds[ch.restrictTo]), 'Wabbajack Community setup');
        if (ch.topic && 'topic' in channel && !channel.topic) await channel.setTopic(ch.topic);
      } else {
        channel = await guild.channels.create({
          name: ch.name,
          type,
          parent: parent.id,
          topic: ch.topic,
          // Locked channels deny SendMessages to @everyone and hand it back to
          // the two staff roles; staff categories are inherited, not repeated.
          permissionOverwrites: ch.locked ? lockedFor(ch.postFrom)
            : ch.staffVoice ? staffVoice
              : ch.restrictTo ? teamVoice(teamRoleIds[ch.restrictTo]) : undefined,
          reason: 'Wabbajack Community setup',
        });
        created.channels++;
      }
      if (ch.configKey) channelIds[ch.configKey] = channel.id;
      if (ch.twitchChannel) liveChannelId = channel.id;
      if (ch.youtubeChannel) youtubeChannelId = channel.id;
      if (ch.voiceLobby) lobbyChannelId = channel.id;
    }
  }

  const raw = fs.existsSync(CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  const prev = raw[guild.id] || {};
  raw[guild.id] = {
    ...prev,
    name: 'wabbajack-community',
    features: FEATURES,
    // selfRoles is nulled rather than carried over: the buttons channel was
    // deleted, roles are picked during onboarding instead, and a stale id here
    // makes the poster script 404 and every link to it render broken.
    channels: { ...(prev.channels || {}), ...channelIds, suggestions: null, selfRoles: null },
    roles: { ...(prev.roles || {}), ...roleIds },
    zomboid: null,
    selfRoles,
    voiceRooms: lobbyChannelId ? {
      lobby: lobbyChannelId,
      category: null,
      maxPerUser: 2,
      maxTotal: 10,
      namePattern: "{user}'s room",
    } : null,
    youtube: {
      channel: youtubeChannelId,
      // No ping by default: an upload is not the interrupt that going live is.
      pingRole: null,
      pollMinutes: 15,
      feeds: YOUTUBE_FEEDS,
    },
    twitch: {
      channel: liveChannelId,
      pingRole: streamsRoleId,
      pollMinutes: 3,
      streamers: STREAMERS,
    },
    ai: {
      ...(prev.ai || {}),
      // Shadow only for a guild that has never said otherwise: capabilities.js
      // is explicit that somewhere nobody has read a week of judgement from
      // should watch, not punish.
      //
      // Preserved rather than reasserted, unlike `standing` and `powers` below.
      // Those are text this script owns and should be free to update; the mode
      // is an operational decision taken later and elsewhere, and a re-run that
      // silently walked a guild back from enforce to shadow would turn the
      // moderator off without anyone being told. This script did exactly that
      // once.
      mode: prev.ai?.mode || 'shadow',
      standing: STANDING,
      powers: POWERS,
      titles: { admin: 'Creator', staff: 'Warden' },
    },
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');

  return { created, moved, reordered, retinted, roleIds, channelIds, selfRoles, liveChannelId, youtubeChannelId, lobbyChannelId, streamsRoleId, teamRoleIds };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    let guild = ARG_ID ? await client.guilds.fetch(ARG_ID).catch(() => null) : null;
    if (!guild) {
      const hit = client.guilds.cache.find((g) => lower(g.name) === lower(GUILD_NAME));
      guild = hit ? await client.guilds.fetch(hit.id) : null;
    }
    if (!guild) {
      console.log(`Not in a guild named "${GUILD_NAME}". In: ` +
        (client.guilds.cache.map((g) => `${g.name} (${g.id})`).join(', ') || 'nothing'));
      return;
    }
    await guild.channels.fetch();
    await guild.roles.fetch();
    await guild.members.fetchMe();

    const p = plan(guild);
    console.log(`PLAN for ${guild.name} (${guild.id})`);
    console.log(`  blocked: ${p.blocked.length ? p.blocked.join(' | ') : 'nothing'}`);
    for (const s of p.steps) console.log(`  [${s.action}] ${s.kind} ${s.spec.name || s.spec.category} — ${s.detail}`);

    if (!APPLY) return console.log('\n(dry run — pass --apply to execute)');
    if (p.blocked.length) return console.log('\nRefusing to apply while blocked.');

    const r = await apply(guild);
    console.log(`\nAPPLY\n  created ${r.created.roles} role(s), ${r.created.channels} channel(s), moved ${r.moved}${r.reordered ? ', reordered the ladder' : ''}`);
    if (r.retinted.length) console.log(`  restyled: ${r.retinted.join('; ')}`);
    console.log(`  roles:    ${JSON.stringify(r.roleIds)}`);
    console.log(`  channels: ${JSON.stringify(r.channelIds)}`);
    console.log(`  selfRoles: ${JSON.stringify(r.selfRoles)}`);
    console.log(`  voice:    lobby ${r.lobbyChannelId}, 2 rooms per person, 10 total`);
    console.log(`  videos:   #videos ${r.youtubeChannelId}, ${YOUTUBE_FEEDS.map((f) => f.handle || f.name).join(', ')}`);
    console.log(`  teams:    ${Object.entries(r.teamRoleIds).map(([n, id]) => n + ' ' + id).join(', ') || 'none'}`);
    console.log(`  twitch:   #live ${r.liveChannelId}, ping role ${r.streamsRoleId}, ${STREAMERS.map((x) => x.login).join(' + ')}`);
    console.log(`  wrote ${CONFIG_FILE}`);
    console.log('\nRestart the service for the bot to pick this up.');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
