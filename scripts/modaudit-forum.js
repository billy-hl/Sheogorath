require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");
const { getGuildConfig } = require("../src/config/guilds");
const { parseWorkshopIds } = require("../src/services/zomboid/modCheck");

const GUILD = "444601986160263189";
const cfg = getGuildConfig(GUILD);
const FORUM = cfg.zomboid.channels.modRequests;
const installed = new Set(
  require("fs").readFileSync(process.env.HOME + "/gameservers/zomboid/.env", "utf8")
    .split("\n").find(l => l.startsWith("WORKSHOP_IDS=")).split("=")[1].split(";").filter(Boolean)
);

const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once(Events.ClientReady, async () => {
  try {
    const forum = await c.channels.fetch(FORUM);
    const tagName = new Map((forum.availableTags||[]).map(t => [t.id, t.name]));
    const active = await forum.threads.fetchActive();
    const arch = await forum.threads.fetchArchived({ limit: 100 });
    const all = [...active.threads.values(), ...arch.threads.values()];
    console.log("forum: #" + forum.name + " | threads: " + all.length + " (" + active.threads.size + " active, " + arch.threads.size + " archived)");
    console.log("installed workshop items: " + installed.size);
    console.log("");
    const rows = [];
    for (const t of all) {
      let body = "";
      try { const s = await t.fetchStarterMessage(); body = s ? s.content : ""; } catch {}
      const ids = parseWorkshopIds(t.name + "\n" + body);
      const tags = (t.appliedTags||[]).map(id => tagName.get(id)).filter(Boolean);
      rows.push({ title: t.name, ids, tags });
    }
    const seen = new Set();
    const p = (label, filter) => {
      const sel = rows.filter(filter);
      console.log("=== " + label + " (" + sel.length + ") ===");
      for (const r of sel) {
        const state = r.ids.length ? r.ids.map(i => (installed.has(i) ? "ON " : "OFF")).join(",") : "no-link";
        r.ids.forEach(i => seen.add(i));
        console.log("  [" + state + "] " + r.title.slice(0,58).padEnd(58) + " {" + r.tags.join(", ") + "}");
      }
      console.log("");
    };
    p("APPROVED / INSTALLED", r => r.tags.some(t => ["Approved","Installed"].includes(t)));
    p("OPEN / NEEDS REVIEW / UNDER REVIEW", r => r.tags.some(t => ["Open","Needs Review","Under Review"].includes(t)) && !r.tags.some(t => ["Approved","Installed","Denied","Incompatible"].includes(t)));
    p("DENIED / INCOMPATIBLE / DUPLICATE", r => r.tags.some(t => ["Denied","Incompatible","Duplicate"].includes(t)));
    const orphan = [...installed].filter(i => !seen.has(i));
    console.log("=== INSTALLED BUT NEVER REQUESTED IN THE FORUM (" + orphan.length + ") ===");
    console.log("  " + orphan.join(" "));
  } catch (e) { console.error("ERR", e.message); } finally { c.destroy(); }
});
c.login(process.env.DISCORD_TOKEN);
