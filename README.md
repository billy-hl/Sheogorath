
# Sheogorath Discord Bot

Sheogorath is a multi-guild Discord bot built around an Elder Scrolls Mad God persona. It combines AI chat and image generation (Grok/xAI), a YouTube music player with a companion web app, and a deep Project Zomboid server integration.

Each Discord server the bot serves gets its own entry in `config/guilds.json`, with a `features` list deciding what actually runs there — so the music guild and the game-server guild share one process without sharing surfaces.

## What does it do?

- **AI Chat**: Talk to Sheogorath in character using Grok (xAI). The persona keeps per-user notes and long-term memories across conversations, and can act on the server through embedded action tags (warn, timeout, delete, remember).
- **Image Generation**: `/imagine` conjures images through Grok, with the Mad God riffing on your prompt first.
- **Music Streaming**: Play YouTube music in voice channels — URL or search phrase — with a queue, saved playlists, autoplay, and a radio list loaded from `radio.csv`.
- **Companion Control API**: An Express + WebSocket server (`src/api/`) serving a small web page that drives playback from a phone. Guest and admin credential tiers; bound to the tailnet, not the LAN.
- **Project Zomboid Integration**: Leaderboards, roleplay character sheets, and RCON server admin from Discord, plus log watchers that post kills, raids, deaths, mod updates and story-time recaps.
- **Community Forums**: Managed suggestion and mod-request forums with vote reactions, duplicate detection, and automatic Steam Workshop vetting of requested mods.
- **Moderation**: Discord native AutoMod rules, plus an Ollama-backed filter for sexual ASCII/Unicode text art that keyword rules can't catch.
- **Instagram Mirroring**: Reels posted in chat are downloaded and re-uploaded natively, compressed to the guild's boost-tier attachment limit.

## Getting Started

### Dependencies

- Node.js (v18+ recommended)
- Ollama, if the `textImageMod` feature is enabled
- A Project Zomboid server with RCON, if the `zomboid` feature is enabled

### Setup

1. Clone the repo and install dependencies:
	```sh
	npm install
	```
2. Copy `.env.example` to `.env` and fill in your credentials. `.env` holds **credentials only** — guild, channel and role IDs live in `config/guilds.json`.
3. Start the bot:
	```sh
	npm run start
	```

## Available Commands

Commands are loaded from `src/commands/*.js`. Two things decide whether a command is usable in a given guild, both driven by `src/utils/permissions.js`:

- **Feature gate** — commands mapped in `COMMAND_FEATURES` are only *registered* in guilds whose `config/guilds.json` entry lists that feature. Unmapped commands register everywhere.
- **Permission tier** — Owner (bot admin), Sheriff (in-game staff), or Discord's own Administrator permission. Admins pass every staff check.

### 🤖 AI & Chat
- `/ai <prompt>` - Chat with the AI bot
- `/ask <question>` - Ask a real question and get a straight answer (no Sheogorath persona)
- `/imagine <prompt>` - Command the Mad God to conjure an image from the chaos of your imagination
- `/fact-check [messages]` - Fact-check the last few messages in this channel (default: 5, max: 20)

### 🎵 Music
*Requires the `music` feature, and bot admin — music controls are admin-only, including the now-playing buttons.*

- `/play <query>` - Play a YouTube song by URL or search phrase
- `/pause` - Pause the current song
- `/resume` - Resume the paused song
- `/skip` - Skip the current song
- `/stop` - Stop music playback and clear the queue
- `/queue` - View the current music queue
- `/nowplaying` - Show what's currently playing
- `/clear` - Clear all songs from the queue (keeps the current song playing)
- `/remove <position>` - Remove a song from the queue
- `/autoplay` - Toggle autoplay — automatically play similar songs when the queue is empty
- `/radio [filter] [limit]` - Queue songs from the radio playlist (default: 25, max: 100)
- `/playlist save|load|list|delete <name>` - Manage custom playlists (`list` takes no name)

### 🧟 Project Zomboid
*Requires the `zomboid` feature.*

