--[[
Wabbajack siege events - server side only.

WHAT IT DOES
The bot picks a house, writes it to a request file and announces the coordinates
server-wide. This mod stocks that house with loot and rings it with zombies the
moment the area streams in, then removes whatever is left once the siege is
broken.

WHY A MOD AND NOT RCON
Everything else in this toolkit drives the server over RCON, and RCON can only
act where a player already is: `addvehicle` and `createhorde2` both resolve the
target with getGridSquare and fail with "invalid location" on an unloaded chunk,
and `additem` targets a *player*, so there is no way to put loot in a building at
all. Running inside the server removes all three limits.

WHY CLIENTS DO NOT NEED THIS
It only ever places vanilla items and vanilla zombies. Nothing here defines an
item, a sprite or a recipe, so there is nothing for a client to be missing. That
keeps it out of the Workshop list and off the first-join download, which matters
on a server whose median load time is already close to the median player's
patience.

"STOCKED BEFORE THEY ARRIVE"
A server cannot load a chunk nobody is near. What it can do is act the instant
the chunk streams, which happens well before line of sight - streaming reaches
60-95 tiles while a player sees roughly 30. So the house is furnished and the
horde is standing before anyone can possibly observe either appearing. If the
area is already loaded when the event is armed (someone is nearby), it is done
immediately instead.

CLEANUP
Every zombie spawned here is tagged in its ModData. Once the horde is broken the
survivors are removed after a delay, so a siege does not leave a permanent scar -
this server runs ZombieRespawn=None and nothing else ever clears them.
]]

local REQUEST_FILE = "wabbajack_siege.txt"     -- written by the bot
local STATUS_FILE  = "wabbajack_siege_status.txt"  -- written back for the bot
local MODDATA_KEY  = "WabbajackSiege"
local TAG          = "wabbajackSiege"

-- Fraction of the horde that must be dead before the site counts as broken.
-- Not 100%: stragglers wander off, fall through the map, or end up somewhere
-- unreachable, and an event that never completes would never clean up.
local BROKEN_AT = 0.85
-- Minutes between the siege breaking and the leftovers being removed. Was 5,
-- which put ten and a half minutes between the horde landing and the site being
-- clear -- measured, not estimated, from a live run. Most of that was spent
-- watching nothing happen, so it is now short enough to feel like a conclusion
-- rather than a wait.
local CLEANUP_MINUTES = 2
--[[
Minutes from the first player setting foot in the house to the unclaimed loot
going away.

This clock is per EVENT, not per player: the first person through the door
starts it for everyone. That is deliberate -- the event has to end -- but at 5
minutes it meant somebody arriving four minutes in got sixty seconds, which is
indistinguishable from arriving to an empty house. Nine gives a latecomer a real
run at it while still ending on a schedule. The horde, not the clock, is meant
to be what stops you.
]]
local LOOT_MINUTES = 9
-- How far from the centre we look when counting or removing our zombies.
local SITE_RADIUS = 60
--[[
Hard expiry, in real minutes.

Cleanup normally waits for the horde to be broken, but nothing obliges players
to fight it: once the loot clock is running the rational play is to grab what
you can and leave, which leaves the horde at ~100% alive and, without this,
parked there forever. ZombieRespawn is None on this server and nothing else ever
clears zombies, so an event that is never completed would be a permanent scar on
the map. After this long the site is cleaned up regardless of how the fight went.
]]
local MAX_EVENT_MINUTES = 120

-- Ground clutter that sells "somebody was holed up in here". Vanilla only, and
-- deliberately worthless - it is set dressing, not part of the reward. Boarded
-- windows and corpses would say it better, but neither addBoard nor IsoDeadBody
-- construction is cleanly reachable from Lua, so this is what is actually
-- achievable server-side.
local DRESSING = {
    "Base.CigarettePack", "Base.TinCanEmpty", "Base.TinCanEmpty", "Base.Whiskey",
    "Base.Sheet", "Base.Sheet", "Base.Magazine", "Base.Matches",
    "Base.BeerCanEmpty", "Base.Bandage", "Base.Newspaper",
}

local function log(msg)
    print("[WabbajackSiege] " .. tostring(msg))
end

--[[
Whether a player counts as staff.

THE ROLE NAMES ARE LOWERCASE.
getAccessLevel() returns a name from the server's own `role` table, and that
table stores them lowercase: `admin`, `moderator`, `gm`, `observer`. This code
compared against "Admin" and "Moderator" capitalised -- which is what the
vanilla docs suggest -- so nothing ever matched: the in-game menu was invisible
to everybody including the owner, and the server refused every command that did
reach it. Comparison is lowercased now.

The custom roles on this server (`Wabbagang`, `Sheriff`) are deliberately NOT
staff. They are cosmetic player groups, and arming a siege spawns hundreds of
permanent zombies.
]]
local STAFF_ROLES = { admin = true, moderator = true, gm = true, overseer = true }

local function accessLevel(player)
    if not player or not player.getAccessLevel then return "" end
    local ok, lvl = pcall(function() return player:getAccessLevel() end)
    if not ok or not lvl then return "" end
    return string.lower(tostring(lvl))
end

local function isStaff(player)
    return STAFF_ROLES[accessLevel(player)] == true
end

local function state()
    return ModData.getOrCreate(MODDATA_KEY)
end

