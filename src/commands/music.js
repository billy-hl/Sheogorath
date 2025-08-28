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
    try {
      await interaction.deferReply();
    } catch (err) {
      console.error('ERROR: deferReply failed:', err);
      return;
    }
    if (!url || typeof url !== 'string' || url.trim() === '') {
      try {
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
        await interaction.editReply('Join a voice channel first!');
      } catch (err) {
        console.error('ERROR: editReply failed (no voice channel):', err);
      }
      return;
    }
    let connection = getConnection(interaction.guild);
    if (!connection) connection = connectToChannel(voiceChannel);
    try {
      await interaction.editReply(`Playing: ${url}`);
      const player = await play(connection, url, async () => {
        try {
          await interaction.followUp('Song finished!');
        } catch (e) {
          console.error('Could not send followUp after song finished:', e);
        }
      });
      players.set(interaction.guild.id, player);
    } catch (err) {
      console.error('Error playing music:', err);
      try {
        await interaction.editReply('❌ Failed to play the requested audio. Please check the URL and try again.');
      } catch (e) {
        console.error('Could not editReply after error:', e);
      }
    }
  },
};
