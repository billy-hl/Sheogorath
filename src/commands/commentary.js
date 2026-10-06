'use strict';
/**
 * Right-click a message with a clip, Apps, "Mad God commentary": he watches it
 * and posts it back with himself talking over it (services/commentary.js).
 *
 * Clips posted in the guild's clips channel get this on their own. The menu is
 * for everywhere else, and for asking again.
 */
const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { fromMenu } = require('../services/clips');

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Mad God commentary')
    .setType(ApplicationCommandType.Message),

  execute: (interaction) => fromMenu(interaction, 'commentary'),
};
