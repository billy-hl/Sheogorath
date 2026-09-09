require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");
const { getGuildConfig } = require("../src/config/guilds");
const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once(Events.ClientReady, async () => {
  try {
    const forum = await c.channels.fetch(getGuildConfig("444601986160263189").zomboid.channels.modRequests);
    const tagName = new Map((forum.availableTags||[]).map(t => [t.id, t.name]));
    const active = await forum.threads.fetchActive();
    const arch = await forum.threads.fetchArchived({ limit: 100 });
    console.log("VISIBLE BY DEFAULT (unarchived): " + active.threads.size);
    for (const t of active.threads.values()) {
      const tags = (t.appliedTags||[]).map(i=>tagName.get(i)).filter(Boolean);
      console.log("  " + (t.locked?"[locked] ":"[open]   ") + t.name.slice(0,52).padEnd(52) + " {" + tags.join(", ") + "}");
    }
    console.log("");
    console.log("ALREADY ARCHIVED (hidden unless you filter): " + arch.threads.size);
    const lockedCount = [...arch.threads.values()].filter(t=>t.locked).length;
    console.log("  of those, locked: " + lockedCount);
  } catch(e){ console.error("ERR", e.message); } finally { c.destroy(); }
});
c.login(process.env.DISCORD_TOKEN);
