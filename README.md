
# Sheogorath Discord Bot

Sheogorath is a full-featured Discord bot that combines AI chat, music streaming, and livestream notifications for your community. Powered by OpenAI and modern Discord libraries, it brings together:

## What does it do?

- **AI Chat**: Talk to Sheogorath, an AI persona based on the Elder Scrolls character, using OpenAI's GPT models. The bot responds in-character, answers questions, and can be customized for your server.
- **Music Streaming**: Play YouTube music directly in your Discord voice channels. Supports both direct YouTube URLs and search terms, with robust error handling and queue management.
- **Livestream Alerts**: Automatically detects when specified YouTube or Kick channels go live and posts announcements in your chosen Discord channel. Also announces new YouTube uploads.
- **Slash Commands**: Includes commands for AI chat, music control, live status checks, and more. All commands are registered as Discord slash commands for easy use.
- **Customizable**: Configure which channels to monitor, which Discord channel to post alerts, and the bot's persona via environment variables.

## Key Features

- AI-powered chat and persona
- YouTube/Kick livestream and upload detection
- Music playback from YouTube
- Rich Discord notifications and embeds
- Easy setup with environment variables

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
	YT_CHANNEL_URL=https://www.youtube.com/channel/yourchannelid
	```
3. Start the bot:
	```sh
	npm run start
	```

## Contributing

We welcome suggestions, improvements, and new features! Open a pull request or issue to get started.
