--[[
Shift + right-click a recipe -- in the craft menu, the build menu, or on a
Shortcut slot -- to pull its materials out of nearby containers into your hands.

THE PROBLEM IT SOLVES
Building means standing at the site, reading what the recipe wants, walking back
to the crate, opening it, dragging planks, walking back. The materials are
usually right there in a stash a few tiles away. This does the fetching.

WHY SHIFT + RIGHT-CLICK
On TheShortcut's slots plain right-click is already taken -- it opens the
Building or Crafting window and scrolls to the recipe. On the Neat_Crafting and
Neat_Building recipe entries right-click is unused entirely. Shift is free in
all three mods (none of them reads isShiftKeyDown anywhere), so one consistent
gesture works everywhere and no existing behaviour is taken away. Unmodified
clicks fall through untouched.

SOFT DEPENDENCY, DELIBERATELY. There is no `require=` on any of these UI mods in
mod.info and there must not be. A hard require means that if TheShortcut or NeatUI_Framework
is ever removed or fails to load, the WHOLE toolkit fails to load with it -- and
on this server a mod that fails to load gets automatically disabled by the
restart script's health check, taking sieges, base raids and foliage down with
it over a UI convenience. So this detects each UI at runtime and quietly
does nothing about the ones that are absent.

WRAPPED, NOT REPLACED. The original onRightMouseUp is kept and called, so if one
of these mods changes its handler, unmodified clicks keep working and only the
shift path is at risk. On the Neat entries there IS no original -- right-click is
unused there -- and a plain click must keep doing nothing, which is why the
call-through is guarded rather than assumed.

All three mods fork themselves by game build (TheShortcut 42.12/13/14,
Neat_Building 42/13/14/15, Neat_Crafting 42/42.13, each chosen by versionMin).
This patches whichever class definition actually loaded, so it follows those
forks automatically; a future tree that RENAMES a class would silently skip it.
Hence the count logged on install -- silence would look identical to working.

WHAT "NEARBY" MEANS
ISInventoryPaneContextMenu.getContainers(), the same call vanilla's context menu
and ISHandCraftPanel use, so this reaches exactly what the game says the
character can reach. Critically it is ALSO the call ProximityInventory patches
to strip its synthetic aggregate container -- see nearbyContainers() for why
reading the loot window's `backpacks` directly instead was wrong twice over.

TAKE WHAT YOU CAN, THEN SAY WHAT YOU DID NOT
Partial hauls are useful; an all-or-nothing rule would refuse to fetch nineteen
of twenty planks. So it loads you up -- past your carry limit, because the game
allows that and hauling heavy to a build site is the point -- and then reports
what is still missing and what it stopped short of, with the actual numbers.
"Nothing happened" and "you are already over the limit" look identical
otherwise, and a vague "too heavy" reads as broken when the player can pick the
same item up by hand a second later.
]]

local function log(msg) print("[WabbajackGather] " .. tostring(msg)) end

