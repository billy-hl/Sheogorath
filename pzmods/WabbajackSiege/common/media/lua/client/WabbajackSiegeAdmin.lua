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

require "ISUI/Maps/ISWorldMap"

local ZOMBIE_CHOICES = { 100, 200, 300 }

--[[
Whether the local player is staff.

THE ROLE NAMES ARE LOWERCASE. getAccessLevel() returns a name out of the
server's `role` table, and that table stores `admin`, `moderator`, `gm` in lower
case. This file compared against "Admin" and "Moderator" capitalised, so the
menu was invisible to everyone -- including the owner, whose account is role 7,
`admin`. That, not the context-menu test pass, is why the menu never appeared
the second time round.

The server re-checks this on arrival; hiding a menu is not a permission check.
]]
local STAFF_ROLES = { admin = true, moderator = true, gm = true, overseer = true }

local function isStaff(player)
    if not player or not player.getAccessLevel then return false end
    local ok, lvl = pcall(function() return player:getAccessLevel() end)
    if not ok or not lvl then return false end
    return STAFF_ROLES[string.lower(tostring(lvl))] == true
end

-- ------------------------------------------------------------- site marker

--[[
Draws the siege site for every player, the way the airdrop mod marks a drop.

Two separate things, because they answer different questions: a blinking circle
on the world map says WHERE, and an on-screen direction arrow says WHICH WAY
from here. Both are client-only APIs -- there is no server-side equivalent -- so
the server sends coordinates and this does the drawing.

The map hook exists because a marker added while the map is closed does not
survive the map building itself later; ISWorldMap.initDataAndStyle is wrapped so
the marker is reapplied whenever the map is constructed.
]]
local MARKER = { r = 0.78, g = 0.53, b = 0.16, a = 0.95 }   -- amber

local active, mapMarker, mapAPI, arrow = nil, nil, nil, nil

local function safe(fn)
    local ok, r = pcall(fn)
    if ok then return r end
    return nil
end

local function removeArrow()
    if arrow then safe(function() arrow:remove() end) end
    arrow = nil
end

local function removeMapMarker()
    if mapMarker and mapAPI then
        safe(function()
            local api = mapAPI:getMarkersAPI()
            if api and api.removeMarker then api:removeMarker(mapMarker) end
        end)
    end
    mapMarker, mapAPI = nil, nil
end

local function applyArrow()
    removeArrow()
    if not active or not getWorldMarkers then return end
    local p = (getPlayer and getPlayer()) or (getSpecificPlayer and getSpecificPlayer(0))
    if not p then return end
    arrow = safe(function()
        return getWorldMarkers():addDirectionArrow(
            p, active.x, active.y, active.z, nil, MARKER.r, MARKER.g, MARKER.b, 1.0)
    end)
end

local function applyMapMarker(mapUI)
    removeMapMarker()
    if not active then return end
    if not mapUI or not mapUI.mapAPI or not mapUI.mapAPI.getMarkersAPI then return end
    local m = safe(function()
        local api = mapUI.mapAPI:getMarkersAPI()
        if api and api.addGridSquareMarker then
            return api:addGridSquareMarker(active.x, active.y, active.radius,
                MARKER.r, MARKER.g, MARKER.b, MARKER.a)
        end
        return nil
    end)
    if not m then return end
    if m.setBlink then m:setBlink(true) end
    if m.setMinScreenRadius then m:setMinScreenRadius(12) end
    mapMarker, mapAPI = m, mapUI.mapAPI
end

local mapHooked = false
local function installMapHook()
    if mapHooked then return end
    if not ISWorldMap or not ISWorldMap.initDataAndStyle then return end
    local original = ISWorldMap.initDataAndStyle
    ISWorldMap.initDataAndStyle = function(self, ...)
        local result = original(self, ...)
        applyMapMarker(self)
        return result
    end
    mapHooked = true
end

local function onServerCommand(module, command, args)
    if module ~= "WabbajackSiege" then return end

    if command == "markerStart" and args and args.x and args.y then
        active = {
            id = tostring(args.id or ""),
            x = math.floor(tonumber(args.x) or 0),
            y = math.floor(tonumber(args.y) or 0),
            z = math.floor(tonumber(args.z) or 0),
            radius = math.max(1, tonumber(args.radius) or 30),
        }
        installMapHook()
        applyArrow()
        if ISWorldMap_instance then applyMapMarker(ISWorldMap_instance) end
        return
    end

    if command == "markerStop" then
        -- Ignore a stop for an event that is not the one being shown, so a late
        -- teardown cannot wipe the marker for the siege that replaced it.
        if args and args.id and active and active.id ~= tostring(args.id) then return end
        removeArrow()
        removeMapMarker()
        active = nil
    end
end

Events.OnServerCommand.Add(onServerCommand)
installMapHook()

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
    -- Staff only. isAdmin() covers the owner; isStaff picks up the admin,
    -- moderator and gm tiers by their real, lowercase role names.
    if not (isAdmin() or isStaff(player)) then return end

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
