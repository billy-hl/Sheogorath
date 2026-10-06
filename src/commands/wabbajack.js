'use strict';
/**
 * Right-click a message with a clip, Apps, "Wabbajack": it comes back as
 * something else, chosen at random (services/wabbajack.js).
 */
const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { fromMenu } = require('../services/clips');

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Wabbajack')
    .setType(ApplicationCommandType.Message),

  execute: (interaction) => fromMenu(interaction, 'wabbajack'),
};
