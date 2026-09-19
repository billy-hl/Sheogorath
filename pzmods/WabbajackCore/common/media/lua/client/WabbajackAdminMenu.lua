--[[
Wabbajack — in-game admin menu.

Right-click any square while logged in as staff and you get a "Wabbajack"
submenu: base raids and the foliage check.

EVENTS ONLY. Settings are not here -- they are sandbox options, at
Admin Panel -> Sandbox Options -> Wabbajack Server Toolkit, which is where the
rest of this server's mods keep theirs. The split is between acting on the world
in front of you, which is what a right-click is for, and configuring how the
server behaves, which is not.

TRUST
Nothing here is a security boundary. The menu only *hides* itself from
non-admins so it does not clutter everyone's right-click; the server re-checks
access level on arrival and refuses anything it does not like. A crafted packet
from a modified client is exactly why that second check exists.

The propane mod in this collection records that OnClientCommand "never actually
reached the server in real host-mode testing". That was host mode, not a
dedicated server, and sendClientCommand is used ~70 times by vanilla — but it is
why the bot's file-based path is kept rather than replaced: if this channel ever
goes quiet, the bot's own commands still work.
]]

-- Per-player counts offered for a base raid. The top of this range is heavy:
-- 200 each across a dozen online players is 2,400 zombies placed at once, and
-- they are permanent until somebody kills them.
local RAID_CHOICES = { 20, 40, 80, 120, 160, 200 }

--[[
Who may arm events.

ACCOUNT USERNAMES, not character names. getUsername() is the account -- the same
name the logs and the Discord bridge use; the RP character name lives only in
players.db and is not a permission handle.

DELIBERATELY AN ALLOWLIST, NOT A ROLE CHECK. This used to admit every
admin/moderator/gm/overseer, and that is the wrong grain: `admin` is not a small
group on this server, and arming a base raid places hundreds of zombies that
ZombieRespawn=None means nobody can ever take back. Adding somebody is editing
this line and publishing, which is the friction this deserves.

Compared LOWERCASED, and that is not fussiness. Account names on this server are
typed by hand in three separate places, and the previous version of this check
compared against "Admin" capitalised while the role table stores `admin` -- so
the menu was invisible to everybody, including the owner. A permission test that
fails closed on a capital letter is indistinguishable from the mod being broken.
]]
-- BOTH of the owner's accounts are listed, because they are two separate
-- accounts in the whitelist and only one of them is staff: `Allisteras` is role
-- 2 (a plain user, and the one actually played on) and `AllisterasAdmin` is role
-- 7. Listing only the admin account would have meant the menu never appearing
-- during normal play; listing only the play account would have meant it missing
-- from the account staff work is done on. Drop whichever is not wanted.
local EVENT_HOSTS = { allisteras = true, allisterasadmin = true }

local function isStaff(player)
    if not player or not player.getUsername then return false end
    local ok, name = pcall(function() return player:getUsername() end)
    if not ok or not name then return false end
    return EVENT_HOSTS[string.lower(tostring(name))] == true
end

-- ------------------------------------------------------------ server replies

--[[
A reply to one admin, for menu actions that answer with a number.

player:Say() on its own is not enough. The foliage count ran correctly and
logged its answer server-side while the admin who asked saw nothing at all,
which is indistinguishable from the feature being broken -- and is exactly
how 1.11.0 got reported as doing nothing.

setHaloNote rather than a chat line: it is vanilla, needs no ISChat internals,
and puts the text where the player is already looking.

THIS IS THE ONLY COMMAND LEFT ON THIS CHANNEL. The map marker, the direction
arrow and the server-wide "holdout found" notice all belonged to siege events,
which 1.29.0 removed; nothing sends markerStart, markerStop or notify any more,
so the handlers and the ISWorldMap hook they needed went with them. The channel
name is still "WabbajackSiege" for the reason WabbajackCore.CHANNEL explains.
]]
local function onServerCommand(module, command, args)
    if module ~= "WabbajackSiege" then return end

    if command == "adminNote" and args and args.text then
        local p = (getPlayer and getPlayer()) or (getSpecificPlayer and getSpecificPlayer(0))
        if p and p.setHaloNote then
            pcall(function()
                p:setHaloNote(tostring(args.text), 190, 230, 255, 400.0)
            end)
        end
        return
    end
