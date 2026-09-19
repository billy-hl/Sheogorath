--[[
Where the Celestial Shovel spawns.

THE RULE IS ONE LINE: wherever a vanilla shovel can be found, one in a great
while it is this one instead. The seventeen tables below are exactly the
ProceduralDistributions tables that list "Shovel" in 42.20 - crates, garage and
garden-store tool shelves, fire and ranger stores, homesteads - and nothing was
added to broaden it. A player who wants one looks where shovels are; there is
no separate ritual and no boss to kill for it.

HOW RARE 0.05 ACTUALLY IS
Weights inside a table are relative, and a tools table totals a few hundred, so
a vanilla shovel at 4 is roughly one in eighty picks and this is one in four
thousand-ish per roll - a couple of hundredths of a percent per container. Over
a season, across a town, that is a handful on the server. Turn the constant up
if that reads as never; it is the only number to change and every table gets it.

WHY THIS IS NOT A SANDBOX OPTION
Every other setting in this mod is one, and WabbajackSettings.lua's rule is
READ AT USE, NEVER AT LOAD, because a setting that stops tracking the admin
panel is worse than no setting. Loot tables are built once at boot and never
consulted again, so a slider here could only ever be read at load: it would sit
in Sandbox Options looking live, and do nothing until a restart. A constant in
a file that has to be republished anyway is the honest version of the same
knob.

WHY EVERY INSERT IS CHECKED
table.insert on a nil table throws, and this file runs during boot, before
anything is watching. A table renamed by a build - or by another mod loading
first and replacing the list - would take the whole file down with it and the
item would silently spawn nowhere, which is indistinguishable from it being
rare. Each table is checked, each miss is printed, and the rest still land.
]]

require "Items/ProceduralDistributions"

local WEIGHT = 0.05

local TABLES = {
    "CrateRandomJunk",
    "CrateTools",
    "DrugShackTools",
    "FiremanTools",
    "FireStorageTools",
    "ForestFireTools",
    "GarageTools",
    "GardenStoreTools",
    "GigamartTools",
    "Homesteading",
    "LoggingFactoryTools",
    "MeleeWeapons",
    "MeleeWeapons_Mid",
    "MeleeWeapons_Late",
    "PoliceEvidence",
    "RangerTools",
    "ToolStoreTools",
}

local ITEM = "Base.CelestialShovel"

local function alreadyListed(items)
    for i = 1, #items do
        if items[i] == ITEM then return true end
    end
    return false
end

local placed, missed = 0, 0

for i = 1, #TABLES do
    local name = TABLES[i]
    local dist = ProceduralDistributions.list[name]
    if not dist or not dist.items then
        missed = missed + 1
        print("WabbajackCelestialShovel: no loot table '" .. name .. "' - skipped")
    elseif alreadyListed(dist.items) then
        -- the file loaded twice; inserting again would double the odds
        print("WabbajackCelestialShovel: '" .. name .. "' already lists the item - skipped")
    else
        table.insert(dist.items, ITEM)
        table.insert(dist.items, WEIGHT)
        placed = placed + 1
    end
end

print("WabbajackCelestialShovel: weight " .. tostring(WEIGHT) .. " added to " ..
      tostring(placed) .. "/" .. tostring(#TABLES) .. " loot tables, " ..
      tostring(missed) .. " missing")
