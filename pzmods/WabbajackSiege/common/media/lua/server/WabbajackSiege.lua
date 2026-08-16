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
-- Minutes between the siege breaking and the leftovers being removed. Long
-- enough that players are not watching bodies wink out around them.
local CLEANUP_MINUTES = 5
-- Minutes from the first player setting foot in the house to the unclaimed loot
-- going away. This is the whole tension of the event: the horde is still on you
-- and the clock is running, so you cannot calmly clear the building first.
local LOOT_MINUTES = 5
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
    "Base.Cigarettes", "Base.EmptyCan", "Base.EmptyCan", "Base.Whiskey",
    "Base.Sheet", "Base.Sheet", "Base.Magazine", "Base.Matches",
    "Base.BeerCanEmpty", "Base.Bandage", "Base.Newspaper",
}

local function log(msg)
    print("[WabbajackSiege] " .. tostring(msg))
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
local function readRequest()
    local reader = getFileReader(REQUEST_FILE, false)
    if not reader then return nil end
    local req = {}
    local line = reader:readLine()
    while line do
        local k, v = string.match(line, "^%s*([%w_]+)%s*=%s*(.-)%s*$")
        if k then req[k] = v end
        line = reader:readLine()
    end
    reader:close()
    if not req.id or not req.x or not req.y then return nil end
    req.x = tonumber(req.x); req.y = tonumber(req.y)
    req.z = tonumber(req.z or "0") or 0
    req.zombies = tonumber(req.zombies or "200") or 200
    req.loot = req.loot or "standard"
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
    w:close()
end

-- -------------------------------------------------------------------- loot

-- Vanilla item ids only. Anything modded here would make the mod a client
-- dependency, which is the one thing this design avoids.
local LOOT = {
    standard = {
        "Base.Axe", "Base.HuntingKnife", "Base.Bandage", "Base.Bandage",
        "Base.CannedBeans", "Base.CannedBeans", "Base.WaterBottleFull",
        "Base.Screwdriver", "Base.Hammer", "Base.SheetRope",
    },
    high = {
        "Base.Axe", "Base.Machete", "Base.Shotgun", "Base.ShotgunShells",
        "Base.ShotgunShells", "Base.Pistol", "Base.Bullets9mmBox",
        "Base.FirstAidKit", "Base.Bandage", "Base.Bandage", "Base.Antibiotics",
        "Base.CannedBeans", "Base.CannedBeans", "Base.WaterBottleFull",
        "Base.Generator", "Base.PetrolCan", "Base.Screwdriver", "Base.Hammer",
    },
}

--- Every square inside the building that owns `square`.
local function squaresInBuilding(square)
    local out = {}
    local building = square and square:getBuilding()
    if not building then return out end
    local def = building:getDef()
    if not def then return out end
    local rooms = def:getRooms()
    if not rooms then return out end
    for i = 0, rooms:size() - 1 do
        local squares = rooms:get(i):getSquares()
        if squares then
            for j = 0, squares:size() - 1 do
                local sq = squares:get(j)
                if sq then table.insert(out, sq) end
            end
        end
    end
    return out
end

--- Every container inside the building that owns `square`.
local function containersInBuilding(square)
    local out = {}
    for _, sq in ipairs(squaresInBuilding(square)) do
        local objs = sq:getObjects()
        if objs then
            for k = 0, objs:size() - 1 do
                local o = objs:get(k)
                local c = o and o.getContainer and o:getContainer()
                if c then table.insert(out, c) end
            end
        end
    end
    return out
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
                if c then c:clear(); containers = containers + 1 end
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

--- Scatters the loot list across the building's containers.
local function stockBuilding(square, tier)
    local items = LOOT[tier] or LOOT.standard
    local containers = containersInBuilding(square)
    if #containers == 0 then
        -- No building, or a building with no furniture. Drop it on the floor
        -- rather than silently delivering nothing.
        for _, id in ipairs(items) do square:AddWorldInventoryItem(id, 0, 0, 0) end
        log("no containers found - dropped " .. #items .. " items on the ground")
        return #items
    end
    for _, id in ipairs(items) do
        local c = containers[ZombRand(#containers) + 1]
        c:AddItem(id)
    end
    -- Set dressing on the floor, so it reads as a place somebody lived in
    -- rather than a house that happens to have a shotgun in a wardrobe.
    local squares = squaresInBuilding(square)
    if #squares > 0 then
        for _, id in ipairs(DRESSING) do
            local sq = squares[ZombRand(#squares) + 1]
            sq:AddWorldInventoryItem(id, 0, 0, 0)
        end
    end
    log("stocked " .. #items .. " items across " .. #containers .. " containers, "
        .. #DRESSING .. " pieces of dressing")
    return #items
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
local function ringWithZombies(cx, cy, cz, count, eventId)
    local placed = 0
    for _ = 1, count do
        local ang = ZombRandFloat(0, 6.2831853)
        local dist = ZombRandFloat(12, 28)
        local x = math.floor(cx + math.cos(ang) * dist)
        local y = math.floor(cy + math.sin(ang) * dist)
        local sq = getCell():getGridSquare(x, y, cz)
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
        end
    end
    log("placed " .. placed .. "/" .. count .. " zombies")
    return placed
end

--- Counts (and optionally removes) the zombies belonging to this event.
local function sweepZombies(cx, cy, cz, eventId, remove)
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

-- ------------------------------------------------------------------- arming

--- Places loot and zombies. Safe to call only once per event.
local function fire(ev)
    local sq = getCell() and getCell():getGridSquare(ev.x, ev.y, ev.z)
    if not sq then return false end          -- area not streamed yet
    -- Somebody may have claimed the house between the bot arming this and the
    -- area streaming in. Abandon rather than besiege a player's base.
    if isClaimed(sq) then
        log("event " .. ev.id .. " ABANDONED - the house has been claimed since it was armed")
        ev.phase = "done"
        ev.abandoned = true
        writeStatus(ev)
        return true
    end
    stockBuilding(sq, ev.loot)
    ev.spawned = ringWithZombies(ev.x, ev.y, ev.z, ev.zombies, ev.id)
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
    if st.done and st.done[req.id] then return end              -- already run

    st.current = {
        id = req.id, x = req.x, y = req.y, z = req.z,
        zombies = req.zombies, loot = req.loot,
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
            local removed = sweepZombies(ev.x, ev.y, ev.z, ev.id, true)
            log("event " .. ev.id .. " EXPIRED after " .. MAX_EVENT_MINUTES ..
                " min - removed " .. removed .. " zombies")
            ev.phase = "done"
            ev.expired = true
            ev.alive = 0
            writeStatus(ev)
            st.done = st.done or {}
            st.done[ev.id] = true
            st.current = nil
            return
        end
    end

    if ev.phase == "active" then
        local alive = sweepZombies(ev.x, ev.y, ev.z, ev.id, false)
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
            local removed = sweepZombies(ev.x, ev.y, ev.z, ev.id, true)
            log("event " .. ev.id .. " cleaned up - removed " .. removed .. " stragglers")
            ev.phase = "done"
            ev.alive = 0
            writeStatus(ev)
            st.done = st.done or {}
            st.done[ev.id] = true
            st.current = nil
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

Events.EveryOneMinute.Add(poll)
Events.EveryOneMinute.Add(tick)
Events.LoadGridsquare.Add(onLoadGridsquare)

log("loaded")
