--[[
Wabbajack siege — in-game admin menu.

Right-click any square while logged in as staff and you get a "Siege" submenu
that arms an event on the building you are standing on or pointing at.

Menu-armed events are ALWAYS SILENT. Announcing is the bot's job, not this
mod's, so nothing here broadcasts - the loot and the horde are simply placed and
players find them. Use /pz siege when you want it announced; use this when you
want it discovered.

TRUST
Nothing here is a security boundary. The menu only *hides* itself from
non-admins so it does not clutter everyone's right-click; the server re-checks
access level on arrival and refuses anything it does not like. A crafted packet
from a modified client is exactly why that second check exists.

The propane mod in this collection records that OnClientCommand "never actually
reached the server in real host-mode testing". That was host mode, not a
dedicated server, and sendClientCommand is used ~70 times by vanilla — but it is
why the bot's file-based path is kept rather than replaced: if this channel ever
goes quiet, /pz siege still works.
]]

local ZOMBIE_CHOICES = { 100, 200, 300 }

--- Squares can come from the object under the cursor or the player's own tile.
local function squareFor(worldObjects, player)
    for _, o in ipairs(worldObjects or {}) do
        if o and o.getSquare and o:getSquare() then return o:getSquare() end
    end
    return player and player:getSquare() or nil
end

local function arm(player, square, zombies, loot, silent)
    if not square then return end
    sendClientCommand(player, "WabbajackSiege", "arm", {
        x = square:getX(), y = square:getY(), z = square:getZ(),
        zombies = zombies, loot = loot, silent = silent and "1" or "0",
    })
    player:Say(silent and "Arming siege quietly…" or "Arming siege…")
end

local function cancel(player)
    sendClientCommand(player, "WabbajackSiege", "cancel", {})
    player:Say("Cancelling siege…")
end

--[[
Note the `test` parameter.

The game calls every context-menu handler twice: once with test=true purely to
ask "do you have anything to add here?", and once for real. A handler that
builds its options during the test pass gets them silently discarded, which is
exactly why the first version of this menu never appeared. Every vanilla handler
opens with this same guard.
]]
local function onFillMenu(playerNum, context, worldObjects, test)
    if test and ISWorldObjectContextMenu.Test then return true end
    local player = getSpecificPlayer(playerNum)
    if not player then return end
    -- Staff only. isAdmin() covers the owner; the access level check picks up
    -- the moderator/admin tiers on a dedicated server.
    local lvl = player.getAccessLevel and player:getAccessLevel() or "None"
    if not (isAdmin() or lvl == "Admin" or lvl == "Moderator") then return end

    local square = squareFor(worldObjects, player)
    if not square then return end

    local root = context:addOption("Siege", nil, nil)
    local sub = ISContextMenu:getNew(context)
    context:addSubMenu(root, sub)

    for _, n in ipairs(ZOMBIE_CHOICES) do
        local opt = sub:addOption(n .. " zombies", nil, nil)
        local tiers = ISContextMenu:getNew(sub)
        sub:addSubMenu(opt, tiers)
        tiers:addOption("High loot", player, arm, square, n, "high", true)
        tiers:addOption("Standard loot", player, arm, square, n, "standard", true)
    end

    sub:addOption("Cancel current siege", player, cancel)

    -- Ground sweep. Counting first is deliberate: removal cannot be undone and
    -- cannot tell a discarded corpse pile from somebody's deliberate stash.
    local sweep = context:addOption("Ground sweep", nil, nil)
    local ssub = ISContextMenu:getNew(context)
    context:addSubMenu(sweep, ssub)
    ssub:addOption("Count what would go (safe)", player, function(p)
        sendClientCommand(p, "WabbajackSiege", "sweepCount", {})
    end)
    ssub:addOption("START removing (outside claims)", player, function(p)
        sendClientCommand(p, "WabbajackSiege", "sweepStart", {})
    end)
    ssub:addOption("Stop sweeping", player, function(p)
        sendClientCommand(p, "WabbajackSiege", "sweepStop", {})
    end)
end

Events.OnFillWorldObjectContextMenu.Add(onFillMenu)
