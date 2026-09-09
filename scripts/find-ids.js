require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");
const { getGuildConfig } = require("../src/config/guilds");
const { parseWorkshopIds } = require("../src/services/zomboid/modCheck");
const WANT = [/lock interiors/i];
const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once(Events.ClientReady, async () => {
  try {
    const forum = await c.channels.fetch(getGuildConfig("444601986160263189").zomboid.channels.modRequests);
    const tagName = new Map((forum.availableTags||[]).map(t => [t.id, t.name]));
    const active = await forum.threads.fetchActive();
    const arch = await forum.threads.fetchArchived({ limit: 100 });
    for (const t of [...active.threads.values(), ...arch.threads.values()]) {
      if (!WANT.some(re => re.test(t.name))) continue;
      let body = ""; try { const s = await t.fetchStarterMessage(); body = s ? s.content : ""; } catch {}
      const ids = parseWorkshopIds(t.name + "\n" + body);
      console.log(t.name + "  ->  ids: " + (ids.join(",")||"NONE") + "  tags: " + (t.appliedTags||[]).map(i=>tagName.get(i)).join(", "));
    }
  } catch(e){ console.error("ERR", e.message); } finally { c.destroy(); }
});
c.login(process.env.DISCORD_TOKEN);
