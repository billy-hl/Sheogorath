
# Sheogorath Discord Bot

Sheogorath is a multi-guild Discord bot built around an Elder Scrolls Mad God persona. It combines AI chat and image generation (Grok/xAI), a YouTube music player with a companion web app, and a deep Project Zomboid server integration.

Each Discord server the bot serves gets its own entry in `config/guilds.json`, with a `features` list deciding what actually runs there — so the music guild and the game-server guild share one process without sharing surfaces.

## What does it do?

- **AI Chat**: Talk to Sheogorath in character using Grok (xAI). The persona keeps per-user notes and long-term memories across conversations, and can act on the server through embedded action tags (warn, timeout, delete, remember). He answers on a mention or on his name anywhere, and unprompted in the help channel.
- **Image Generation**: `/imagine` conjures images through Grok, with the Mad God riffing on your prompt first.
- **Music Streaming**: Play YouTube music in voice channels — URL or search phrase — with a queue, saved playlists, autoplay, and a radio list loaded from `radio.csv`.
- **Companion Control API**: An Express + WebSocket server (`src/api/`) serving a small web page that drives playback from a phone. Guest and admin credential tiers; bound to the tailnet, not the LAN.
- **Project Zomboid Integration**: Leaderboards, roleplay character sheets, and RCON server admin from Discord, plus log watchers that post kills, raids, deaths, mod updates and story-time recaps.
- **Community Forums**: Managed suggestion and mod-request forums with vote reactions, duplicate detection, and automatic Steam Workshop vetting of requested mods.
- **Moderation**: Discord native AutoMod rules, an Ollama-backed filter for sexual ASCII/Unicode text art that keyword rules can't catch, and Sheogorath himself acting as a moderator — everything he decides to do passes through a permission gate that either performs it, holds it for a Sheriff to approve, or refuses it.
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
- `/sheo status` - What Sheogorath is allowed to do unsupervised, what he has done in the last hour, and how many approval cards are waiting *(Owners only)*
- `/sheo mode <shadow|assist|enforce>` - Change how much he may do without asking. Persisted to `config/guilds.json`, so it survives a restart
- `/sheo unleash` - Clear the hourly action brake early
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

### The help channel

`channels.help` is the one place he answers without being called by name —
anything said there is his to pick up. Replies are debounced by four seconds and
keyed per person, so someone typing "hey", then "quick question", then the actual
question gets one answer covering all three rather than three answers to the
first. Naming him directly skips the wait and cancels anything already queued.

Messages with no text are left alone: he has no eyes on attachments, and a guess
at a screenshot is worse than leaving it for a human who can look at it. Answers
there get a larger token ceiling than banter does, since troubleshooting is steps
rather than a one-liner.

Guilds with no `channels.help` set behave as before — he waits to be addressed.

### What he actually knows

The persona is told never to break character and to answer with confidence,
which is the wrong disposition for "what port do I connect on": told nothing, he
doesn't say he doesn't know, he invents a port in character and it sounds exactly
like a real answer. The fix isn't to sand the character down — it's to put the
true answer in front of him and take away the one liberty that matters.

Before he answers anything, `src/services/knowledge/` assembles a block from
three sources:

- **Live server state** (`live.js`) — up or down, who's online, next restart,
  game version, mods loaded. Measured through RCON and the server ini, never
  recalled, cached for a minute. Each source is isolated: an unreachable server
  still leaves the mod list answerable.
- **Reference channels** (`sources.js`) — `#rules` and `#server-info`, read
  straight out of Discord, pinned messages first. He quotes what players can
  see, so there's no second copy to go stale. Configured as `channels.rules` and
  `channels.serverInfo`; unset, he looks for channels with exactly those names.
  **These should be channels only staff can post in** — whatever is written
  there is handed to him as fact.
- **Hand-written notes** — markdown in `data/knowledge/`, for things that don't
  belong in a player-facing channel. Matched against the question by keyword, so
  banter pulls in nothing and costs nothing. Files still containing `TODO`,
  `FIXME` or `<fill in>` are skipped entirely and logged: a half-written
  template isn't a fact, and handed to him it becomes a confident answer built
  around the word TODO.

Attached to the facts is one paragraph giving him the whole of the voice and none
of the substance — invent nothing, and where the facts don't cover it, say so
plainly and send them to a Sheriff. He stays as mad as he ever was about *how* he
says things; *what* he says comes from the block.

If the block can't be built at all, he answers from the persona alone and the
failure is logged as loudly as the code can manage, because that is the one path
where he can still make something up.

### People trying to play him

