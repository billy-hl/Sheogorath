--[[
Where the Onyx Katar spawns.

THE RULE IS ONE LINE: wherever a vanilla hunting knife can be found, one in
eighty times it is this one instead.

This file does not carry a list of loot tables, and that is the point. It walks
ProceduralDistributions at boot, finds every table that lists a hunting knife,
and inserts the katar into that same table at a fixed fraction of whatever the
knife's own weight there is. Three reasons it is done this way rather than the
Celestial Shovel's hardcoded seventeen names:

  IT CANNOT BE WRONG ABOUT WHERE KNIVES ARE. The first version of this file
  did carry a list - fifteen table names written from memory. Checked against
  42.20 afterwards, one of the fifteen did not exist at all, and only six of
  the rest actually listed a hunting knife. Meanwhile twenty of the twenty-six
  tables that DO list one were missing: GunStoreKnives, PawnShopKnives,
  Trapper, CampingStoreTools, the army lockers, the late-game safehouse
  tables. A list is a second copy of a fact the game already knows, and this
  one was wrong in both directions at once.

  THE ODDS COME OUT EVEN. A flat weight cannot mean the same thing twice,
  because the knife's own weight ranges from 0.1 in ArmyBunkerLockers to 20 in
  GunStoreKnives - a factor of two hundred. The old flat 0.05 would have made
  the katar half as common as a knife in the army bunker and one four-hundredth
  as common in the gun store. Scaling off the knife's weight in each table
  makes "one in eighty knives" true everywhere.

  IT SURVIVES PATCHES AND OTHER MODS. If the base game moves knives around, or
  another mod adds a table with knives in it, the katar follows without this
  file being touched. It only has to be edited if the RULE changes.

HOW RARE ONE IN EIGHTY ACTUALLY IS
Weights are relative within a table, so this is not "one in eighty containers"
- it is one katar for every eighty hunting knives that spawn. Across a town
over a season that is a handful on the server. RARITY below is the only number
to change and every table gets it.

WHY THIS IS NOT A SANDBOX OPTION
Loot tables are built once at boot and never consulted again, so a slider here
could only ever be read at load - and this mod's settings rule is READ AT USE,
NEVER AT LOAD. A setting that sits in Sandbox Options looking live while doing
nothing until a restart is worse than a constant in a file that has to be
republished anyway.
]]

require "Items/ProceduralDistributions"

local RARITY = 0.0125          -- one katar per eighty hunting knives
local ITEM   = "Base.OnyxKatar"
local SOURCE = { HuntingKnife = true, ["Base.HuntingKnife"] = true }

-- The items list is flat: name, weight, name, weight. Anything else in there
-- is not ours to interpret, so the walk steps in twos and touches nothing else.
local function knifeWeightIn(items)
    local w = nil
    for i = 1, #items - 1, 2 do
        local name = items[i]
        if type(name) == "string" then
            if name == ITEM then
                return nil, true          -- already inserted; do not double it
            elseif SOURCE[name] then
                local n = tonumber(items[i + 1])
                if n and (w == nil or n > w) then w = n end
            end
        end
    end
    return w, false
end

local placed, skipped, total = 0, 0, 0

for name, dist in pairs(ProceduralDistributions.list or {}) do
    if type(dist) == "table" and type(dist.items) == "table" then
        total = total + 1
        local w, already = knifeWeightIn(dist.items)
        if already then
            skipped = skipped + 1
        elseif w then
            local weight = w * RARITY
            -- A weight the engine rounds to nothing is worse than no entry: it
            -- reads as "it is in there somewhere" while never being picked.
            if weight < 0.001 then weight = 0.001 end
            table.insert(dist.items, ITEM)
            table.insert(dist.items, weight)
            placed = placed + 1
        end
    end
end

print("WabbajackOnyxKatar: added to " .. tostring(placed) .. " loot tables at " ..
      tostring(RARITY) .. "x the hunting knife's weight (" .. tostring(total) ..
      " tables scanned, " .. tostring(skipped) .. " already had it)")

if placed == 0 then
    print("WabbajackOnyxKatar: WARNING - no table lists a hunting knife. " ..
          "The item exists but will never spawn. Has the vanilla item id changed?")
end
