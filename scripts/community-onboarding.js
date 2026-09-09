#!/usr/bin/env node
'use strict';
/**
 * The new-member flow for Wabbajack Community: welcome screen, default
 * channels, and the onboarding prompts.
 *
 * Discord has no partial update here — PUT /guilds/{id}/onboarding replaces the
 * whole configuration — so this file is the source of truth rather than a patch
 * against whatever is live. Re-running it restores exactly this, which is the
 * point: the flow was hand-set once and there was nothing in the repo to say
 * what it should be.
 *
 * Two warnings earned the hard way:
 *
 *   1. Enabling onboarding also switches on Server Member Applications — a
 *      manual-approval form with a default "why do you want to join" question.
 *      That is an approval queue, not a rules gate. This script rewrites the
 *      verification form to a TERMS-only one and checks the flag afterwards.
 *   2. Every prompt and option must carry an `id`, and it has to be
 *      snowflake-shaped. Omitting it is rejected as a missing field, and "0"
 *      is only accepted while the guild has never had onboarding configured —
 *      afterwards Discord tries to resolve it against the existing prompts and
 *      answers INVALID_ONBOARDING_PROMPT_ID. So new prompts get synthesised
 *      IDs from the counter below. Discord assigns real ones on write, which
 *      means a re-run replaces the prompts rather than editing them in place.
 *      Nothing references those IDs, so that is churn, not breakage.
 *
 *   node scripts/community-onboarding.js            # show what would be sent
 *   node scripts/community-onboarding.js --apply
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Events, Routes, ChannelType } = require('discord.js');

const GUILD = process.argv.find((a) => /^\d{17,20}$/.test(a)) || '1547233037765578822';
const APPLY = process.argv.includes('--apply');

/** Channels every new member is opted into. Must satisfy Discord's >=7 readable / >=5 postable. */
const DEFAULT_CHANNELS = ['rules', 'announcements', 'roles', 'general', 'media', 'help',
  'music', 'live', 'wardogs-general', 'wardogs-lfg', 'wardogs-clips'];

/**
 * `roles` are granted by picking the option; `channels` are revealed by it.
 * `single`/`required` are what make the faction question a choice rather than a
 * checklist — one team, and you do not get past it without saying which.
 */
const PROMPTS = [
  {
    title: 'Pick your faction',
    single: true,
    required: true,
    options: [
      { title: 'Lonestar', description: 'Blue team', emoji: '🟦', role: 'Lonestar', channel: 'Lonestar' },
      { title: 'Valkyra', description: 'Red team', emoji: '🟥', role: 'Valkyra', channel: 'Valkyra' },
      { title: 'Manticore', description: 'Green team', emoji: '🟩', role: 'Manticore', channel: 'Manticore' },
    ],
  },
  {
    title: 'What do you want to be pinged for?',
    single: false,
    required: false,
    options: [
      { title: 'Wardogs', description: 'Pinged when people are getting a group together', emoji: '🐕', role: 'Wardogs', channel: 'wardogs-lfg' },
      { title: 'Streams', description: 'Pinged when Allisteras or Fish go live', emoji: '🔴', role: 'Streams', channel: 'live' },
    ],
  },
];

const WELCOME = {
  description: 'A common room for people who play things together. Wardogs for now.',
  channels: [
    ['rules', 'Read this first', '📜'],
    ['general', 'Say hello', '💬'],
    ['roles', 'Pick what pings you', '🔔'],
    ['wardogs-lfg', 'Find a group', '🐕'],
    ['live', 'When we are streaming', '🔴'],
  ],
};

const RULES = [
  'Be civil. No harassment, slurs, or bigotry. If someone asks you to drop it, drop it.',
  'Keep the shared rooms non-explicit. No porn, no gore for its own sake.',
  'Post it in the right room. Nobody is in trouble for guessing wrong.',
  'No spam, no drive-by advertising.',
  "Leave other people's fights where you found them.",
  'Voice: no ear-rape, no music over a conversation, no recording without saying so.',
  'Sheogorath is a bot, not the appeal process. Real problems go to a Warden.',
  "Discord's own rules still apply. 13+, nothing illegal, no ban evasion.",
];

/**
 * Synthetic snowflake-shaped IDs for prompts and options we are creating.
 * The value is never persisted — Discord issues the real one — it only has to
 * be well-formed and unique within this request.
 */
let idSeq = 0;
const newId = () => String(1547300000000000000n + BigInt(++idSeq));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(GUILD);
    await guild.channels.fetch();
    await guild.roles.fetch();

    const channel = (name) => guild.channels.cache.find((c) => c.name === name);
    const role = (name) => guild.roles.cache.find((r) => r.name === name);

    const missing = [];
    const defaults = DEFAULT_CHANNELS.map((n) => (channel(n) || missing.push('#' + n)) && channel(n).id);
    const prompts = PROMPTS.map((p) => ({
      id: newId(),
      type: 0,
      title: p.title,
      single_select: p.single,
      required: p.required,
      in_onboarding: true,
      options: p.options.map((o) => {
        if (!role(o.role)) missing.push('@' + o.role);
        if (!channel(o.channel)) missing.push('#' + o.channel);
        return {
          id: newId(),
          title: o.title,
          description: o.description,
          emoji: { name: o.emoji },
          role_ids: role(o.role) ? [role(o.role).id] : [],
          channel_ids: channel(o.channel) ? [channel(o.channel).id] : [],
        };
      }),
    }));
    if (missing.length) return console.log('Missing: ' + [...new Set(missing)].join(', '));

    console.log(`Onboarding for ${guild.name}${APPLY ? '' : ' (preview)'}`);
    console.log(`  default channels: ${defaults.length}`);
    for (const p of prompts) {
      console.log(`  prompt "${p.title}" single=${p.single_select} required=${p.required}`);
      for (const o of p.options) console.log(`      ${o.emoji.name} ${o.title} — ${o.description}`);
    }
    if (!APPLY) return console.log('\n(preview — pass --apply to execute)');

    await client.rest.put(Routes.guildOnboarding(GUILD), {
      body: { enabled: true, mode: 0, default_channel_ids: defaults, prompts },
      reason: 'community onboarding',
    });

    await guild.editWelcomeScreen({
      enabled: true,
      description: WELCOME.description,
      welcomeChannels: WELCOME.channels.map(([n, d, e]) => ({ channel: channel(n).id, description: d, emoji: e })),
      reason: 'community welcome screen',
    });

    // Onboarding turns the applications form on behind our back. Put it back to
    // rules-acceptance and prove the approval queue is off.
    await client.rest.patch(`/guilds/${GUILD}/member-verification`, {
      body: {
        enabled: true,
        description: 'Read the rules, agree, and you are in. There is nothing to apply for.',
        form_fields: [{ field_type: 'TERMS', label: 'Read and agree to the server rules', required: true, values: RULES }],
      },
      reason: 'rules acceptance, not an application',
    }).catch((e) => console.log('  ! member-verification patch failed: ' + (e.message || e)));

    const live = await client.rest.get(Routes.guildOnboarding(GUILD));
    const refetched = await client.guilds.fetch(GUILD);
    console.log(`\nAPPLIED\n  onboarding enabled=${live.enabled} prompts=${live.prompts.length} defaults=${live.default_channel_ids.length}`);
    console.log(`  rules gate=${refetched.features.includes('MEMBER_VERIFICATION_GATE_ENABLED')} manual approval=${refetched.features.includes('MEMBER_VERIFICATION_MANUAL_APPROVAL')}`);
  } catch (err) {
    console.error(err.rawError ? JSON.stringify(err.rawError, null, 2) : err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
