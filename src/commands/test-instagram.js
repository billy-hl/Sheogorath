const { SlashCommandBuilder } = require('discord.js');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const fs = require('fs');
const path = require('path');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('test-instagram')
    .setDescription('Test Instagram video download functionality'),
  
  async execute(interaction) {
    await interaction.deferReply();
    
    const testUrl = 'https://www.instagram.com/reel/DOgzwIliuw-';
    const outputPath = path.join(__dirname, '..', '..', 'temp', `instagram_test_${Date.now()}.mp4`);
    const tempDir = path.join(__dirname, '..', '..', 'temp');
    
    try {
      // Create temp directory if it doesn't exist
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      await interaction.editReply('⏳ Downloading Instagram video...');
      
      console.log(`Downloading Instagram video from: ${testUrl}`);
      
      // Download with yt-dlp
      const { stdout, stderr } = await exec(`yt-dlp --no-check-certificate --age-limit 99 --cookies-from-browser chrome -o "${outputPath}" "${testUrl}"`);
      
      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);
        const fileSizeMB = stats.size / (1024 * 1024);
        
        if (fileSizeMB > 24) {
          await interaction.editReply('❌ Video is too large to upload (>24MB).');
          fs.unlinkSync(outputPath);
          return;
        }
        
        await interaction.editReply({
          content: `🎬 Test successful! Video size: ${fileSizeMB.toFixed(2)}MB`,
          files: [outputPath]
        });
        
        // Clean up
        fs.unlinkSync(outputPath);
        console.log('✅ Test Instagram video sent and cleaned up');
      } else {
        await interaction.editReply('❌ Video file not found after download');
      }
      
    } catch (error) {
      console.error('Test Instagram download error:', error);
      await interaction.editReply(`❌ Error: ${error.message}`);
    }
  },
};