--[[
Real minutes elapsed since a world-age timestamp.

World age is measured in IN-GAME hours, but every timer here is expressed in
real minutes because that is what the people standing in the house experience.
This server runs 2-hour days (DayLength=5), so a full in-game day is 120 real
minutes and one in-game hour is 5 real minutes. Change REAL_MINUTES_PER_DAY if
the day length ever changes.
]]
local REAL_MINUTES_PER_DAY = 120
local function realMinutesSince(worldAgeHours)
    if not worldAgeHours then return 0 end
    local elapsedGameHours = getGameTime():getWorldAgeHours() - worldAgeHours
    return elapsedGameHours * (REAL_MINUTES_PER_DAY / 24)
end

-- ---------------------------------------------------------------- request io

--[[
Reads the bot's request file.

Format is one key=value per line rather than JSON, because the Lua sandbox has
no JSON parser and hand-rolling one for four fields is not worth the failure
modes:

    id=1723849200
    x=10745
    y=9930
    zombies=200
    loot=high
]]
--[[
"No request file" is the STEADY STATE, not a fault.

The diagnostic exists for a real reason — the first field trial failed silently
right here, with no way from outside to tell whether the poll was running, the
file was missing or the parse had failed. But logging it every minute means a
line every minute forever on a server that has no siege queued, which is most of
the time; the ten-minute heartbeat already answers "are the timers running?".
So it is logged once, and then only every thirtieth poll.
]]
local missingRequestPolls = 0

local function readRequest()
    local reader = getFileReader(REQUEST_FILE, false)
    if not reader then
        if missingRequestPolls % 30 == 0 then
            log("poll: no readable " .. REQUEST_FILE ..
                " (getFileReader returned nil) - idle, this is normal")
        end
        missingRequestPolls = missingRequestPolls + 1
        return nil
    end
    missingRequestPolls = 0
    local req = {}
    local line = reader:readLine()
    while line do
        local k, v = string.match(line, "^%s*([%w_]+)%s*=%s*(.-)%s*$")
        if k then req[k] = v end
        line = reader:readLine()
    end
    reader:close()
    -- A cancel carries an id and nothing else: there is no location to cancel
    -- AT, only the event that is currently running.
    req.cancel = (req.cancel == "1" or req.cancel == "true")
    if req.cancel then
        if not req.id then return nil end
        return req
    end
    if not req.id or not req.x or not req.y then
        log("poll: " .. REQUEST_FILE .. " read but missing id/x/y — got "
            .. tostring(req.id) .. "/" .. tostring(req.x) .. "/" .. tostring(req.y))
        return nil
    end
    req.x = tonumber(req.x); req.y = tonumber(req.y)
    req.z = tonumber(req.z or "0") or 0
    req.zombies = tonumber(req.zombies or "200") or 200
    req.loot = req.loot or "standard"
    -- A silent event places loot and zombies with no announcement at all, so
    -- players find it rather than race to it.
    req.silent = (req.silent == "1" or req.silent == "true")
    if not req.x or not req.y then return nil end
    return req
end

--- Reports progress back so the bot can announce without polling the game.
local function writeStatus(st)
    local w = getFileWriter(STATUS_FILE, true, false)
    if not w then return end
    w:write("id=" .. tostring(st.id or "") .. "\n")
    w:write("phase=" .. tostring(st.phase or "") .. "\n")
    w:write("spawned=" .. tostring(st.spawned or 0) .. "\n")
    w:write("alive=" .. tostring(st.alive or 0) .. "\n")
    w:write("x=" .. tostring(st.x or 0) .. "\n")
    w:write("y=" .. tostring(st.y or 0) .. "\n")
    w:write("silent=" .. (st.silent and "1" or "0") .. "\n")
    w:close()
end

-- -------------------------------------------------------------------- loot

-- Vanilla item ids only. Anything modded here would make the mod a client
-- dependency, which is the one thing this design avoids.
--
-- Every id below is checked against media/scripts. This matters more than it
-- looks: container:AddItem() on an unknown id returns nil and adds NOTHING, with
-- no error. Four ids in the first draft were B41 names that B42 renamed
-- (CannedBeans, WaterBottleFull, Cigarettes, EmptyCan) and would have quietly
-- delivered an emptier house than advertised.
local LOOT = {
    standard = {
        "Base.Axe", "Base.HuntingKnife", "Base.Bandage", "Base.Bandage",
        "Base.TinnedBeans", "Base.TinnedBeans", "Base.WaterBottle",
        "Base.Screwdriver", "Base.Hammer", "Base.SheetRope",
    },
    high = {
        "Base.Axe", "Base.Machete", "Base.Shotgun", "Base.ShotgunShells",
        "Base.ShotgunShells", "Base.Pistol", "Base.Bullets9mmBox",
        "Base.FirstAidKit", "Base.Bandage", "Base.Bandage", "Base.Antibiotics",
        "Base.TinnedBeans", "Base.TinnedBeans", "Base.WaterBottle",
        "Base.Generator", "Base.PetrolCan", "Base.Screwdriver", "Base.Hammer",
    },
}

