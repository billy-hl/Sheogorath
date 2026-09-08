require("dotenv").config();
const fs = require("fs");
const { Client, GatewayIntentBits, Events } = require("discord.js");
const { getGuildConfig } = require("../src/config/guilds");
const { parseWorkshopIds } = require("../src/services/zomboid/modCheck");

const APPLY = process.argv[2] === "apply";
const RESOLVED = ["Approved", "Installed", "Denied", "Incompatible"];
const staged = new Set(
  fs.readFileSync(process.env.HOME + "/gameservers/zomboid/.env", "utf8")
    .split("\n").find(l => l.startsWith("WORKSHOP_IDS=")).split("=")[1].split(";").filter(Boolean));

const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once(Events.ClientReady, async () => {
  try {
    const forum = await c.channels.fetch(getGuildConfig("444601986160263189").zomboid.channels.modRequests);
    const tagName = new Map((forum.availableTags||[]).map(t => [t.id, t.name]));
    const active = await forum.threads.fetchActive();
    const arch = await forum.threads.fetchArchived({ limit: 100 });
    const all = [...active.threads.values(), ...arch.threads.values()];

    const targets = [], missing = [];
    for (const t of all) {
      const tags = (t.appliedTags||[]).map(i => tagName.get(i)).filter(Boolean);
      if (!tags.some(x => RESOLVED.includes(x))) continue;
      let body = ""; try { const s = await t.fetchStarterMessage(); body = s ? s.content : ""; } catch {}
      const ids = parseWorkshopIds(t.name + "\n" + body);
      targets.push({ t, tags, ids });
      if (tags.some(x => ["Approved","Installed"].includes(x))) {
        const present = ids.length && ids.every(i => staged.has(i));
        if (!present) missing.push({ title: t.name, ids, tags });
      }
    }

    console.log("resolved threads: " + targets.length + "  (already locked+archived: " +
      targets.filter(x => x.t.locked && x.t.archived).length + ")");
    console.log("");
    console.log("=== APPROVED BUT NOT IN THE STAGED MOD SET (" + missing.length + ") ===");
    for (const m of missing) console.log("  " + m.title.slice(0,58).padEnd(58) + " ids:" + (m.ids.join(",")||"none") + " {" + m.tags.join(", ") + "}");
    if (!APPLY) { console.log("\n(dry run — pass \"apply\" to archive+lock)"); return; }

    let done = 0, skipped = 0, failed = 0;
    for (const { t } of targets) {
      if (t.locked && t.archived) { skipped++; continue; }
      try {
        if (t.archived) await t.setArchived(false, "tidy: resolved request");
        if (!t.locked) await t.setLocked(true, "tidy: resolved request");
        await t.setArchived(true, "tidy: resolved request");
        done++;
      } catch (e) { failed++; console.log("  FAIL " + t.name.slice(0,40) + ": " + e.message); }
      await new Promise(r => setTimeout(r, 400));
    }
    console.log("\nlocked+archived: " + done + " | already done: " + skipped + " | failed: " + failed);
  } catch(e){ console.error("ERR", e.message); } finally { c.destroy(); }
});
c.login(process.env.DISCORD_TOKEN);
