const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { addToQueue, getQueue } = require('../music/player');

const PLAYLISTS_DIR = path.join(__dirname, '..', '..', 'data', 'playlists');

// Ensure playlists directory exists
if (!fs.existsSync(PLAYLISTS_DIR)) {
  fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
}

function getUserPlaylistPath(userId, playlistName) {
  return path.join(PLAYLISTS_DIR, `${userId}_${playlistName}.json`);
}

function getUserPlaylists(userId) {
  const files = fs.readdirSync(PLAYLISTS_DIR);
  const userPrefix = `${userId}_`;
  return files
    .filter(f => f.startsWith(userPrefix) && f.endsWith('.json'))
    .map(f => f.slice(userPrefix.length, -5)); // Remove prefix and .json
}

function savePlaylist(userId, playlistName, songs) {
  const filePath = getUserPlaylistPath(userId, playlistName);
  fs.writeFileSync(filePath, JSON.stringify({ name: playlistName, songs, created: Date.now() }, null, 2));
}

function loadPlaylist(userId, playlistName) {
  const filePath = getUserPlaylistPath(userId, playlistName);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deletePlaylist(userId, playlistName) {
  const filePath = getUserPlaylistPath(userId, playlistName);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Manage custom playlists')
    .addSubcommand(subcommand =>
      subcommand
        .setName('save')
        .setDescription('Save current queue as a playlist')
        .addStringOption(option =>
          option
            .setName('name')
            .setDescription('Name for the playlist')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('load')
        .setDescription('Load a saved playlist into the queue')
        .addStringOption(option =>
          option
            .setName('name')
            .setDescription('Name of the playlist to load')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all your saved playlists'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('Delete a saved playlist')
        .addStringOption(option =>
          option
            .setName('name')
            .setDescription('Name of the playlist to delete')
            .setRequired(true))),

  async execute(interaction) {
    await interaction.deferReply();
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    switch (subcommand) {
      case 'save': {
        const playlistName = interaction.options.getString('name');
        
        // Validate playlist name
        if (!/^[a-zA-Z0-9_-]+$/.test(playlistName)) {
          return interaction.editReply('❌ Playlist name can only contain letters, numbers, dashes, and underscores.');
        }

        const queue = getQueue(guildId);
        const songs = queue.songs.slice(); // Copy current queue
        
        if (queue.nowPlaying) {
          songs.unshift(queue.nowPlaying); // Add currently playing song to start
        }

        if (songs.length === 0) {
          return interaction.editReply('❌ No songs in queue to save!');
        }

        savePlaylist(userId, playlistName, songs);
        return interaction.editReply(`✅ Saved **${songs.length}** songs to playlist **${playlistName}**`);
      }

      case 'load': {
        const playlistName = interaction.options.getString('name');
        const playlist = loadPlaylist(userId, playlistName);

        if (!playlist) {
          return interaction.editReply(`❌ Playlist **${playlistName}** not found!`);
        }

        // Add all songs to queue
        let added = 0;
        for (const song of playlist.songs) {
          addToQueue(guildId, {
            query: song.url || song.query,
            title: song.title,
            addedBy: interaction.user.tag
          });
          added++;
        }

        return interaction.editReply(`✅ Added **${added}** songs from playlist **${playlistName}** to queue`);
      }

      case 'list': {
        const playlists = getUserPlaylists(userId);

        if (playlists.length === 0) {
          return interaction.editReply('📋 You have no saved playlists. Use `/playlist save <name>` to create one!');
        }

        // Get details for each playlist
        const details = playlists.map(name => {
          const playlist = loadPlaylist(userId, name);
          return `• **${name}** - ${playlist.songs.length} songs`;
        });

        return interaction.editReply(`📋 **Your Playlists:**\n${details.join('\n')}`);
      }

      case 'delete': {
        const playlistName = interaction.options.getString('name');
        const success = deletePlaylist(userId, playlistName);

        if (!success) {
          return interaction.editReply(`❌ Playlist **${playlistName}** not found!`);
        }

        return interaction.editReply(`🗑️ Deleted playlist **${playlistName}**`);
      }
    }
  },
};
