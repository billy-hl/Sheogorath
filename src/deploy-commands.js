require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));


for (const file of commandFiles) {
  const commandPath = path.join(commandsPath, file);
  const commandModule = require(commandPath);
  // Only push the .data property if it exists
  if (commandModule && commandModule.data) {
    commands.push(commandModule.data.toJSON());
  }
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    
    // Use guild commands for instant propagation (no 1-hour delay)
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );
    
    // Clear any old global commands to avoid duplicates
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: [] },
    );
    
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();