--[[
Modded firearms, appended to the high tier when their mod is present.

Guns are paired with a MAGAZINE rather than loose rounds. In B42 a firearm needs
a magazine loaded before it fires, and the mods' own AmmoType references
(`marzguns:bullet_45` and similar) do not resolve to a runtime fulltype the way
the magazines do -- so a gun plus loose bullets would hand somebody a weapon they
cannot actually use.

Every id here was taken from the save's own WorldDictionary, which lists the
exact runtime fulltype and owning mod for all 9,005 items the world knows. That
is the authoritative source; guessing from script files is how the vanilla list
ended up with four B41 names in it.

Availability is tested by asking the script manager whether the ITEM exists,
not by checking whether a mod is loaded. Two reasons: getActivatedMods() is
client-only (its only vanilla callers are in media/lua/client, and calling it
here would throw), and testing the item is the thing we actually care about — a
mod can be present but have renamed the entry.
]]
local MODDED_HIGH = {
    { "MarzGuns.M1911",    "MarzGuns.45Magazine7_M1911" },
    { "MarzGuns.USP",      "MarzGuns.45Magazine12_USP" },
    { "MarzGuns.PYTHON",   "MarzGuns.357SpeedLoader6_PYTHON" },
    { "MarzGuns.MAC10",    "MarzGuns.45Magazine30_MAC10" },
    { "MarzGuns.THOMPSON", "MarzGuns.45Magazine100_THOMPSON" },
    { "MarzGuns.SVD",      "MarzGuns.762x54Magazine10_SVD" },
    { "MarzGuns.AA12",     "MarzGuns.12GMagazine20_AA12" },
}

--- True when the server actually has a script for this item id.
local function itemExists(id)
    local ok, script = pcall(function() return getScriptManager():getItem(id) end)
    return ok and script ~= nil
end

