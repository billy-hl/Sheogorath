#!/usr/bin/env node
'use strict';
/**
 * Posts the rules and the welcome note into Wabbajack Community.
 *
 * Idempotent by editing rather than appending: it looks for its own most recent
 * message in each channel and edits that, so re-running fixes a typo instead of
 * stacking a second copy under the first. A channel nobody has posted in yet
 * gets a fresh message.
 *
 * Worth knowing before editing the text: config/guilds.js points `channels.rules`
 * at #rules precisely so Sheogorath reads it and quotes it when asked. Whatever
 * is written here becomes what he tells people, so it needs to be true rather
 * than merely good-sounding.
 *
 *   node scripts/community-rules.js            # print what would be posted
 *   node scripts/community-rules.js --apply
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../src/config/guilds');
const { buildMessage } = require('../src/services/selfroles');

const GUILD_ID = process.argv.find((a) => /^\d{17,20}$/.test(a)) || '1547233037765578822';
const APPLY = process.argv.includes('--apply');
const GOLD = 0xe8b652;

const RULES = {
  title: 'Wabbajack Community — Rules',
  intro: 'Short version: be someone people are glad to see. Wardens read reports and act on them.',
  fields: [
    ['1. Be civil',
      'No harassment, slurs, bigotry or sexual content. Banter is fine and expected; a grudge carried into DMs is not. **If someone asks you to drop it, drop it** — that is the one that gets people removed.'],
    ['2. Keep the shared rooms non-explicit',
      'No porn, and no gore posted for its own sake. Swearing, dark humour and the violence in a game clip are all fine — this is not a family server, it is just not a NSFW one.'],
    ['3. Post it in the right room',
      'Talk in <#CHAN_GENERAL>, clips in <#CHAN_MEDIA>, questions in <#CHAN_HELP>, and anything Wardogs in its own category. Nobody is in trouble for guessing wrong.'],
    ['4. No spam, no drive-by advertising',
      'No unsolicited DM pitches and no dropping an invite link from an account nobody here has ever spoken to. Sharing your own stream, or a server you think people would like, is fine — you are a person here, not an advertisement.'],
    ['5. Leave other people\'s fights where you found them',
      'Do not import drama from another server or another game, and do not use this place to organise a pile-on somewhere else.'],
    ['6. Voice: do not be the reason people leave',
      'No ear-rape, no music played over a conversation, no recording or streaming a channel without saying so first.'],
    ['7. Sheogorath is a bot, and he is not the appeal process',
      'Talk to him, argue with him, ignore him — he answers to his name anywhere and unprompted in <#CHAN_HELP>. He can hand out titles and take a message. **Anything that actually matters goes to a Warden.**'],
    ['8. Discord\'s own rules still apply',
      '13 or older, nothing illegal, and no coming back around a removal on a second account.'],
    ['Reporting',
      'Ping a **@Warden** in <#CHAN_HELP>, or DM one. Include names and roughly when it happened. Warden decisions are final, but you are always welcome to ask why.'],
  ],
};

const WELCOME = {
  title: 'Welcome to Wabbajack Community',
  intro:
    'This is a common room for people who already play things together — somewhere to find a ' +
    'group, argue about a patch, post the clip, and sit in voice when nobody is playing anything ' +
    'at all. The game of the moment is **Wardogs**, and the place is deliberately not built ' +
    'around it: when we move on to something else, a category changes and the room stays.',
  fields: [
    ['Start here',
      'Read <#CHAN_RULES>. That is the whole of the gate — no application, nothing to fill in, and **Member** is handed to you automatically on the way in.'],
    ['Where things live',
      'Talk in <#CHAN_GENERAL>. Clips and screenshots in <#CHAN_MEDIA>. Questions in <#CHAN_HELP>. Wardogs has its own category, and voice is General, Squad One and Squad Two.'],
    ['What pings you, and which side you are on',
      'You were asked both on the way in: **@Wardogs** to be pulled into groups, **@Streams** to hear when someone goes live, and a faction. The pings you can change your mind about — **your faction you cannot**, so ask a Warden if it needs moving.'],
    ['When we are live',
      'Streams are announced in <#CHAN_LIVE> — **Allisteras** (twitch.tv/allisteras) and **Fish** (twitch.tv/stickmanfish). The announcement only pings people holding **@Streams**.'],
    ['The ladder',
      '**Member** on arrival. **Veteran** for the people who stay. **Warden** is staff — they moderate, and they are who you report to. **Owner** runs the place.'],
    ['The resident lunatic',
      'Sheogorath lives here. He answers to his name in any channel and speaks unprompted in <#CHAN_HELP>. He is currently watching rather than acting, which means he will form opinions about you and do nothing about them.'],
  ],
};

/** Channel mention placeholders, resolved from config + names so the text has no IDs in it. */
function resolve(text, ids) {
  return text
    .replace(/CHAN_GENERAL/g, ids.general).replace(/CHAN_MEDIA/g, ids.media)
    .replace(/CHAN_HELP/g, ids.help).replace(/CHAN_RULES/g, ids.rules)
    .replace(/CHAN_LIVE/g, ids.live);
}