- `/leaderboard [board] [skill]` - Server records — kills, skills, survival and deaths. Boards: overall, kills, hunted, champions, survival, deaths. Passing `skill` shows the top 10 for one skill and overrides `board`.
- `/character link` - Link your Discord to your in-game account
- `/character sheet` - Write or edit your character sheet
- `/character refresh` - Update your sheet with your latest survival stats
- `/character view <name>` - Look up someone's character (autocompletes)
- `/character whois <member>` - Which character a Discord member plays
- `/character unlink [member]` - Unlink a game account — yours by default; unlinking someone else needs Sheriff+

#### `/pz` — server admin (Sheriff+)
Every subcommand is limited to Sheriffs and Owners. Invocations — including refused ones — are mirrored to the guild's private `commandLog` channel.

- `/pz players` - Who's online right now
- `/pz info <player>` - Look up a player — character, survival time, deaths, skills
- `/pz teleport <player> <target>` - Teleport one player to another
- `/pz kick <player> [reason]` - Kick a player from the server
- `/pz giveitem <player> <item> [count]` - Give an item to a player (item autocompletes)
- `/pz addxp <player> <skill> <amount>` - Grant XP in one skill
- `/pz setlevel <player> <skill> <level>` - Raise a skill to a level, working out the XP for you
- `/pz godmode <player> <state>` - Make a player invincible
- `/pz invisible <player> <state>` - Hide a player from zombies
- `/pz noclip <player> <state>` - Let a player walk through walls
- `/pz say <message>` - Broadcast a message to everyone in-game
- `/pz restart [when] [reason]` - Restart the server, announced in Discord and in-game (`when` accepts `20`, `20m`, `1h30m`, `22:00`, `10:30pm`, `now` — default 5 minutes)
- `/pz restart-cancel` - Cancel a scheduled restart
- `/pz restart-status` - Is a restart running or scheduled?
- `/pz access <player> <level>` - **Owners only.** Set a player's in-game access level. Held above the Sheriff tier because it hands out in-game power rather than using it — a Sheriff who could run it could promote themselves.

### 🛡️ Moderation
- `/mod warn|kick|ban|timeout <user> ...` - Moderation actions *(requires the `moderation` feature and Administrator)*
- `/stats` - Show bot statistics *(requires the `moderation` feature and Administrator)*
- `/automod status` - View current AutoMod status *(requires the `automod` feature and Administrator)*
- `/automod words <on|off>` - Toggle the blocked words filter
- `/automod antispam <on|off>` - Toggle the mention spam filter

### 📊 Utility
- `/health` - Check bot health and service status

#### `/forums` — manage the suggestion and mod-request forums
*Bot admin only.*

- `/forums preview` - Show what setup would create or change, without touching anything
- `/forums apply <confirm>` - Create or repair the forum channels and their tags. `confirm` is required — this creates channels and locks the old one read-only
- `/forums status` - Show how the forums are currently wired

## Configuration

### Credentials — `.env`

See `.env.example` for the annotated list. In short: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` and `ADMIN_USER_ID` for Discord; `GROK_API_KEY` plus `CLIENT_NAME`, `CLIENT_INSTRUCTIONS` and `CLIENT_MODEL` for the AI persona; `OLLAMA_URL` / `OLLAMA_MOD_MODEL` for the text-image filter; `CONTROL_API_*` and `CONTROL_GUEST_PASSWORD` for the companion app; `ERROR_CHANNEL_ID` and `LOG_LEVEL` optionally.

### Per-guild settings — `config/guilds.json`

One entry per Discord server, holding that guild's `features` list, channel IDs, role IDs (`admin`, `staff`, and so on), and — where the `zomboid` feature is enabled — the game server's log paths, ini path and RCON settings. Copy the placeholder entry to onboard a second guild.

Available features: `ai`, `music`, `moderation`, `automod`, `textImageMod`, `instagram`, `zomboid`, `forums`.

## Contributing

We welcome suggestions, improvements, and new features! Open a pull request or issue to get started.