--- One random modded gun-and-magazine set whose items are actually present.
local function moddedBonus()
    local avail = {}
    for _, set in ipairs(MODDED_HIGH) do
        local all = true
        for _, id in ipairs(set) do
            if not itemExists(id) then all = false; break end
        end
        if all then table.insert(avail, set) end
    end
    if #avail == 0 then
        log("no modded firearm sets available - high tier is vanilla only")
        return {}
    end
    local pick = avail[ZombRand(#avail) + 1]
    log("modded bonus: " .. pick[1] .. " + " .. pick[2])
    return pick
end

--[[
Every square inside the building that owns `square`.

THE ROOMDEF / ISOROOM DISTINCTION IS NOT COSMETIC
`BuildingDef:getRooms()` returns RoomDef, which is map *metadata* — a rectangle
on the grid that exists whether or not the area is loaded — and a RoomDef has no
squares of its own. The squares hang off the streamed IsoRoom, reached with
`RoomDef:getIsoRoom()`. Calling getSquares() straight on the RoomDef threw

    java.lang.RuntimeException: Object tried to call nil in squaresInBuilding

every minute in production, out of tick -> fire -> stockBuilding, which meant the
siege aborted *before* ringWithZombies and no event ever left phase=armed. The
feature had never once worked. Verified against the shipped classes:
BuildingDef.getRooms()->ArrayList<RoomDef>, RoomDef has getIsoRoom() and no
getSquares(), IsoRoom.getSquares()->ArrayList<IsoGridSquare>.

getIsoRoom() is nil for a room that is not streamed, so it is checked rather
than assumed: fire() only runs on a loaded site, but a large building can
straddle the edge of what is loaded.
]]
local function squaresInBuilding(square)
    local out = {}
    local building = square and square:getBuilding()
    if not building then return out end
    local def = building:getDef()
    if not def then return out end
    local rooms = def:getRooms()
    if not rooms then return out end
    for i = 0, rooms:size() - 1 do
        local roomDef = rooms:get(i)
        local room = roomDef and roomDef:getIsoRoom()
        local squares = room and room:getSquares()
        if squares then
            for j = 0, squares:size() - 1 do
                local sq = squares:get(j)
                if sq then table.insert(out, sq) end
            end
        end
    end
    return out
end

--[[
Every container inside the building, PAIRED WITH ITS OWNING OBJECT.

The object is not incidental. A container modified server-side does not reach
players on its own: the client already holds whatever contents it was sent when
the chunk streamed, and nothing re-sends them. So the server stocked a house
with fifty items, logged that it had, and every player opened the same empty
cupboards they were sent a moment earlier -- which is precisely the "containers
are not spawning loot" being reported while the log said otherwise.

`IsoObject:transmitCompleteItemToClients()` is the fix and is what vanilla does
after every server-side container change (ISTransferAction, ISBarricadeAction
and friends all call it, guarded by isServer()). It is on the OBJECT, not the
container, hence carrying both here.

The same class of bug was already known for ground items -- stripBuilding uses
transmitRemoveItemFromSquare for exactly this reason -- just never applied to
containers.
]]
local function containersInBuilding(square)
    local out = {}
    for _, sq in ipairs(squaresInBuilding(square)) do
        local objs = sq:getObjects()
        if objs then
            for k = 0, objs:size() - 1 do
                local o = objs:get(k)
                local c = o and o.getContainer and o:getContainer()
                if c then table.insert(out, { c = c, o = o }) end
            end
        end
    end
    return out
end

--- Pushes a server-side container change out to every client.
local function transmit(entry)
    if entry and entry.o and entry.o.transmitCompleteItemToClients then
        pcall(function() entry.o:transmitCompleteItemToClients() end)
    end
end

--[[
Strips the house bare - every container and every loose item on the floor.

Deliberately total rather than only removing what this mod placed. The point of
the timer is that the house empties, so leaving the building's own original
contents behind would undercut it, and tracking provenance item by item would be
fragile for no benefit. Anything a player already picked up is in their
inventory and is untouched - this only takes what nobody claimed.

Ground items go through transmitRemoveItemFromSquare so clients see them
disappear; removing them locally would leave ghosts on every other player's
screen.
]]
local function stripBuilding(square)
    local containers, ground = 0, 0
    for _, sq in ipairs(squaresInBuilding(square)) do
        local objs = sq:getObjects()
        if objs then
            for k = 0, objs:size() - 1 do
                local o = objs:get(k)
                local c = o and o.getContainer and o:getContainer()
                if c then
                    c:clear()
                    -- Same reason the ground items below are transmitted: a
                    -- silent clear leaves every client showing the old contents.
                    if o.transmitCompleteItemToClients then
                        pcall(function() o:transmitCompleteItemToClients() end)
                    end
                    containers = containers + 1
                end
            end
        end
        local world = sq:getWorldObjects()
        if world then
            for k = world:size() - 1, 0, -1 do
                local item = world:get(k)
                if item then
                    sq:transmitRemoveItemFromSquare(item)
                    sq:removeWorldObject(item)
                    ground = ground + 1
                end
            end
        end
    end
    log("stripped " .. containers .. " containers and " .. ground .. " ground items")
    return containers, ground
end

--[[
Whether the target building is under a player claim.

Checked here as well as in the bot, because the two are minutes apart and this
server lets players claim ANY building: the bot confirms the house is unclaimed
when it arms the event, and somebody can walk up and claim it before the loot
timer expires. Stripping every container in a claim would be that player losing
everything to an event they never opted into, so the strip and the spawn both
defer to a claim made in the meantime.
]]
local function isClaimed(square)
    if not square or not SafeHouse then return false end
    -- nil username, true = "is this claimed by anyone at all", matching the
    -- vanilla callers.
    local ok, claimed = pcall(function()
        return SafeHouse.getSafeHouse(square) ~= nil
            or SafeHouse.isSafeHouse(square, nil, true)
    end)
    return ok and claimed or false
end

--- True when any live player is standing inside the building.
local function playerInBuilding(square)
    local building = square and square:getBuilding()
    if not building then return false end
    local players = getOnlinePlayers()
    if not players then return false end
    for i = 0, players:size() - 1 do
        local p = players:get(i)
        local sq = p and not p:isDead() and p:getSquare()
        if sq and sq:getBuilding() == building then return true end
    end
    return false
end

-- Share of the building's containers that end up holding something.
local FILL_FRACTION = 0.6
local MIN_PER_CONTAINER, MAX_PER_CONTAINER = 1, 3

--[[
REPLACES the building's contents with the loot tier.

The first version added the tier list to random containers and left everything
else alone. In production that read as "the loot did not spawn", and the log
says exactly why: `stocked 20 items across 79 containers`. Twenty items over
seventy-nine containers means three in four you open hold nothing new and the
rest hold the house's original junk, so a player gives up long before finding
the shotgun. It was working perfectly and delivering nothing.

So now the house is emptied first and restocked properly. Two rules:

  - every entry in the tier list lands at least once, so the headline pieces
    (the shotgun, the generator, the first aid kit) are guaranteed rather than
    left to the dice;
  - then it tops up to FILL_FRACTION of the containers, drawing from the tier
    list with repeats, so a big house is actually full rather than proportionally
    emptier than a small one.
]]
local function stockBuilding(square, tier)
    local items = LOOT[tier] or LOOT.standard
    if tier == "high" then
        -- Copy, so the bonus is not appended to the shared table every event.
        local merged = {}
        for _, id in ipairs(items) do table.insert(merged, id) end
        for _, id in ipairs(moddedBonus()) do table.insert(merged, id) end
        items = merged
    end

    -- Empty it first. This is the "replace the contents" half, and it is what
    -- makes the restock legible.
    local cleared = stripBuilding(square)

    local containers = containersInBuilding(square)
    if #containers == 0 then
        -- No building, or a building with no furniture. Drop it on the floor
        -- rather than silently delivering nothing.
        for _, id in ipairs(items) do square:AddWorldInventoryItem(id, 0, 0, 0) end
        log("no containers found - dropped " .. #items .. " items on the ground")
        return #items
    end
    local touched = {}

    -- Shuffle, so the filled containers are spread through the house instead of
    -- clustering in whichever room happened to enumerate first.
    for i = #containers, 2, -1 do
        local j = ZombRand(i) + 1
        containers[i], containers[j] = containers[j], containers[i]
    end

    local total = 0
    for idx, id in ipairs(items) do
        local e = containers[((idx - 1) % #containers) + 1]
        if e.c:AddItem(id) then total = total + 1; touched[e] = true end
    end

    local fill = math.max(1, math.floor(#containers * FILL_FRACTION))
    for i = 1, math.min(fill, #containers) do
        local n = MIN_PER_CONTAINER + ZombRand(MAX_PER_CONTAINER - MIN_PER_CONTAINER + 1)
        for _ = 1, n do
            local id = items[ZombRand(#items) + 1]
            if containers[i].c:AddItem(id) then total = total + 1; touched[containers[i]] = true end
        end
    end

    -- Tell every client what just changed. Without this the house is stocked
    -- only as far as the server is concerned.
    local sent = 0
    for e, _ in pairs(touched) do transmit(e); sent = sent + 1 end

    -- Set dressing on the floor, so it reads as a place somebody lived in
    -- rather than a house that happens to have a shotgun in a wardrobe.
    local squares = squaresInBuilding(square)
    if #squares > 0 then
        for _, id in ipairs(DRESSING) do
            squares[ZombRand(#squares) + 1]:AddWorldInventoryItem(id, 0, 0, 0)
        end
    end

    log("cleared " .. cleared .. " containers, then stocked " .. total ..
        " items across " .. math.min(fill, #containers) .. "/" .. #containers ..
        " containers (" .. sent .. " transmitted), " .. #DRESSING ..
        " pieces of dressing")
    return total
end

-- ----------------------------------------------------------------- zombies

--[[
Rings the site with zombies.

Placed in a band rather than on the building so they read as having converged on
it, and so nobody spawns inside the walls with the loot. Each one is tagged in
ModData; that tag is the only way to tell our zombies from the world's when it
comes time to clean up, and it survives a server restart because zombie ModData
is persisted with the chunk.
]]
-- Band the horde lands in, and how many positions each zombie may try.
--
-- A live run placed 124 of 200: a single attempt per zombie, on a ring 12-28
-- tiles out, crosses the edge of what is streamed often enough that a third of
-- the horde simply never appeared, and the siege was quietly two-thirds the
-- size it advertised. Retrying with a fresh angle costs nothing -- the failure
-- is a nil square, not an exception -- and the band is pulled in slightly so
-- more of it lands inside loaded chunks.
local RING_NEAR, RING_FAR = 10, 26
local PLACE_ATTEMPTS = 6

local function ringWithZombies(cx, cy, cz, count, eventId)
    local placed = 0
    local cell = getCell()
    if not cell then log("no cell - placed 0 zombies"); return 0 end
    for _ = 1, count do
      for _ = 1, PLACE_ATTEMPTS do
        local ang = ZombRandFloat(0, 6.2831853)
        local dist = ZombRandFloat(RING_NEAR, RING_FAR)
        local x = math.floor(cx + math.cos(ang) * dist)
        local y = math.floor(cy + math.sin(ang) * dist)
        local sq = cell:getGridSquare(x, y, cz)
        if sq then
            -- One at a time so each can be tagged; a batch gives no handle on
            -- what it created. Note this returns a LIST, not a zombie - vanilla
            -- callers all do `addZombiesInOutfit(...):get(0)`.
            local list = addZombiesInOutfit(x, y, cz, 1, nil, 50)
            local z = list and list:size() > 0 and list:get(0) or nil
            if z then
                local md = z.getModData and z:getModData()
                if md then md[TAG] = eventId end
                placed = placed + 1
            end
            break   -- the square existed; a failed spawn is not worth retrying
        end
      end
    end
    log("placed " .. placed .. "/" .. count .. " zombies")
    return placed
end

--[[
Tells clients to draw the site on their map, the way the airdrop mod does.

Two markers, both client-side: a blinking circle on the world map via
markersAPI:addGridSquareMarker, and an on-screen direction arrow via
getWorldMarkers():addDirectionArrow. The server only sends coordinates; all the
UI lives in the client file, because none of those APIs exist server-side.

A SILENT siege gets no marker. The whole point of silent is that players find
it, and a blinking ring on everyone's map is the loudest possible announcement.
]]
local MARKER_RADIUS = 30

local function markerStart(ev)
    if ev.silent then return end
    pcall(function()
        sendServerCommand("WabbajackSiege", "markerStart", {
            id = tostring(ev.id), x = ev.x, y = ev.y, z = ev.z, radius = MARKER_RADIUS,
        })
    end)
end

local function markerStop(ev)
    pcall(function()
        sendServerCommand("WabbajackSiege", "markerStop", { id = tostring(ev.id) })
    end)
end

--[[
Optionally drops an airdrop crate on the site.

Guarded rather than declared in mod.info. AirdropMod is a third-party mod we do
not control: a hard dependency would take the siege down with it the day it is
unsubscribed, renamed, or restructured, and it would force every client to carry
both. If the function is not there, this is simply a siege.

Loot level 4 is the top of AirdropMod's own scale (Config.LootLevelMin 1,
LootLevelMax 4, default 2), passed as forcedLootLevel so the crate matches the
tier of the house rather than the server default.
]]
local AIRDROP_LOOT_LEVEL = 4
local AIRDROP_MINUTES = 30

local function callAirdrop(ev, sq)
    if ev.loot ~= "high" then return false end
    if not Airdrop_ServerSpawner then pcall(require, "Airdrop_ServerSpawner") end
    local spawner = Airdrop_ServerSpawner
    if not spawner or not spawner.spawnAtSquare then
        log("airdrop skipped - AirdropMod is not loaded on this server")
        return false
    end
    local now = (getTimestampMs and getTimestampMs()) or (getTimestamp() * 1000)
    local ok, err = pcall(spawner.spawnAtSquare, sq, "siege-" .. tostring(ev.id),
        now, now + AIRDROP_MINUTES * 60 * 1000, nil, nil, AIRDROP_LOOT_LEVEL)
    if ok then
        log("airdrop requested at " .. ev.x .. "," .. ev.y .. " (loot level " ..
            AIRDROP_LOOT_LEVEL .. ")")
        return true
    end
    log("airdrop call failed: " .. tostring(err))
    return false
end

--[[
Counts (and optionally removes) the zombies belonging to this event.

Takes no coordinates because it does not filter by them: the cell zombie list
only ever holds what is currently streamed, so the tag is the whole selector and
SITE_RADIUS never applied here. That is worth stating plainly, because it is
also the trap — see siteLoaded() below. An earlier signature took cx/cy/cz and
ignored them, which read as if a radius were being enforced.
]]
local function sweepZombies(eventId, remove)
    local n = 0
    local cell = getCell()
    if not cell then return 0 end
    local zlist = cell:getZombieList()
    if not zlist then return 0 end
    for i = zlist:size() - 1, 0, -1 do
        local z = zlist:get(i)
        local md = z and z.getModData and z:getModData()
        if md and md[TAG] == eventId then
            if remove then
                z:removeFromWorld()
                z:removeFromSquare()
            end
            n = n + 1
        end
    end
    return n
end

--- Whether the event site is currently streamed, i.e. whether we can see it.
local function siteLoaded(ev)
    return (getCell() and getCell():getGridSquare(ev.x, ev.y, ev.z)) ~= nil
end

--[[
Ends an event and makes sure its zombies do not outlive it.

Every exit from an event goes through here, because the naive version of this
leaks a permanent horde. sweepZombies can only remove what is loaded, so
"cleanup" run while nobody is near the site removes nothing at all — and if the
event is marked done at that moment its tag is never looked for again. With
ZombieRespawn=None and no RCON command that removes zombies, those spawns then
stand there for the rest of the wipe.

So an event that cannot be fully cleaned is not forgotten, it is parked in
st.pending and retried once a minute. That also makes superseding an event safe,
which is what lets a new siege replace one that is stuck.
]]
--[[
Clears the site: the building's containers, and loose items just outside it.

Cancelling used to remove the zombies and leave the stocked house standing,
which is the worst of both -- the danger gone, the reward still there for the
taking. An event that is over should leave nothing behind, so every exit clears
the site, not just the loot timer.

Two guards. A claimed building is never touched, because somebody may have
claimed the house since the event was armed and stripping every container in a
claim is that player losing everything to an event they never opted into. And
the outdoor sweep is skipped entirely if the claim list cannot be read, rather
than sweeping blind next to somebody's base.
]]
local SITE_LITTER_RADIUS = 12

local function claimRects()
    local out = {}
    local ok = pcall(function()
        local list = SafeHouse and SafeHouse.getSafehouseList and SafeHouse.getSafehouseList()
        if not list then return end
        for i = 0, list:size() - 1 do
            local sh = list:get(i)
            table.insert(out, { x = sh:getX(), y = sh:getY(), w = sh:getW(), h = sh:getH() })
        end
    end)
    if not ok then return nil end
    return out
end

local function inAnyClaim(rects, x, y)
    for _, r in ipairs(rects) do
        if x >= r.x and x <= r.x + r.w and y >= r.y and y <= r.y + r.h then return true end
    end
    return false
end

local function stripSite(ev)
    local cell = getCell()
    if not cell then return end
    local sq = cell:getGridSquare(ev.x, ev.y, ev.z)
    if not sq then return end                 -- not streamed; nothing reachable
    if isClaimed(sq) then
        log("event " .. tostring(ev.id) .. " site left alone - the house is claimed")
        return
    end

    stripBuilding(sq)

    local rects = claimRects()
    if not rects then
        log("event " .. tostring(ev.id) .. " outdoor sweep skipped - claim list unreadable")
        return
    end
    local ground = 0
    for x = ev.x - SITE_LITTER_RADIUS, ev.x + SITE_LITTER_RADIUS do
        for y = ev.y - SITE_LITTER_RADIUS, ev.y + SITE_LITTER_RADIUS do
            if not inAnyClaim(rects, x, y) then
                local s2 = cell:getGridSquare(x, y, ev.z)
                local world = s2 and s2:getWorldObjects()
                if world and world:size() > 0 then
                    for i = world:size() - 1, 0, -1 do
                        local item = world:get(i)
                        if item then
                            s2:transmitRemoveItemFromSquare(item)
                            s2:removeWorldObject(item)
                            ground = ground + 1
                        end
                    end
                end
            end
        end
    end
    log("event " .. tostring(ev.id) .. " site cleared - " .. ground ..
        " loose items within " .. SITE_LITTER_RADIUS .. " tiles")
end

local function retire(st, ev, reason)
    markerStop(ev)
    stripSite(ev)
    local removed = sweepZombies(ev.id, true)
    st.done = st.done or {}
    st.done[ev.id] = true
    -- Keyed by id rather than an array, so this stays a plain string-keyed
    -- table in ModData and never depends on array-length semantics there.
    st.pending = st.pending or {}
    st.pending[tostring(ev.id)] = { id = ev.id, x = ev.x, y = ev.y, z = ev.z }
    st.current = nil
    ev.phase = "done"
    ev.alive = 0
    writeStatus(ev)
    log("event " .. tostring(ev.id) .. " retired (" .. tostring(reason) ..
        ") - removed " .. removed .. " zombies now, rest cleared as the area loads")
    return removed
end

--- Retries cleanup for events that ended while their site was not streamed.
local function sweepPending(st)
    if not st.pending then return end
    for key, p in pairs(st.pending) do
        -- Only judge a site we can actually see. An empty result on an unloaded
        -- site means "cannot tell", not "nothing left".
        if (getCell() and getCell():getGridSquare(p.x, p.y, p.z)) then
            local removed = sweepZombies(p.id, true)
            if removed > 0 then
                log("pending cleanup: removed " .. removed ..
                    " leftover zombies from event " .. tostring(p.id))
            else
                st.pending[key] = nil
                log("pending cleanup finished for event " .. tostring(p.id))
            end
        end
    end
end

-- ------------------------------------------------------------------- arming

--- Places loot and zombies. Safe to call only once per event.
local function fire(ev)
    local sq = getCell() and getCell():getGridSquare(ev.x, ev.y, ev.z)
    if not sq then
        -- Expected until somebody walks near. Logged because "armed but never
        -- fired" and "never armed" look identical from outside otherwise.
        log("event " .. ev.id .. " waiting: " .. ev.x .. "," .. ev.y
            .. " is not streamed yet")
        return false
    end
    -- Somebody may have claimed the house between the bot arming this and the
    -- area streaming in. Abandon rather than besiege a player's base.
    if isClaimed(sq) then
        -- Retire rather than just relabel: this left st.current pinned to a
        -- finished event, so the id was never recorded in st.done and nothing
        -- could arm again cleanly.
        ev.abandoned = true
        -- state() rather than a threaded-in handle: fire() is called from
        -- poll(), tick() and the menu handler, and ModData.getOrCreate returns
        -- the same table to all three.
        retire(state(), ev, "house claimed since it was armed")
        return true
    end
    stockBuilding(sq, ev.loot)
    ev.spawned = ringWithZombies(ev.x, ev.y, ev.z, ev.zombies, ev.id)
    callAirdrop(ev, sq)
    markerStart(ev)
    ev.phase = "active"
    ev.firedAt = getGameTime():getWorldAgeHours()
    writeStatus(ev)
    log("event " .. ev.id .. " live at " .. ev.x .. "," .. ev.y)
    return true
end

--- Picks up a new request from the bot.
local function poll()
    local st = state()
    local req = readRequest()
    if not req then return end
    if st.current and st.current.id == req.id then return end   -- already known
    if st.done and st.done[req.id] then
        log("poll: request " .. tostring(req.id) .. " already ran — ignoring")
        return
    end

    -- Cancel from Discord. The in-game menu can only cancel what you are
    -- standing next to; a silent siege is by definition one nobody has been
    -- told the location of, so this is the only way to call one off.
    if req.cancel then
        st.done = st.done or {}
        st.done[req.id] = true
        if st.current then
            retire(st, st.current, "cancelled from Discord")
        else
            log("cancel request " .. tostring(req.id) .. " - no siege was running")
        end
        return
    end
    -- A new request while one is in flight used to overwrite st.current
    -- outright. The old event's zombies are tagged with ITS id, and nothing
    -- ever looks for that id again once it is dropped, so every one of them
    -- became permanent. Retire it properly instead; the bot also refuses to
    -- arm over a siege that is genuinely under way, so reaching this normally
    -- means replacing one that is stuck.
    if st.current then
        retire(st, st.current, "superseded by request " .. tostring(req.id))
    end

    st.current = {
        id = req.id, x = req.x, y = req.y, z = req.z,
        zombies = req.zombies, loot = req.loot, silent = req.silent,
        phase = "armed", spawned = 0,
    }
    log("armed event " .. req.id .. " at " .. req.x .. "," .. req.y)
    writeStatus(st.current)
    -- If somebody is already nearby the area is loaded, so do it now rather
    -- than waiting for a LoadGridsquare that will never come.
    fire(st.current)
end

-- ------------------------------------------------------------------- ticking

--- Watches an active siege and cleans up once it is broken.
local function tick()
    local st = state()
    -- Before anything else, and regardless of whether an event is running:
    -- leftovers from an event that ended out of sight are the one thing here
    -- that becomes permanent if it is not retried.
    sweepPending(st)

    local ev = st.current
    if not ev then return end

    if ev.phase == "armed" then
        fire(ev)                              -- retry until the area streams in
        return
    end

    if ev.phase == "active" or ev.phase == "broken" then
        local sq = getCell() and getCell():getGridSquare(ev.x, ev.y, ev.z)

        -- Loot clock: starts the moment somebody sets foot inside, and runs
        -- independently of the horde. Two separate timers on purpose - the loot
        -- going away is the pressure, the zombies going away is the cleanup.
        if sq and not ev.enteredAt and playerInBuilding(sq) then
            ev.enteredAt = getGameTime():getWorldAgeHours()
            log("event " .. ev.id .. " entered - loot clears in " .. LOOT_MINUTES .. " min")
            writeStatus(ev)
        end
        if sq and ev.enteredAt and not ev.looted
           and realMinutesSince(ev.enteredAt) >= LOOT_MINUTES then
            if isClaimed(sq) then
                -- Claimed since the event started. Their base, their contents -
                -- leave it entirely alone.
                log("event " .. ev.id .. " loot NOT cleared - house is now claimed")
            else
                stripBuilding(sq)
                log("event " .. ev.id .. " loot cleared")
            end
            ev.looted = true
            writeStatus(ev)
        end

        -- Hard expiry. Nothing forces players to fight the horde, so without
        -- this a looted-and-abandoned site leaves its zombies standing forever.
        if realMinutesSince(ev.firedAt) >= MAX_EVENT_MINUTES then
            ev.expired = true
            retire(st, ev, "expired after " .. MAX_EVENT_MINUTES .. " min")
            return
        end
    end

    if ev.phase == "active" then
        --[[
        Only judge the fight while the site is streamed.

        The cell zombie list holds loaded zombies only, so once the last player
        walks away every tagged zombie vanishes from it and the horde reads as
        100% dead. Without this guard the event declared itself broken the
        moment it was abandoned, removed nothing (there was nothing loaded to
        remove) and then marked itself done — which retired the tag and left the
        entire horde standing there permanently. Exactly the outcome the
        cleanup exists to prevent, reached by the cleanup itself.
        ]]
        if not siteLoaded(ev) then return end
        local alive = sweepZombies(ev.id, false)
        ev.alive = alive
        writeStatus(ev)
        local killed = (ev.spawned or 0) - alive
        if ev.spawned > 0 and killed >= ev.spawned * BROKEN_AT then
            ev.phase = "broken"
            ev.brokenAt = getGameTime():getWorldAgeHours()
            log("event " .. ev.id .. " broken - cleanup in " .. CLEANUP_MINUTES .. " min")
            writeStatus(ev)
        end
        return
    end

    if ev.phase == "broken" then
        if realMinutesSince(ev.brokenAt) >= CLEANUP_MINUTES then
            retire(st, ev, "horde broken")
        end
    end
end

-- ------------------------------------------------------------------- events

--- Fires the moment the area streams in, which is before anyone can see it.
local function onLoadGridsquare(square)
    local st = state()
    local ev = st.current
    if not ev or ev.phase ~= "armed" then return end
    if not square then return end
    local dx = square:getX() - ev.x
    local dy = square:getY() - ev.y
    if dx * dx + dy * dy > SITE_RADIUS * SITE_RADIUS then return end
    fire(ev)
end

--[[
The in-game admin menu's channel.

Second way in, alongside the bot's request file. The menu is the natural one
when you are already standing in the building you want; the file is the natural
one from Discord, and is also the fallback if this channel ever proves
unreliable on a dedicated server.

Access is re-checked HERE, not trusted from the client. The menu hides itself
from non-staff, but hiding a menu is not a permission check — a modified client
can send whatever it likes, and arming a siege spawns hundreds of permanent
zombies.
]]
local function onClientCommand(module, command, player, args)
    if module ~= "WabbajackSiege" then return end
    if not player then return end

    if not isStaff(player) then
        log("refused " .. tostring(command) .. " from " ..
            tostring(player:getUsername()) .. " (access=" .. accessLevel(player) .. ")")
        return
    end

    local st = state()

    if command == "cancel" then
        local ev = st.current
        if not ev then player:Say("No siege is running.") return end
        local removed = retire(st, ev, "cancelled by " .. tostring(player:getUsername()))
        player:Say("Siege cancelled, " .. removed .. " zombies removed.")
        return
    end

    -- Ground-item sweep. Counting is harmless; removing is not, so the two are
    -- separate commands rather than a flag, and the count is what the menu
    -- offers first.
    if command == "sweepCount" then
        local n, sq = WabbajackSweep_start(false, player:getUsername())
        player:Say(n .. " loose items on " .. sq .. " squares nearby would be removed.")
        return
    end
    if command == "sweepStart" then
        local n, sq = WabbajackSweep_start(true, player:getUsername())
        player:Say("Sweep armed. " .. n .. " removed nearby; the rest clears as areas load.")
        return
    end
    if command == "sweepStop" then
        local n = WabbajackSweep_stop()
        player:Say("Sweep stopped. " .. n .. " items removed in total.")
        return
    end

    if command ~= "arm" or not args then return end
    local x, y, z = tonumber(args.x), tonumber(args.y), tonumber(args.z or 0) or 0
    if not x or not y then return end

    local sq = getCell() and getCell():getGridSquare(x, y, z)
    -- Same guard the bot applies before arming: never a claimed building.
    if sq and isClaimed(sq) then
        player:Say("That building is claimed — pick somewhere else.")
        log("refused arm at " .. x .. "," .. y .. " - claimed")
        return
    end

    st.current = {
        id = tostring(getTimestamp()) .. "-" .. tostring(ZombRand(1000)),
        x = x, y = y, z = z,
        zombies = math.min(tonumber(args.zombies) or 200, 500),
        loot = args.loot == "standard" and "standard" or "high",
        silent = args.silent == "1",
        phase = "armed", spawned = 0,
    }
    log("armed via menu by " .. tostring(player:getUsername()) ..
        " at " .. x .. "," .. y)
    writeStatus(st.current)
    fire(st.current)
    player:Say("Siege armed here.")
end

--[[
Heartbeat.

Ten minutes apart, so it is not spam, but present so that "the mod is loaded"
and "the mod's timers are running" stop being the same unverified claim. The
first field trial could not distinguish them.
]]
Events.EveryTenMinutes.Add(function()
    local st = state()
    local ev = st.current
    log("heartbeat: " .. (ev and ("event " .. tostring(ev.id) .. " phase=" ..
        tostring(ev.phase) .. " spawned=" .. tostring(ev.spawned or 0)) or "idle"))
end)

Events.OnClientCommand.Add(onClientCommand)
Events.EveryOneMinute.Add(poll)
Events.EveryOneMinute.Add(tick)
Events.LoadGridsquare.Add(onLoadGridsquare)

log("loaded")