end

Events.OnServerCommand.Add(onServerCommand)

--[[
Base raid: a horde armed at the safehouse of every online player.

It targets claims, wherever they are, so it takes no location -- which is why
nothing here reads the square under the cursor any more. Siege events were the
only thing on this menu that acted on a specific tile, and they are gone.
]]
local function baseRaid(player, perPlayer)
    sendClientCommand(player, "WabbajackSiege", "baseRaid",
        { perPlayer = tostring(perPlayer) })
    player:Say("Arming base raids…")
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
    -- The one allowed account. isAdmin() is deliberately NOT accepted alongside
    -- it: every admin on this server would pass that, which is exactly the door
    -- this was narrowed to close. Hiding the menu is not the boundary anyway --
    -- the server re-checks the same allowlist on arrival.
    if not isStaff(player) then return end

    -- One "Wabbajack" root rather than each entry sitting loose among the
    -- vanilla options. Everything staff-only lives under it, so the right-click
    -- menu reads the same for staff as it does for everyone else plus one line.
    local root = context:addOption("Wabbajack", nil, nil)
    local menu = ISContextMenu:getNew(context)
    context:addSubMenu(root, menu)

    -- Base raid: targets every online player's own claim, so it ignores the
    -- square entirely.
    if WabbajackCore.present.raids then
    local raidOpt = menu:addOption("Base raid (everyone online)", nil, nil)
    local raidMenu = ISContextMenu:getNew(menu)
    menu:addSubMenu(raidOpt, raidMenu)
    for _, n in ipairs(RAID_CHOICES) do
        raidMenu:addOption(n .. " zombies per player", player, baseRaid, n)
    end
    end

    -- Roadside foliage has no arm or stop -- it runs for every driven vehicle on
    -- the server whenever it is switched on, and that switch is a sandbox
    -- option. All that is left to do from here is check what a square holds.
    if WabbajackCore.present.trailblazer then
        local folOpt = menu:addOption("Overgrowth", nil, nil)
        local folMenu = ISContextMenu:getNew(menu)
        menu:addSubMenu(folOpt, folMenu)

        folMenu:addOption("Check what is here", player, function(p)
            sendClientCommand(p, "WabbajackSiege", "foliageCount", {})
        end)

        -- The sweep clears as areas stream in, so the useful thing to do after
        -- arming it is drive. Hours are offered rather than a single default
        -- because "until I have driven the ring road" and "overnight" are
        -- different jobs.
        local sweepOpt = folMenu:addOption("Clear overgrowth server-wide", nil, nil)
        local hoursMenu = ISContextMenu:getNew(folMenu)
        folMenu:addSubMenu(sweepOpt, hoursMenu)
        for _, h in ipairs({ 1, 6, 12 }) do
            hoursMenu:addOption(h .. " hour" .. (h == 1 and "" or "s"), player, function(p)
                sendClientCommand(p, "WabbajackSiege", "foliageSweepStart", { hours = h })
            end)
        end

        folMenu:addOption("Sweep status", player, function(p)
            sendClientCommand(p, "WabbajackSiege", "foliageSweepStatus", {})
        end)
        folMenu:addOption("Stop sweeping", player, function(p)
            sendClientCommand(p, "WabbajackSiege", "foliageSweepStop", {})
        end)
    end

end

--[[
WHY THE SECTIONS ARE GATED ON WabbajackCore.present

This menu is client-side; the modules it drives are server-side. In multiplayer
the client Lua state cannot see a server global, so the menu has no way to ask
"is the foliage pass installed" directly - which is why the old single-mod
version always drew every entry and let the SERVER answer "that module is not
installed on this server".

Now that these are separate mods that can be enabled independently, silence
would be the answer instead, because an absent mod registers no listener at all.
So each feature mod ships a one-line marker in lua/shared - which loads into
BOTH states - setting its own flag here. No networking, no round trip, and the
entry is simply absent rather than dead.

The one case this gets wrong is a client with a mod the server lacks. Zomboid
already refuses to connect on a mod mismatch, so that state does not survive
joining.
]]
Events.OnFillWorldObjectContextMenu.Add(onFillMenu)
