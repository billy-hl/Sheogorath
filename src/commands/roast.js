'use strict';
/**
 * `/roast` — the Mad God insults somebody who asked for it.
 *
 * The whole design question here is consent, not comedy. A bot that will roast
 * any named user on demand is a harassment button with a persona on it: the
 * person being mocked never chose it, and the ping drags them in to watch. So
 * the target opts in for themselves and nobody can opt anybody else in. Roasting
 * yourself needs no record — asking is the consent.
 *
 * The second guard is on the material. Sheogorath is told to invent from the
 * Shivering Isles rather than from anything true about the person, because a
 * roast built on real detail is just an insult with a costume on, and the bot
 * has no business assembling one. Absurdity is the point; accuracy is the
 * failure mode.
 */
const { SlashCommandBuilder } = require('discord.js');
const { getAIResponse } = require('../ai/grok');
const { withoutLengthRules } = require('../ai/persona');
const { getGuildState, setGuildState } = require('../storage/state');
const { checkCooldown, setCooldown } = require('../utils/cooldowns');

const STATE_KEY = 'roastConsent';

/**
 * Long enough to build a joke, short enough that nobody is buried in it.
 * Replaces the persona's own cap rather than arguing with it — see ai/persona.js
 * for why contradicting that rule loses.
 */
const ROAST_LENGTH =
  'LENGTH: three to six sentences. Build to a punchline and stop. Never pad, and ' +
  'always finish the thought you started.';

/**
 * The rules that make this a roast rather than an insult.
 *
 * Stated as things to do instead of only things to avoid: a prompt that lists
 * prohibitions and nothing else tends to produce something that dodges every
 * one of them and still lands wrong.
 */
const ROAST_RULES = `
You are roasting a mortal WHO HAS ASKED FOR IT. This is affection wearing a
crown of insults — the tone of a friend who has known them for years, not the
tone of an enemy.

WHAT YOU ROAST: things you invent. Absurd Shivering Isles nonsense, cheese,
butterflies, imaginary crimes against your realm, ludicrous hypotheticals,
theatrical divine disappointment. The funnier and less true, the better.

WHAT YOU NEVER ROAST: anything that might actually be true about them. You do
not know this person and you must not pretend to. Nothing about appearance,
weight, race, gender, sexuality, religion, disability, mental health, money,
family, or their real history. No slurs. Nothing that would still sting after
they closed Discord.

The test: they should laugh, and a stranger reading it should be able to tell it
was meant with fondness. If a line only works as a genuine wound, it is the
wrong line — you are the Mad God, you can do better than cruelty.
`;

/** Everyone who has consented in this guild. */
function consentStore(guildId) {
  const raw = getGuildState(guildId)[STATE_KEY] || {};
  return raw && typeof raw === 'object' ? raw : {};
}

function hasConsented(guildId, userId) {
  return !!consentStore(guildId)[userId];
}

function setConsent(guildId, userId, consented) {
  const store = { ...consentStore(guildId) };
  if (consented) store[userId] = { at: new Date().toISOString() };
  else delete store[userId];
  setGuildState(guildId, { [STATE_KEY]: store });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roast')
    .setDescription('Invite the Mad God to insult you, theatrically')
    .addSubcommand((sub) =>
      sub
        .setName('at')
        .setDescription('Roast someone who has opted in — or yourself')
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription('Who to roast. Leave empty to roast yourself.')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('optin').setDescription('Allow others to aim /roast at you')
    )
    .addSubcommand((sub) =>
      sub.setName('optout').setDescription('Withdraw permission to be roasted')
    ),

  async execute(interaction) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === 'optin') {
      setConsent(guildId, interaction.user.id, true);
      return interaction.reply({
        content:
          '🧀 Noted, and savoured. You have volunteered, and the Mad God does not forget a volunteer. `/roast optout` when you tire of it.',
        flags: 64,
      });
    }

    if (sub === 'optout') {
      const had = hasConsented(guildId, interaction.user.id);
      setConsent(guildId, interaction.user.id, false);
      return interaction.reply({
        content: had
          ? '🦋 Very well. You are struck from the list. Dull, but respected.'
          : 'You were never on the list to begin with. Nothing has changed.',
        flags: 64,
      });
    }

    const target = interaction.options.getUser('user') || interaction.user;
    const isSelf = target.id === interaction.user.id;

    if (target.bot) {
      return interaction.reply({
        content: '❌ The Mad God does not waste material on machines.',
        flags: 64,
      });
    }

    // Asking to be roasted is consent. Asking on somebody else's behalf is not.
    if (!isSelf && !hasConsented(guildId, target.id)) {
      return interaction.reply({
        content: `❌ **${target.username}** has not opted in. They can run \`/roast optin\` themselves — and only they can.`,
        flags: 64,
      });
    }

    const wait = checkCooldown(interaction.user.id, 'roast');
    if (wait) {
      return interaction.reply({
        content: `⏳ Even chaos has a rhythm. Try again in ${wait}.`,
        flags: 64,
      });
    }

    if (Date.now() - interaction.createdTimestamp > 2500) {
      console.warn('[Roast] Dropping stale interaction');
      return;
    }

    try {
      await interaction.deferReply();
    } catch (err) {
      console.warn('[Roast] deferReply failed (stale interaction):', err.message);
      return;
    }

    setCooldown(interaction.user.id, 'roast');

    try {
      const who = isSelf
        ? `A mortal named ${target.username} has asked you to roast THEM personally.`
        : `A mortal has asked you to roast ${target.username}, who has already given permission to be roasted.`;

      const text = await getAIResponse(who, {
        maxTokens: 400,
        rawSystemPrompt: `${withoutLengthRules()}\n\n${ROAST_LENGTH}\n${ROAST_RULES}`,
      });

      console.log(`[Roast] ${interaction.user.username} -> ${target.username}`);

      // The model likes to separate every line with a blank one, which reads as
      // a wall of double-spaced text in Discord. Collapse runs of newlines back
      // to single breaks so the roast reads as one block.
      const tightened = String(text).replace(/\n{2,}/g, '\n').trim();

      // Only the person being roasted is pinged, whatever the model wrote.
      await interaction.editReply({
        content: `<@${target.id}> ${tightened}`,
        allowedMentions: { users: [target.id] },
      });
    } catch (err) {
      console.error('[Roast] Error:', err.message);
      await interaction
        .editReply('The Mad God is feeling uncharacteristically kind. Try again when the mood passes.')
        .catch(() => {});
    }
  },
};
