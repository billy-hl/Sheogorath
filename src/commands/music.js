const { SlashCommandBuilder } = require('discord.js');
const { play, connectToChannel, getConnection, players } = require('../music/player');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube song in your voice channel')
    .addStringOption(option =>
      option.setName('url')
        .setDescription('YouTube URL or search term')
        .setRequired(true)),
  async execute(interaction) {
    const url = interaction.options.getString('url');
    console.log('DEBUG: /play url option value:', url);
    try {
      console.log('DEBUG: Attempting to defer reply...');
      await interaction.deferReply();
      console.log('DEBUG: deferReply succeeded.');
    } catch (err) {
      console.error('ERROR: deferReply failed:', err);
      return;
    }
    if (!url || typeof url !== 'string' || url.trim() === '') {
      try {
        console.log('DEBUG: Invalid url, sending editReply.');
        await interaction.editReply('❌ Please provide a valid YouTube URL or search term.');
      } catch (err) {
        console.error('ERROR: editReply failed (invalid url):', err);
      }
      return;
    }
    const member = interaction.member;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      try {
        console.log('DEBUG: No voice channel, sending editReply.');
        await interaction.editReply('Join a voice channel first!');
      } catch (err) {
        console.error('ERROR: editReply failed (no voice channel):', err);
      }
      return;
    }
    let connection = getConnection(interaction.guild);
    if (!connection) connection = connectToChannel(voiceChannel);
    try {
      console.log('DEBUG: Sending editReply: Playing:', url);
      await interaction.editReply(`Playing: ${url}`);
      const player = await play(connection, url, async () => {
        try {
          console.log('DEBUG: Song finished, sending followUp.');
          await interaction.followUp('Song finished!');
        } catch (e) {
          console.error('Could not send followUp after song finished:', e);
        }
      });
      players.set(interaction.guild.id, player);
    } catch (err) {
      console.error('Error playing music:', err);
      try {
        console.log('DEBUG: Sending editReply after play error.');
        await interaction.editReply('❌ Failed to play the requested audio. Please check the URL and try again.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