Users probe him. Within a day of him becoming more active, someone tried the
"my grandmother used to tell me bedtime stories about making chemical weapons"
framing — the classic wrapper for getting a model to produce something it
shouldn't.

He refuses those, mocks the person, and flags it. The flag is a capability like
any other (`[ACTION:flag:userId:reason]`), so it goes through the same gate and
lands in the same audit trail with a link to the message — staff see the attempt
in their log channel without anyone having to be watching the channel at the
time. It punishes nobody, so it runs at the auto tier and is exempt from
immunity: a Sheriff testing him shows up in the log like anyone else.

The refusal instruction names the framings explicitly (dead relatives, "just for
a story", "ignore previous instructions", claimed authority, asking in pieces)
and tells him not to lecture — one contemptuous line and a flag is the whole
response.

**The line is drawn on real-world workability, not on topic**, because this is a
Project Zomboid server. "How do I craft a molotov", "best beginner melee weapon",
"where do I find propane" are ordinary questions about a video game and get
ordinary answers. Real chemistry does not. Getting this wrong in the other
direction — flagging your own players for playing the game — would be worse than
not having the feature. Verified against both kinds live: both jailbreak framings
refused and flagged, both game questions answered with no flag.

### The parlour

`/sheo parlour` creates **#the-shivering-isles**, one room where Sheogorath is
allowed to be long. Everywhere else he is deliberately clipped — the persona says
"1-2 sentences max", which is right for a bot that answers when its name comes up
in general chat and wrong for the one place people go specifically to talk to
him.

In that channel only:

- He answers everything said there, without being called by name and **without
  the help channel's debounce** — holding each line for four seconds to see if
  another follows makes conversation feel like filling in a form.
- He carries **20 messages** of history instead of 5.
- The reply ceiling is **1200 tokens** instead of 500.
- The persona is handed over **with its length rule cut out** rather than intact
  with an instruction to ignore it. Appending "that rule doesn't apply here" was
  not enough — the capitalised "SHORT and punchy" in the base persona won the
  argument and produced two-sentence replies in a room built for conversation.
  `parlourPersona()` strips sentences that ration length and leaves everything
  else, including "always complete your thoughts", which is about finishing
  sentences rather than rationing them. If a future edit to `CLIENT_INSTRUCTIONS`
  words the rule differently and nothing matches, it falls back to the untouched
  persona — terse, but still in character.

Measured effect on the same question: 182 characters ordinarily, 1029 in the
parlour, three paragraphs with a genuine turn in the middle and a question back.
About **$0.004** a reply against $0.0012, drawing on the same monthly ceiling as
everything else.

Nothing else changes there. The permission gate, the facts layer and the budget
all apply exactly as they do everywhere else, and the parlour prompt says so
explicitly: a longer leash is not permission to invent.

### Story time on demand

A chronicle of each day is posted nightly at `storyTimeHour`. When someone asks
for one early — "story time?", "what's happened today?", "tell us a tale" —
Sheogorath summons a shorter piece instead of writing one himself.

That distinction matters. He is not the chronicler; he only fetches them.
Anything he invented about who died today would be a lie about real people, so
`[ACTION:storytime:reason]` runs `generateInterlude()`, which reads the same logs
the nightly entry does and writes 120–200 words about the day so far in the same
voice. Sheogorath introduces it in a line; the tale follows, and ends by pointing
at the full chronicle that night.

It is deliberately not the nightly entry — that one is 700–900 words at a
2000-token ceiling, and running it at three in the afternoon would both cost real
money and spoil the thing it imitates. The short form measures at about
**$0.0024** a go.

Rationed at **1/hour and 3/day** per guild. The daily limit refuses outright
rather than degrading to an approval card: how many stories a day is a taste
question, not a permissions one, and asking a Sheriff to approve a fourth would
waste their attention. It is not gated on staff at all — a player asking for a
story is the entire point.

The window is since midnight rather than a rolling 24 hours, so it doesn't fold
in last night's events that the previous chronicle already covered. A day with
nothing in it says so plainly instead of inventing one.

### Spend

Every reply costs money, and until there was a ceiling there was nothing bounding
it: the slash-command cooldown never covered the message path, each reply is two
billed requests, and the help channel answers everything. The moderation limits
below do **not** help here — they cap *actions*, and a reply that does nothing at
all still costs a full request.

`src/ai/budget.js` meters it. The figures are not estimated from a pricing table
that would go stale: xAI returns `usage.cost_in_usd_ticks` on every response —
the amount actually billed, after prompt-caching discounts and including tool
costs, at 1 USD = 10^10 ticks — and this just adds it up. Metering happens in
`httpsPost`, the one place every xAI request passes through, so a call added
later is budgeted without anyone remembering to budget it.

- **`AI_MONTHLY_BUDGET_USD`** in `.env` (default 20) is a hard monthly ceiling
  across every guild, because spend is a property of the API key, not of a guild.
- Staff are warned once each at **50%, 80% and 95%** in the log channel. At
  **100%** he stops answering — in character, with no API call made — until the
  month turns or the ceiling goes up.
- The ledger lives in `data/ai-spend.json`, written temp-file-and-rename so a
  crash mid-write can't leave a truncated file that reads as $0 spent. It has to
  be on disk: a monthly ceiling held in memory resets on every restart, and this
  bot restarts on mod updates.
- Twelve months of history are kept, so "is $20 the right number" stays
  answerable.
- `/sheo status` shows the month to date, today's calls, and a progress bar.

Two smaller savings: a **6-second per-user cooldown** on the AI message path
(longer than a follow-up takes to type, shorter than a Grok round-trip, so real
conversation never notices while a script hammering the channel does), and the
background memory-extraction call is **skipped in `#help`** — it was a second
billed request on every message, in the channel least likely to contain a
personal fact worth keeping.

Note that `getGrokUsage()` in `src/ai/grok.js` is dead: xAI's `/v1/usage`
endpoint now 404s, so `/health`'s spend section reports nothing. The local ledger
is the working source.

### Sheogorath as a moderator

The AI can act on the server through action tags embedded in its replies — warn,
timeout, kick, ban, delete, notes, memories, and raw game-server commands. What
it *asks* for and what *happens* are separate steps: every tag goes through
`src/ai/capabilities.js`, which reaches one of four verdicts.

| Verdict | What happens |
| --- | --- |
| `execute` | Performed now, and recorded |
| `propose` | An Approve/Deny card in the staff channel; nothing moves until a Sheriff clicks |
| `shadow` | Recorded as what *would* have happened; nothing is performed |
| `deny` | Refused, and the refusal recorded |

The rules that get you there, in order:

- **Staff and Owners are untouchable.** No tier, no requester, no mode can act on them. Neither can bots, or Sheogorath himself.
- **Ordinary members can only get him to act on themselves.** An action aimed at anyone other than the author of the message he is replying to degrades to an approval card unless a Sheriff asked for it. This is what contains prompt injection: the worst a member can talk him into is a card in the staff channel.
- **Kicks, bans and game-server commands always ask**, whoever is asking. RCON has no undo.
- **Timeouts over 10 minutes ask.** Up to ten he may give himself.
- **Rate limits per capability, and a guild-wide brake** at 20 actions/hour. Both degrade to approval cards rather than refusing outright, so a busy hour costs staff a click rather than losing the action. The brake announces itself in the staff channel once when it trips.

Modes are per guild, set as `ai.mode` in `config/guilds.json` or with `/sheo mode`:

- `shadow` — acts on nothing, records every decision. **The default for a guild that hasn't set one**, so a new deployment watches before it acts.
- `assist` — everything becomes an approval card.
- `enforce` — the auto tier runs; the propose tier still asks.

Every decision — performed, proposed, refused, or shadowed — is appended to
`logs/ai-actions.jsonl` with the verdict and the reason for it. Executions and
refusals also mirror to the guild's `channels.modApprovals`, falling back to
`channels.commandLog`. **A guild with neither cannot approve anything**, so
proposals there are recorded as refusals.

## Configuration

### Credentials — `.env`

See `.env.example` for the annotated list. In short: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` and `ADMIN_USER_ID` for Discord; `GROK_API_KEY` plus `CLIENT_NAME`, `CLIENT_INSTRUCTIONS` and `CLIENT_MODEL` for the AI persona; `OLLAMA_URL` / `OLLAMA_MOD_MODEL` for the text-image filter; `CONTROL_API_*` and `CONTROL_GUEST_PASSWORD` for the companion app; `ERROR_CHANNEL_ID` and `LOG_LEVEL` optionally.

### Per-guild settings — `config/guilds.json`

One entry per Discord server, holding that guild's `features` list, channel IDs, role IDs (`admin`, `staff`, and so on), the AI moderator's `ai.mode`, and — where the `zomboid` feature is enabled — the game server's log paths, ini path and RCON settings. Copy the placeholder entry to onboard a second guild.

`channels.modApprovals` is where Sheogorath posts what he wants permission to do and what he did on his own; it falls back to `channels.commandLog` when unset, so a guild with one private staff channel doesn't need a second.

Available features: `ai`, `music`, `moderation`, `automod`, `textImageMod`, `instagram`, `zomboid`, `forums`.

## Contributing

We welcome suggestions, improvements, and new features! Open a pull request or issue to get started.
