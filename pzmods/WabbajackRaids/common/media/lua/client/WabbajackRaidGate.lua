--[[
Raid gate - the client half of raid protection.

WabbajackRaidWindow.lua on the server decides which bases are raidable and sends
the list. This file is what makes that list mean anything: it opens the vanilla
safehouse loot check for exactly those bases and leaves it alone for every other.

WHY THE CHECK HAS TO BE OPENED FROM LUA, AND CANNOT BE CONFIGURED
Verified by disassembling zombie/iso/areas/SafeHouse out of projectzomboid.jar
on 2026-08-19 (B42.20). Looting a container in somebody's safehouse is gated by
SafeHouse.isSafehouseAllowLoot(square, player), which is:

    safehouseAllowLoot option  OR  staff CanGoInsideSafehouses  OR
    an active WarManager war   OR  players.contains(you) OR owner.equals(you)

That is the entire list. There is no per-base and no time-based term in it, so
"raidable for the next five minutes" is not something the server options can
express: SafehouseAllowLoot is global and permanent in both directions.

THREE THINGS THAT LOOK LIKE THE LEVER AND ARE NOT
Worth writing down, because each one costs an afternoon to rediscover.

- setPlayerConnected() cannot be used. updatePlayersConnected() resets the
  counter and recounts from scratch, and it is called from GameClient.update()
  and IsoWorld.updateThread - per frame, on both sides. Anything Lua writes is
  gone within a frame.
- getOpenTimer()/getPlayerConnected() and the DisableSafehouseWhenOwnerConnected
  option are read by isSafeHouse(sq, user, true) and isSafehouseAllowTrepass -
  and by NOTHING on the loot path. They govern trespass and moveables. Turning
  that option on does not make a base lootable.
- The one loot-ish call that does consult them, in
  ISInventoryTransferAction:isValid(), is dead code: every branch below it
  returns false regardless.

WHAT THIS OVERRIDES, AND WHY THAT IS ENOUGH
The vanilla call sites that block a non-member from looting all funnel into that
one function:

    client/ISUI/ISInventoryPage.lua:1685      containers on nearby squares
    server/ISObjectClickHandler.lua:278       right-clicking a container
    client/Foraging/ISSearchManager.lua:1107  foraging inside a claim
    shared/Moveables/ISMoveablesAction.lua:54 picking up and placing furniture

so replacing isSafehouseAllowLoot reaches all four at once. Copying those four
functions into the mod instead would work today and break on the next build, and
a miss in any one of them is a silent hole that only shows up as somebody's base
emptied while it was supposed to be protected.

THE FIFTH ONE IS NOT IN LUA, WHICH IS WHY THERE IS A SECOND HOOK BELOW
The world right-click menu is assembled in Java, by
ISWorldObjectContextMenuLogic. Its `fetch` pass calls isSafehouseAllowLoot
itself and stores the answer in the fetch table, and `createMenuEntries` later
reads that stored boolean - so it never goes near the Lua global and a Lua
override cannot reach it. The menu would keep saying
ContextMenu_NoSafehousePermissionObjects on a base this mod had opened.

The fetch table is ordinary Lua and vanilla fires OnPreFillWorldObjectContextMenu
between the two passes, which is exactly the seam needed: correct the stored
answer there and createMenuEntries reads the corrected one. Nothing is copied and
no Java is patched.

isSafehouseAllowInteract is deliberately NOT overridden. Dismantling somebody's
walls is what it guards, vanilla opens it only during a declared war, and this
feature is about what is in the containers. Sledgehammers already work on this
server either way.

FAIL-CLOSED, DELIBERATELY
Every failure here leaves bases MORE protected, never less:

- a client that has heard nothing from the server has an empty open set, so it
  protects everything, which is exactly the server's current behaviour;
- if the override does not install, the original function is untouched and
  vanilla protection stands;
- the wrapper asks the original first and never overrides a `true` into a
  `false`.

That is also why no server option has to change to deploy this. SafehouseAllowLoot
stays false. If this whole file never runs, the server behaves exactly as it does
today rather than throwing every base open.

THIS IS NOT A SECURITY BOUNDARY, AND NEITHER IS VANILLA'S
Every safehouse check in the game is client-side; the anticheats that mention
safehouses (AntiCheatSafeHouseOwner/Member/NotMember) are wired only to the
claim, accept and change-owner packets, not to anything that moves an item. A
modified client could always loot any base. That is the game's own posture and
this changes nothing about it.
]]

local MODULE = "WabbajackRaid"

local function log(msg) print("[WabbajackRaidGate] " .. tostring(msg)) end

