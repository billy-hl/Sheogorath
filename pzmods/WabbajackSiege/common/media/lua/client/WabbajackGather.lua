--[[
Shift + right-click a Shortcut slot to pull its materials out of nearby
containers and into your hands.

THE PROBLEM IT SOLVES
Building means standing at the site, reading what the recipe wants, walking back
to the crate, opening it, dragging planks, walking back. The materials are
usually right there in a stash a few tiles away. This does the fetching.

WHY SHIFT + RIGHT-CLICK
Plain right-click is already taken: TheShortcut opens the Building or Crafting
window and scrolls to the recipe. Nothing anywhere in that mod reads
isShiftKeyDown, so the modifier is unclaimed and this adds a behaviour without
taking one away. Unmodified clicks fall through to the original handler
untouched.

SOFT DEPENDENCY, DELIBERATELY. There is no `require=TheShortcut` in mod.info and
there must not be. A hard require means that if TheShortcut or NeatUI_Framework
is ever removed or fails to load, the WHOLE toolkit fails to load with it -- and
on this server a mod that fails to load gets automatically disabled by the
restart script's health check, taking sieges, base raids and foliage down with
it over a UI convenience. So this detects TheShortcut at runtime and quietly
does nothing if it is absent.

WRAPPED, NOT REPLACED. The original onRightMouseUp is kept and called. If
TheShortcut changes its handler, unmodified clicks keep working and only the
shift path is at risk. Note also that TheShortcut forks itself by game build
(42.12 / 42.13 / 42.14 trees, chosen by versionMin) -- this patches whichever
class definition actually loaded, so it follows the fork automatically, but a
future tree that renames these classes would silently skip the patch. Hence the
log line on install: silence would look identical to working.

WHAT "NEARBY" MEANS
Exactly what the crafting UI means by it. ISCraftingUI:getContainers() (and its
copy in CraftTooltip) builds its list from the loot window's backpacks, which is
the game's own answer to "what can this character reach". Taking from the same
source means this gathers precisely the items the recipe would have counted as
available -- never something the recipe could not have used anyway.

TAKE WHAT YOU CAN, THEN SAY WHAT YOU DID NOT
Partial hauls are useful; an all-or-nothing rule would refuse to fetch nineteen
of twenty planks. So it fills up to the weight it can carry and reports both
what is still missing and what it left behind, because "nothing happened" and
"you are too heavy to carry the rest" look identical otherwise.
]]

local function log(msg) print("[WabbajackGather] " .. tostring(msg)) end

--[[
Leave this much carry weight spare.

Filling to exactly capacity leaves the player instantly overencumbered and
unable to pick up the hammer, which is a worse outcome than one fewer plank.
]]
local WEIGHT_HEADROOM = 2.0

--[[
Hard ceiling on queued transfers per click.

Each item is its own ISInventoryTransferAction. A recipe wanting eighty nails
would otherwise queue eighty timed actions the player cannot interrupt cleanly.
]]
local MAX_TRANSFERS = 40

--- Floating feedback, falling back to speech if the halo helper is unavailable.
local function tell(player, msg, good)
    local ok = pcall(function()
        if good then HaloTextHelper.addGoodText(player, msg)
        else HaloTextHelper.addBadText(player, msg) end
    end)
    if not ok then pcall(function() player:Say(msg) end) end
end