--[[
How far past the carry limit a gather is allowed to load you.

PZ DOES NOT FORBID BEING OVERWEIGHT. It slows you down and tires you out, but
you can keep picking things up, and deliberately hauling an over-capacity load
to a build site is ordinary play. Refusing to exceed capacity was stricter than
the game itself: players were told "too heavy to carry the rest" and could then
pick up the very same items by hand, which reads as the feature being broken.

1.5 = up to fifty percent over. Slow, but walkable, and it still stops before
somebody is pinned in place by four hundred nails.
]]
local OVERFILL = 1.5

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
    local mine = player:getInventory()

    --[[
    ISInventoryPaneContextMenu.getContainers() IS THE ONE TO ASK, NOT `backpacks`.

    This used to walk getPlayerLoot(pn).inventoryPane.inventoryPage.backpacks
    directly, which breaks badly with ProximityInventory installed. That mod
    injects a synthetic aggregate container ("proxInv") into `backpacks` and
    fills it with addAll() of the REAL item references from every nearby
    container. Reading backpacks therefore saw every item twice -- once in its
    true container and once in the aggregate -- and handed the transfer action a
    container that does not actually hold the item, so the count was inflated
    and nothing moved.

    ProximityInventory's own CraftingFix.lua patches getContainers() to strip
    that aggregate, under the comment "Very important file, it avoids duping in
    SP and MP". Asking through the supported API gets that fix for free, and it
    is the same call vanilla's context menu and ISHandCraftPanel use.
    ]]
    pcall(function()
        local list = ISInventoryPaneContextMenu.getContainers(player)
        if not list then return end
        for i = 0, list:size() - 1 do
            local c = list:get(i)
            -- Skip the player's own inventory: it is the destination, and
            -- anything already in their bags is counted by carried() anyway.
            if c and c ~= mine then out[#out + 1] = c end
        end
    end)
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

    --[[
    getCapacityWeight() IS THE CURRENT LOAD, NOT THE CAPACITY.

    The name reads backwards and it cost a release. This was
    `getCapacityWeight() - getContentsWeight()`, which is current minus current
    -- near enough zero, then made negative by a headroom subtraction -- so the
    very first item was always "too heavy" and nothing ever transferred.

    ISHotbar.lua:572 settles it by using both in one expression:
        getInventory():getCapacityWeight() ... > getInventory():getMaxWeight()
    Current on the left, limit on the right. getMaxWeight() is the limit.
    ]]
    local ceiling = inv:getMaxWeight() * OVERFILL
    local load = inv:getCapacityWeight()

    local took, queued, heavy, fluids = 0, 0, false, 0
    local missing = {}

    --[[
    Items already queued this click, by id.

    A recipe input can list several acceptable types and the same item can be
    reachable through more than one container view, so without this the same
    physical object gets queued twice: the first transfer moves it, the second
    silently fails against a container that no longer holds it, and the reported
    count is larger than what actually arrives.
    ]]
    local claimed = {}

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
                -- Captured before the loop mutates `short`, so the log can say
                -- how much was already carried versus how much this call took.
                local short_before = short
                local taken_here = 0

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
                                --[[
                                ASK THE ITEM WHERE IT LIVES. Passing `src` --
                                the container we happened to search -- is wrong
                                whenever the item is really somewhere else: in a
                                bag nested inside it, or aggregated into a view
                                like ProximityInventory's. The transfer then
                                tries to remove it from a container that does
                                not hold it and silently does nothing.

                                Every vanilla call site does it this way:
                                  ISInventoryTransferAction:new(
                                      player, fabric, fabric:getContainer(), ...)
                                ]]
                                local from = item and item.getContainer and item:getContainer()
                                local id = item and item.getID and item:getID()
                                if item and from and not (id and claimed[id]) then
                                    -- Unequipped weight: this is going into a
                                    -- container, not onto the character, and it
                                    -- is what vanilla's own transfer maths uses.
                                    local w = (item.getUnequippedWeight and item:getUnequippedWeight())
                                        or item:getWeight() or 0
                                    if load + w > ceiling then
                                        heavy = true
                                    else
                                        if id then claimed[id] = true end
                                        ISTimedActionQueue.add(
                                            ISInventoryTransferAction:new(player, item, from, inv, nil))
                                        load = load + w
                                        short = short - 1
                                        took = took + 1
                                        taken_here = taken_here + 1
                                        queued = queued + 1
                                    end
                                end
                            end
                        end
                    end
                end

                local label = (types[1] and getScriptManager():getItem(types[1])
                    and getScriptManager():getItem(types[1]):getDisplayName())
                    or input:getType() or "material"

                --[[
                One line per input, always.

                Three rounds of this feature have now been debugged from a
                player saying "it grabbed some of it", which cannot distinguish
                "the recipe only wanted one" from "we found one" from "we queued
                five and four were wiped by the transfer queue's merge". The
                numbers that separate those live here and nowhere else.

                Tag-based inputs are the specific worry: `item 1 tags[Sheet]` is
                not a fulltype, so if getPossibleInputItems() comes back empty
                for it, types is empty, nothing can ever be found, and it would
                otherwise fail as a silent "missing 1 material".
                ]]
                log(string.format("input %s: need %d, carrying %d, types %d, queued %d",
                    tostring(label), need, need - short_before, #types, taken_here))

                if short > 0 then
                    missing[#missing + 1] = short .. " " .. tostring(label)
                end
            end
        end
    end

    return { took = took, missing = missing, heavy = heavy, fluids = fluids,
             capped = queued >= MAX_TRANSFERS,
             load = load, max = inv:getMaxWeight() }
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
        -- Say the actual numbers. "Too heavy" alone is what made this look
        -- broken: the player could pick the same items up by hand a second
        -- later, because the game allows what this had refused.
        tell(player, string.format("Stopped at %.1f / %.0f - already over the limit.",
            r.load or 0, r.max or 0), false)
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
    if not class then
        log(className .. ": not present - skipped")
        return false
    end

    --[[
    The original may be nil, and that is a normal case rather than a failure.

    TheShortcut's slots define onRightMouseUp (it opens the crafting window).
    The Neat_Crafting and Neat_Building recipe entries do not define one at all
    -- right-click is simply unused there -- so `original` resolves through the
    ISUIElement inheritance chain or comes back nil. Either way an unmodified
    click must behave exactly as it did before, which for those means doing
    nothing at all.
    ]]
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
        if type(original) == "function" then return original(self, x, y) end
        return false
    end
    log(className .. ": shift+right-click gather installed")
    return true
end

--[[
Patched on game start rather than at file load.

Mod file load order is not defined, so at load time TheShortcut's classes may
not exist yet. By OnGameStart every mod's files have run.
]]
--[[
Every surface that shows a recipe, and where it lives.

All four of the Neat entries keep the recipe on `.recipe` and all of them call
recipe:getInputs() themselves, so one gather implementation serves the lot --
build recipes and craft recipes are both CraftRecipe in B42.

Each mod ships several trees chosen by versionMin (TheShortcut 42.12/13/14,
Neat_Building 42/13/14/15, Neat_Crafting 42/42.13). This patches whichever
class definition actually loaded, so it follows those forks automatically; what
it cannot survive is a tree that renames the class, hence the warning below.

Deliberately NOT the inventory pane. Shift is the multi-select modifier there --
CleanUI reads isShiftKeyDown in seven places across its inventory pane for range
selection and drag guards -- so shift+right-click on an inventory item would
fight selection, and an inventory item is not a recipe anyway: it would need a
reverse output->recipe lookup and a guess at which of several recipes was meant.
The craft and build menus already have the recipe in hand.
]]
local TARGETS = {
    { "ShortcutBuildSlot",          "building" },   -- TheShortcut, build slot
    { "ShortcutRecipeSlot",         "recipe"   },   -- TheShortcut, recipe slot
    { "NC_RecipeList_Box",          "recipe"   },   -- Neat_Crafting, list view
    { "NC_RecipeList_Grid",         "recipe"   },   -- Neat_Crafting, grid view
    { "NB_BuildingRecipeList_Box",  "recipe"   },   -- Neat_Building, list view
    { "NB_BuildingRecipeList_Grid", "recipe"   },   -- Neat_Building, grid view
}

local function install()
    local present, patched = 0, 0
    for _, t in ipairs(TARGETS) do
        if _G[t[1]] then
            present = present + 1
            if patch(t[1], t[2]) then patched = patched + 1 end
        end
    end

    if present == 0 then
        log("no supported crafting UI found - gather disabled (this is fine)")
    elseif patched == 0 then
        log("WARNING: " .. present .. " UI class(es) present but none could be patched"
            .. " - they may have been renamed")
    else
        log("gather ready on " .. patched .. " of " .. present .. " UI surface(s)")
    end
end

Events.OnGameStart.Add(install)