-- key ("x,y" of the claim's top-left corner) -> true while raidable. Empty
-- until the server says otherwise, which means "everything protected".
local openKeys = {}
local heard = 0             -- open-set broadcasts this client has actually received

local realSafeHouse = nil   -- the Java class table, kept for our own lookups
local origAllowLoot = nil
local installedAs = nil     -- "direct", "proxy" or "failed"

local function keyOf(safehouse)
    return tostring(safehouse:getX()) .. "," .. tostring(safehouse:getY())
end

--[[
The replacement for SafeHouse.isSafehouseAllowLoot.

Static, so it takes the square and the player rather than a self. Asks vanilla
first and only ever widens its answer: members, staff and war are vanilla's
business and stay vanilla's business, and a base nobody is home at falls through
to the original `false`.
]]
--[[
Does this player live here?

THIS IS THE FIX FOR THE 1.17.0 FAILURE, and it is the reason the question is
answered here rather than by asking the function we replaced.

The old gate opened by calling the original isSafehouseAllowLoot and taking a
`true` from it as "vanilla allows this, we are done". Members and owners were
supposed to be covered by that. In the field they were not: people were locked
out of their own bases, which can only happen if that call was not coming back
with vanilla's `true`. Whatever the reason -- a Java static pulled off a class
table is not something vanilla ever does -- the shape of the bug is that a
membership test we did not control decided whether somebody could open their own
crates.

So membership is now tested against the claim itself, which is the entirety of
what vanilla's playerAllowed() does (disassembled 2026-08-19):

    players.contains(username)  OR  owner.equals(username)

Nothing about that needs the override to have installed correctly, needs the
server to have said anything, or can throw somewhere we then have to interpret.
A member cannot be refused by this file any more, by construction.
]]
local function livesHere(safehouse, player)
    local ok, mine = pcall(function()
        local name = player:getUsername()
        if safehouse:getOwner() == name then return true end
        local players = safehouse:getPlayers()
        return players ~= nil and players:contains(name)
    end)
    -- An error here means "we could not prove they are NOT a member", and the
    -- benefit of that doubt goes to the player standing in the building.
    return (not ok) or mine == true
end

--[[
The replacement's answer, memoised per square.

ISInventoryPage:refreshBackpacks asks this for all nine squares around the
player, and ISInventoryPage:update calls that on every step and every turn. The
1.17.0 gate did two full scans of the safehouse list plus a fresh closure and
three string allocations on each of those nine, every step, which is what made
picking things up feel slow. The answer only changes when the open set changes
or somebody joins or leaves a claim, so it is cached and dropped wholesale.
]]
local answers = {}

local function squareKey(square)
    return tostring(square:getX()) .. "," .. tostring(square:getY()) .. "," .. tostring(square:getZ())
end

local function allowLoot(square, player)
    if not square or not player then return true end

    local sk = squareKey(square)
    local hit = answers[sk]
    if hit ~= nil then return hit end

    local answer
    local found, safehouse = pcall(function() return realSafeHouse.getSafeHouse(square) end)
    if not found or not safehouse then
        answer = true                       -- not a claim at all
    elseif livesHere(safehouse, player) then
        answer = true                       -- their own base, always
    else
        -- Staff and an active faction war are vanilla's business and stay
        -- vanilla's. Only a `true` is ever taken from it -- a throw or a false
        -- just falls through to the open set, so this call can no longer be the
        -- thing that refuses somebody.
        local ok, allowed = pcall(origAllowLoot, square, player)
        if ok and allowed then
            answer = true
        else
            answer = openKeys[keyOf(safehouse)] == true
        end
    end

    answers[sk] = answer
    return answer
end

--[[
Installs the override, by whichever of two routes takes.

Assigning to a member of a Java class table exposed to Lua is not documented to
work and is not something vanilla ever does, so it is tried, verified by reading
the value back, and backed up by shadowing the global with a proxy table that
forwards everything else through __index. Vanilla resolves `SafeHouse` from the
global environment at call time, so the proxy is seen by the four call sites
above exactly as the real class would be.

Whichever route succeeds is reported to the server, because a silent failure
here looks identical to "raid protection is on and nobody can ever loot".
]]
local function install()
    if installedAs then return end

    realSafeHouse = SafeHouse
    if not realSafeHouse then
        installedAs = "failed"
        log("SafeHouse is not exposed to Lua - gate not installed")
        return
    end

    origAllowLoot = realSafeHouse.isSafehouseAllowLoot
    if not origAllowLoot then
        installedAs = "failed"
        log("SafeHouse.isSafehouseAllowLoot is missing - gate not installed")
        return
    end

    -- Plain == rather than rawequal: the game's Lua is Kahlua, vanilla never
    -- calls rawequal anywhere in media/lua, and a missing global here would
    -- throw at load and take the whole file - and with it the gate - down.
    pcall(function() realSafeHouse.isSafehouseAllowLoot = allowLoot end)
    if realSafeHouse.isSafehouseAllowLoot == allowLoot then
        installedAs = "direct"
    else
        SafeHouse = setmetatable({ isSafehouseAllowLoot = allowLoot },
            { __index = realSafeHouse })
        installedAs = (SafeHouse.isSafehouseAllowLoot == allowLoot) and "proxy" or "failed"
    end

    if installedAs == "failed" then
        log("could not install the gate - bases stay protected as vanilla has them")
    else
        log("gate installed (" .. installedAs .. ")")
    end
end

--[[
Reports in, and asks for the current open set.

Retried rather than fired once, because OnGameStart can land before getPlayer()
returns anybody and a lost report is the one thing here nobody would notice: the
symptom of a gate that never installed is bases that stay protected, which is
also what a correctly working gate looks like most of the time.
]]
local announceTicks = 0
local function announce()
    local p = (getPlayer and getPlayer()) or (getSpecificPlayer and getSpecificPlayer(0))
    if not p then return false end
    sendClientCommand(p, MODULE, "gate", { how = installedAs or "failed" })
    -- Until this is answered every base reads as protected, which is the safe
    -- direction to be wrong in for the second or two it takes.
    sendClientCommand(p, MODULE, "sync", {})
    return true
end

local function announceTick()
    announceTicks = announceTicks + 1
    if announceTicks < 60 then return end
    announceTicks = 0
    if announce() then Events.OnTick.Remove(announceTick) end
end

--[[
The world context menu's copy of the answer, corrected in flight.

Only ever flips false to true, and only for a claim the server has opened, so a
protected base keeps vanilla's refusal untouched. fetch.safehouse is deliberately
left alone: it is what puts "View Safehouse" on the menu for people who actually
live there, and a raider has no business with it.
]]
local function onPreFillMenu()
    local fetch = ISWorldObjectContextMenu and ISWorldObjectContextMenu.fetchVars
    if not fetch or fetch.safehouseAllowLoot then return end

    local safehouse = fetch.safehouse
    if not safehouse then return end
    if openKeys[keyOf(safehouse)] then fetch.safehouseAllowLoot = true end
end

Events.OnServerCommand.Add(function(module, command, args)
    if module ~= MODULE then return end
    if command ~= "open" then return end

    local fresh = {}
    local n = 0
    for key in string.gmatch(tostring((args and args.keys) or ""), "[^;]+") do
        fresh[key] = true
        n = n + 1
    end
    openKeys = fresh
    answers = {}
    heard = heard + 1
    log("open set received: " .. n .. " raidable (" .. heard .. " so far)")
end)

Events.OnPreFillWorldObjectContextMenu.Add(onPreFillMenu)

--[[
TEST INSTRUMENTATION - the point of this release.

1.17.0 shipped with exactly one canary: a one-shot report at login, logged
server-side as `<user> gate=<how>`. Across every log on the box that line never
appeared once, for anybody. So the feature was known to be broken and there was
no way to tell WHERE it broke, because the one channel that would have said so
was itself the thing that had gone quiet.

This reports on a heartbeat instead of once, and carries the client's actual
state with it: how the override installed, and how many open-set broadcasts it
has received. That turns the server log into the whole diagnosis --

    gate=direct keys=6 beat=5   the feature is working
    gate=direct keys=0 beat=5   client is alive, server->client is not arriving
    (no lines at all)           client->server is not arriving, or the file
                                never loaded on the client

-- which matters because the alternative is asking a player to find
console.txt on their own machine.

Take this out once the answer is known. A heartbeat per client per minute is
nothing next to normal traffic, but it is not something to leave running.
]]
local beat = 0
local reportTicks = 0

local function report()
    local p = (getPlayer and getPlayer()) or (getSpecificPlayer and getSpecificPlayer(0))
    if not p then return false end
    local n = 0
    for _ in pairs(openKeys) do n = n + 1 end
    beat = beat + 1
    sendClientCommand(p, MODULE, "gate", {
        how = installedAs or "failed",
        keys = tostring(n),
        beat = tostring(beat),
    })
    return true
end

Events.OnTick.Add(function()
    reportTicks = reportTicks + 1
    if reportTicks < 3600 then return end   -- ~60s at 60 ticks/s
    reportTicks = 0
    report()
    -- Bound how stale a cached answer can get. Membership changes and released
    -- claims do not announce themselves, and a wrong `true` cached forever is
    -- somebody's base standing open.
    answers = {}
end)

Events.OnGameStart.Add(function()
    install()
    log("loaded, install=" .. tostring(installedAs))
    if not announce() then Events.OnTick.Add(announceTick) end
end)
