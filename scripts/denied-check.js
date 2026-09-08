require("dotenv").config();
const fs = require("fs");
const { Client, GatewayIntentBits, Events } = require("discord.js");
const { getGuildConfig } = require("../src/config/guilds");
const { parseWorkshopIds } = require("../src/services/zomboid/modCheck");
const installed = new Set(
  fs.readFileSync(process.env.HOME + "/gameservers/zomboid/.env", "utf8")
    .split("\n").find(l => l.startsWith("WORKSHOP_IDS=")).split("=")[1].split(";").filter(Boolean));
const BAD = ["Denied", "Incompatible"];
const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once(Events.ClientReady, async () => {
  try {
    const forum = await c.channels.fetch(getGuildConfig("444601986160263189").zomboid.channels.modRequests);
    const tagName = new Map((forum.availableTags||[]).map(t => [t.id, t.name]));
    const active = await forum.threads.fetchActive();
    const arch = await forum.threads.fetchArchived({ limit: 100 });
    const hits = [];
    let checked = 0;
    for (const t of [...active.threads.values(), ...arch.threads.values()]) {
      const tags = (t.appliedTags||[]).map(i => tagName.get(i)).filter(Boolean);
      if (!tags.some(x => BAD.includes(x))) continue;
      checked++;
      let body = ""; try { const s = await t.fetchStarterMessage(); body = s ? s.content : ""; } catch {}
      for (const id of parseWorkshopIds(t.name + "\n" + body)) {
        if (installed.has(id)) hits.push({ id, title: t.name, tags });
      }
    }
    console.log("denied/incompatible threads examined: " + checked);
    console.log("installed workshop items: " + installed.size);
    console.log("");
    if (!hits.length) { console.log("RESULT: none of them are installed — nothing to remove."); return; }
    console.log("RESULT: " + hits.length + " denied/incompatible mod(s) ARE installed:");
    for (const h of hits) console.log("  " + h.id + "  " + h.title + "  {" + h.tags.join(", ") + "}");
  } catch(e){ console.error("ERR", e.message); } finally { c.destroy(); }
});
c.login(process.env.DISCORD_TOKEN);
