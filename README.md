
# Sheogorath Discord Bot

Sheogorath is a full-featured Discord bot that combines AI chat, music streaming, and livestream notifications for your community. Powered by OpenAI and modern Discord libraries, it brings together:

## What does it do?

- **AI Chat**: Talk to Sheogorath, an AI persona based on the Elder Scrolls character, using OpenAI's GPT models. The bot responds in-character, answers questions, and can be customized for your server.
- **Music Streaming**: Play YouTube music directly in your Discord voice channels. Supports both direct YouTube URLs and search terms, with robust error handling and queue management.
- **Livestream Alerts**: Automatically detects when specified YouTube or Kick channels go live and posts announcements in your chosen Discord channel. Also announces new YouTube uploads.
- **Multi-Channel Monitoring**: Monitors multiple Kick channels (main channel, EokaFish, Allisteras) with rich embeds and interactive buttons
- **Rich Notifications**: Beautiful Discord embeds with stream thumbnails, viewer counts, game categories, and direct "Watch Live" buttons
- **Health Monitoring**: Built-in health check command to monitor API status and bot performance
- **Performance Optimized**: Caching system reduces API calls, rate limiting prevents abuse
- **Slash Commands**: Includes commands for AI chat, music control, live status checks, and more. All commands are registered as Discord slash commands for easy use.
- **Customizable**: Configure which channels to monitor, which Discord channel to post alerts, and the bot's persona via environment variables.

## Key Features

- AI-powered chat and persona
- YouTube/Kick livestream and upload detection
- Multi-channel Kick monitoring (main, EokaFish, Allisteras)
- Music playback from YouTube
- Rich Discord notifications with thumbnails and interactive buttons
- Easy setup with environment variables
- Production-ready with proper error handling

## Getting Started

### Dependencies

- Node.js (v18+ recommended)

### Setup

1. Clone the repo and install dependencies:
	```sh
	npm install
	```
2. Create a `.env` file in the root directory with your secrets and config:
	```
	OPENAI_API_KEY=your_openai_key
	ASSISTANT_ID=your_openai_assistant_id
	THREAD_ID=your_openai_thread_id
	CHANNEL_ID=discord_channel_id_for_announcements
	POLLING_RETRIES=10
	POLLING_TIMEOUT=3
	CLIENT_NAME=Sheogorath
	CLIENT_INSTRUCTIONS=Your custom AI instructions
	CLIENT_MODEL=gpt-4o
	DISCORD_TOKEN=your_discord_token
	CLIENT_ID=your_discord_bot_id
	GUILD_ID=your_discord_guild_id
	KICK_CHANNEL_URL=https://kick.com/yourkickchannel
	ALLISTERAS_KICK_URL=https://kick.com/allisteras
	YT_CHANNEL_URL=https://www.youtube.com/channel/yourchannelid
	DEFAULT_IMAGE_URL=https://example.com/default-image.jpg
	GIPHY_API_KEY=your_giphy_key
	```
3. Start the bot:
	```sh
	npm run start
	```

## Available Commands

- `/play <url>` - Play music from YouTube URL or search term
- `/pause` - Pause current music playback
- `/resume` - Resume paused music
- `/stop` - Stop music and disconnect from voice channel
- `/livecheck` - Check current livestream status for configured channels
- `/health` - Check bot health and service status
- `/ai <message>` - Chat with the AI assistant
- `/news` - Get latest news articles
- `/lofi` - Play lofi music
- `/synth` - Generate synthesizer sounds

## Configuration Options

- **KICK_CHANNEL_URL**: Main Kick channel to monitor
- **ALLISTERAS_KICK_URL**: Additional Kick channel (Allisteras) to monitor
- **YT_CHANNEL_URL**: YouTube channel to monitor for uploads and live streams
- **DEFAULT_IMAGE_URL**: Fallback image for embeds when thumbnails aren't available

## Contributing

We welcome suggestions, improvements, and new features! Open a pull request or issue to get started.
