require("dotenv").config();
const { getGuildConfig } = require("../src/config/guilds");
const mc = require("../src/services/zomboid/modCheck");
const z = getGuildConfig("444601986160263189").zomboid;
const ids = ["3634569678", "3249591963"];
(async () => {
  const s = mc.readServerConfig(z.serverIni, z.gameBuild || 42, z.logDir, z.workshopDir || null);
  const items = await mc.fetchWorkshopItems(ids);
  for (const i of items) console.log(i.title + "  | tags: " + (i.tags||[]).map(t=>t.tag||t).join(", ") + "  | subs: " + i.subscriptions);
  for (const id of ids) {
    const r = await mc.checkRequestDetailed("https://steamcommunity.com/sharedfiles/filedetails/?id=" + id, s);
    console.log("\n===== " + id + " -> " + (r && r.verdict) + " =====");
    console.log(r && r.text);
  }
})().catch(e => console.error("ERR", e.message));
