--[[
Where the Thayne set spawns.

THE RULE IS THE KATAR'S RULE: each piece follows its ordinary counterpart.
The scale vest turns up wherever a hunting vest turns up, the hood wherever the
hide hoodie does, and so on down the five. Nothing was added to broaden any of
them. Somebody who wants the set looks where hunting gear is; there is no
separate ritual and no boss to kill for it.

WHY FOLLOW A DONOR INSTEAD OF NAMING TABLES
The shovel names its seventeen tables by hand, which is honest but freezes a
snapshot of 42.20: a table renamed or added by a later build silently stops
carrying it. Following an item means the game's own loot design does the work,
and a build that moves hunting vests into a new store moves these with them.

WHY EACH PIECE HAS ITS OWN DONOR AND RARITY
A five-piece set assembled from one table would arrive all at once or not at
all. Spreading the pieces across the places their counterparts live means people
find them one at a time, out of order, over weeks - which is how a set becomes
something you are visibly still completing rather than a costume that dropped.

The mask is deliberately the least rare and the vest the most. The mask is the
piece that reads at a distance and the one somebody can wear on its own and look
like they are in the set; letting it circulate is what makes the rest worth
hunting. The vest is the silhouette, so it is the last thing most people find.

WHY RARITIES ARE RELATIVE, NOT ABSOLUTE
Weights inside a table are relative to that table's own total, and the totals
differ wildly between a wardrobe and a ranger station. A flat 0.05 everywhere
would be common in a small table and invisible in a large one. A multiple of the
donor's weight is the same rarity everywhere by construction.

WHY THIS IS NOT A SANDBOX OPTION
Same reason as the other two: loot tables are built once at boot and never read
again, so a slider could only ever be consulted at load, and this mod's rule is
READ AT USE, NEVER AT LOAD. A setting that looks live in the admin panel while
doing nothing until a restart is worse than a constant in a file that has to be
republished anyway.
]]

require "Items/ProceduralDistributions"

--[[
piece -> { item, donors, rarity }

donors are matched with and without the Base. prefix because loot tables in the
wild use both spellings, and a donor that never matches means a piece that never
spawns - which is indistinguishable from it simply being rare.
]]
local PIECES = {
    {
        item = "Base.Thayne_Mask",
        rarity = 0.05,                       -- one per twenty green bandana masks
        -- Hat_BandanaMask_Green is the MESH donor, but it appears in zero loot
        -- tables in 42.20 - the game distributes the plain Hat_Bandana and lets
        -- players tie it. Following the variant would have meant a mask that
        -- exists and never spawns, which reads exactly like bad luck.
        donors = { "Hat_Bandana", "Base.Hat_Bandana",
                   "Hat_BandanaMask", "Base.Hat_BandanaMask" },
    },
    {
        item = "Base.Thayne_Hood",
        rarity = 0.025,
        -- Same story: the hide hoodie is the mesh donor and is not distributed.
        -- The hunting-camo hoodie is, and is the better thematic parent anyway -
        -- the set turns up where hunting clothes turn up. The white hoodie is
        -- included for coverage, since the camo one is in only nine tables.
        donors = { "Hoodie_HuntingCamo_DOWN", "Base.Hoodie_HuntingCamo_DOWN",
                   "Hoodie_HuntingCamo_UP", "Base.Hoodie_HuntingCamo_UP",
                   "HoodieDOWN_WhiteTINT", "Base.HoodieDOWN_WhiteTINT" },
    },
    {
        item = "Base.Thayne_Vest",
        rarity = 0.0125,                     -- the silhouette; found last
        donors = { "Vest_Hunting_CamoGreen", "Base.Vest_Hunting_CamoGreen",
                   "Vest_Hunting_Grey", "Base.Vest_Hunting_Grey",
                   "Vest_Hunting_Khaki", "Base.Vest_Hunting_Khaki" },
    },
    {
        item = "Base.Thayne_Trousers",
        rarity = 0.03,
        donors = { "Trousers_CamoGreen", "Base.Trousers_CamoGreen",
                   "Trousers_ArmyService", "Base.Trousers_ArmyService" },
    },
    {
        item = "Base.Thayne_Gloves",
        rarity = 0.03,
        donors = { "Gloves_LeatherGloves", "Base.Gloves_LeatherGloves" },
    },
}

--[[
The items list is flat: name, weight, name, weight. Anything else in there is
not ours to interpret, so the walk steps in twos and touches nothing else.

Returns the HIGHEST donor weight found, so a table listing several hunting vests
prices this off the most common one rather than the rarest.
]]
local function donorWeightIn(items, item, donors)
    local w = nil
    for i = 1, #items - 1, 2 do
        local name = items[i]
        if type(name) == "string" then
            if name == item then
                return nil, true             -- already inserted; do not double it
            elseif donors[name] then
                local n = tonumber(items[i + 1])
                if n and (w == nil or n > w) then w = n end
            end
        end
    end
    return w, false
end

for _, piece in ipairs(PIECES) do
    local lookup = {}
    for _, d in ipairs(piece.donors) do lookup[d] = true end

    local placed, skipped, scanned = 0, 0, 0
    for _, dist in pairs(ProceduralDistributions.list or {}) do
        if type(dist) == "table" and type(dist.items) == "table" then
            scanned = scanned + 1
            local w, already = donorWeightIn(dist.items, piece.item, lookup)
            if already then
                skipped = skipped + 1
            elseif w then
                local weight = w * piece.rarity
                -- A weight the engine rounds to nothing is worse than no entry:
                -- it reads as "it is in there somewhere" while never being picked.
                if weight < 0.001 then weight = 0.001 end
                table.insert(dist.items, piece.item)
                table.insert(dist.items, weight)
                placed = placed + 1
            end
        end
    end

    print("WabbajackThayneSet: " .. piece.item .. " added to " .. tostring(placed) ..
          " loot tables at " .. tostring(piece.rarity) .. "x its donor (" ..
          tostring(scanned) .. " scanned, " .. tostring(skipped) .. " already had it)")

    if placed == 0 then
        print("WabbajackThayneSet: WARNING - no table lists a donor for " ..
              piece.item .. ". The item exists but will never spawn. " ..
              "Have the vanilla item ids changed?")
    end
end