--[[
The containers this character can reach, as the crafting UI defines it.

The loot side only. The player's own inventory is the destination, not a source
-- pulling planks out of your own backpack into your own hands is not fetching.
]]
local function nearbyContainers(player)
    local out = {}
    local ok = pcall(function()
        local pn = player:getPlayerNum()
        local loot = getPlayerLoot(pn)
        if not loot or not loot.inventoryPane or not loot.inventoryPane.inventoryPage then return end
        for _, v in ipairs(loot.inventoryPane.inventoryPage.backpacks) do
            if v and v.inventory then out[#out + 1] = v.inventory end
        end
    end)
    if not ok then return {} end
    return out
end

--[[
The item types this recipe input will accept, as full types.

An input is usually a CHOICE, not a single item -- "any plank", "any nails" --
so getPossibleInputItems() returns a list and any one of them satisfies the
requirement. Treating only the first as valid would refuse to fetch materials
that would have worked perfectly well.
]]
local function acceptedTypes(input)
    local types = {}
    pcall(function()
        local items = input:getPossibleInputItems()
        if not items then return end
        for i = 0, items:size() - 1 do
            local ft = items:get(i):getFullName()
            if ft then types[#types + 1] = ft end
        end
    end)
    return types
end

--- How many of any accepted type the player is already carrying.
local function carried(player, types)
    local n = 0
    local inv = player:getInventory()
    for _, ft in ipairs(types) do
        pcall(function() n = n + inv:getCountTypeRecurse(ft) end)
    end
    return n
end

--[[
Gathers everything one recipe needs that the player is not already carrying.

Returns a report rather than printing one, so the caller decides how to say it.
]]
local function gatherFor(player, recipe)
    local inputs = recipe:getInputs()
    if not inputs or inputs:size() == 0 then
        return { took = 0, missing = {}, heavy = false, fluids = 0 }
    end

    local inv = player:getInventory()
    local sources = nearbyContainers(player)
    local free = inv:getCapacityWeight() - inv:getContentsWeight() - WEIGHT_HEADROOM

    local took, queued, heavy, fluids = 0, 0, false, 0
    local missing = {}

    for i = 0, inputs:size() - 1 do
        local input = inputs:get(i)
        -- Automation-only inputs belong to machines, not to a person carrying
        -- planks to a build site.
        if input and not input:isAutomationOnly() then
            if input:getResourceType() ~= ResourceType.Item then
                -- Fluids cannot be "carried to the site" as items. Counted and
                -- reported rather than silently dropped, because a recipe that
                -- still will not build needs to say why.
                fluids = fluids + 1
            else
                local need = input:getIntAmount() or 0
                local types = acceptedTypes(input)
                local short = need - carried(player, types)

                for _, ft in ipairs(types) do
                    if short <= 0 then break end
                    for _, src in ipairs(sources) do
                        if short <= 0 or queued >= MAX_TRANSFERS then break end
                        local found
                        pcall(function() found = src:getItemsFromFullType(ft) end)
                        if found then
                            for k = 0, found:size() - 1 do
                                if short <= 0 or queued >= MAX_TRANSFERS then break end
                                local item = found:get(k)
                                if item then
                                    local w = item:getWeight() or 0
                                    if w > free then
                                        heavy = true
                                    else
                                        ISTimedActionQueue.add(
                                            ISInventoryTransferAction:new(player, item, src, inv, nil))
                                        free = free - w
                                        short = short - 1
                                        took = took + 1
                                        queued = queued + 1
                                    end
                                end
                            end
                        end
                    end
                end

                if short > 0 then
                    local label = (types[1] and getScriptManager():getItem(types[1])
                        and getScriptManager():getItem(types[1]):getDisplayName())
                        or input:getType() or "material"
                    missing[#missing + 1] = short .. " " .. tostring(label)
                end
            end
        end
    end

    return { took = took, missing = missing, heavy = heavy, fluids = fluids,
             capped = queued >= MAX_TRANSFERS }
end

--- Runs a gather and reports it, for whichever slot type was clicked.
local function doGather(player, recipe)
    if not player or player:isDead() then return end
    if not recipe then return end

    local ok, r = pcall(gatherFor, player, recipe)
    if not ok then
        log("gather failed: " .. tostring(r))
        tell(player, "Could not gather materials.", false)
        return
    end

    if r.took > 0 then
        tell(player, "Gathering " .. r.took .. " item" .. (r.took == 1 and "" or "s") .. ".", true)
    end
    if #r.missing > 0 then
        tell(player, "Still need: " .. table.concat(r.missing, ", "), false)
    end
    if r.heavy then
        tell(player, "Too heavy to carry the rest.", false)
    end
    if r.capped then
        tell(player, "Grabbed the first " .. MAX_TRANSFERS .. " - click again for more.", false)
    end
    if r.fluids > 0 then
        tell(player, r.fluids .. " fluid input(s) cannot be carried.", false)
    end
    if r.took == 0 and #r.missing == 0 and not r.heavy and r.fluids == 0 then
        tell(player, "You already have everything.", true)
    end
end

--[[
Wraps one slot class's right-click.

`field` is where that class keeps the thing it points at -- BuildSlot calls it
`building`, RecipeSlot calls it `recipe` -- and both are CraftRecipe objects, so
getInputs() works the same on either.
]]
local function patch(className, field)
    local class = _G[className]
    if not class or type(class.onRightMouseUp) ~= "function" then
        log(className .. ": not present or has no onRightMouseUp - skipped")
        return false
    end

    local original = class.onRightMouseUp
    class.onRightMouseUp = function(self, x, y)
        if isShiftKeyDown and isShiftKeyDown() then
            local recipe = self and self[field]
            if recipe then
                -- Dismiss the tooltip the same way the original does, or it
                -- hangs on screen over the gather.
                pcall(function()
                    if self.tooltipRender and self.tooltipRender:isVisible() then
                        self.tooltipRender:removeFromUIManager()
                        self.tooltipRender:setVisible(false)
                    end
                end)
                doGather(getSpecificPlayer(0), recipe)
                return true
            end
        end
        return original(self, x, y)
    end
    log(className .. ": shift+right-click gather installed")
    return true
end

--[[
Patched on game start rather than at file load.

Mod file load order is not defined, so at load time TheShortcut's classes may
not exist yet. By OnGameStart every mod's files have run.
]]
local function install()
    if not ShortcutBuildSlot and not ShortcutRecipeSlot then
        log("TheShortcut not installed - gather disabled (this is fine)")
        return
    end
    local a = patch("ShortcutBuildSlot", "building")
    local b = patch("ShortcutRecipeSlot", "recipe")
    if not a and not b then
        log("WARNING: TheShortcut is present but neither slot class could be patched"
            .. " - it may have changed its class names")
    end
end

Events.OnGameStart.Add(install)
