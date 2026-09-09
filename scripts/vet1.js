require("dotenv").config();
const { getGuildConfig } = require("../src/config/guilds");
const mc = require("../src/services/zomboid/modCheck");
const z = getGuildConfig("444601986160263189").zomboid;
const id = process.argv[2];
(async () => {
  const s = mc.readServerConfig(z.serverIni, z.gameBuild || 42, z.logDir, z.workshopDir || null);
  const [i] = await mc.fetchWorkshopItems([id]);
  console.log("TITLE: " + i.title + "  | tags: " + (i.tags||[]).map(t=>t.tag||t).join(", ") + "  | subs: " + i.subscriptions);
  const r = await mc.checkRequestDetailed("https://steamcommunity.com/sharedfiles/filedetails/?id=" + id, s);
  console.log("\n===== VERDICT: " + (r && r.verdict) + " | installed: " + (r && r.alreadyInstalled) + " =====");
  console.log(r && r.text);
})().catch(e => console.error("ERR", e.message));