function build(spec, ids) {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(spec.title)
    .setDescription(resolve(spec.intro, ids))
    .addFields(spec.fields.map(([name, value]) => ({ name, value: resolve(value, ids) })));
}

/** Edit our own last message in the channel if there is one; otherwise post. */
async function post(channel, payload, apply) {
  const recent = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  const mine = recent?.find((m) => m.author.id === channel.client.user.id && m.embeds.length);
  if (!apply) return mine ? `would EDIT ${mine.id}` : 'would POST a new message';
  // Components are passed explicitly on edit: omitting the key leaves old
  // buttons in place, which is not the same as this message having none.
  if (mine) { await mine.edit({ embeds: payload.embeds, components: payload.components || [] }); return `edited ${mine.id}`; }
  const sent = await channel.send(payload);
  await sent.pin().catch(() => {});
  return `posted ${sent.id}`;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    const cfg = getGuildConfig(GUILD_ID);
    const byName = (n) => guild.channels.cache.find((c) => c.name === n);

    const ids = {
      rules: cfg.channels.rules,
      help: cfg.channels.help,
      general: byName('general')?.id,
      media: byName('media')?.id,
      live: cfg.twitch?.channel,
    };
    const missing = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return console.log(`Missing channel(s): ${missing.join(', ')}`);

    const roleMsg = buildMessage(guild);
    const targets = [
      ['#rules', cfg.channels.rules, { embeds: [build(RULES, ids)] }],
      ['#announcements', byName('announcements')?.id, { embeds: [build(WELCOME, ids)] }],
    ];
    // Only when a guild actually has a buttons channel. This one had one, it
    // was deleted, and roles are picked during onboarding now — so the absence
    // is the normal case rather than a misconfiguration to warn about.
    if (roleMsg && cfg.channels.selfRoles) targets.push(['#roles', cfg.channels.selfRoles, roleMsg]);

    for (const [label, id, payload] of targets) {
      const channel = await guild.channels.fetch(id);
      const what = await post(channel, payload, APPLY);
      const e = payload.embeds[0].data;
      console.log(`\n===== ${label} — ${what} =====`);
      console.log(e.title);
      console.log(e.description);
      for (const f of e.fields || []) console.log(`\n  • ${f.name}\n    ${f.value}`);
      for (const row of payload.components || []) {
        console.log(`\n  [buttons] ${row.components.map((b) => b.data.label).join(' | ')}`);
      }
    }
    if (!APPLY) console.log('\n(dry run — pass --apply to post)');
  } catch (err) {
    console.error(err); process.exitCode = 1;
  } finally { await client.destroy(); }
});

client.login(process.env.DISCORD_TOKEN);
