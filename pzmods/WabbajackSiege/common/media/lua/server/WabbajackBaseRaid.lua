--[[
Base raids - hordes that converge on players' own safehouses.

WHY THIS IS ARMED RATHER THAN SPAWNED
The obvious implementation is "put the zombies at their base", and it cannot
work. Every spawn API resolves its target through getGridSquare, which returns
nil for a chunk that is not streamed, and on a dedicated server the only
streamed chunks are those around online players. So the exact case this feature
is for - somebody out looting, their base quiet and far away - is the case where
the target is guaranteed unloaded. RCON's createhorde2 answers `invalid
location`; this mod would get a nil square. Retrying does not help, because
there is nothing to retry into.

What works is to arm the horde and let it materialise the instant the area
streams. Streaming reaches 60-95 tiles while a player sees roughly 30, so the
chunk loads while they are still a block out: they drive home and the horde is
already standing at the walls. Nobody ever watches zombies appear, and it works
identically on foot or at road speed - which the spawn-around-the-player version
does not, since at 50mph the position read is stale before the command lands.

WHERE THEY GO
On a ring just OUTSIDE the claim rectangle, never inside it. The safehouse is
the thing being besieged, not the thing being invaded - dropping them within the
walls skips the entire fight and lands them next to whatever the player built.
Points also keep clear of anyone standing around, so nobody has a horde
materialise on top of them.

WHAT HAPPENS TO THEM AFTERWARDS
Nothing. These are permanent, exactly like the zombies /pz raid already places -
ZombieRespawn is None on this server and no command removes them. They are
tagged all the same, so a cleanup could be written later, but nothing here
removes them and the Discord side says so out loud before it arms anything.
]]

local REQUEST_FILE = "wabbajack_raid.txt"
local STATUS_FILE  = "wabbajack_raid_status.txt"
local MODDATA_KEY  = "WabbajackBaseRaid"
local TAG          = "wabbajackRaid"

-- Ring outside the claim edge, in tiles, that spawn points are drawn from.
--
-- RING_OUT_MIN has to exceed the cluster scatter below, or the promise that
-- nothing spawns inside the claim is not kept: a point 3 tiles out with a
-- 4-tile scatter puts zombies a tile INSIDE the walls, which skips the entire
-- fight and drops them next to whatever the player built. 6 minus 4 leaves two
-- tiles of margin at worst.
local RING_OUT_MIN, RING_OUT_MAX = 6, 12
-- Scatter within a cluster, in tiles either way. Must stay under RING_OUT_MIN.
local CLUSTER_SCATTER = 4
-- Clusters per raid. The horde arrives as a ring of groups rather than one
-- lump, so it reads as converging on the building from every side.
local CLUSTERS = 8
-- Never place a cluster this close to anybody, so no one has a horde appear on
-- top of them - including a player standing in their own yard when it fires.
local PLAYER_CLEARANCE = 12
-- Attempts per zombie before that one is given up on. Same reasoning as the
-- siege: a nil square is a silent failure, and one attempt each lost a third of
-- the horde in production.
local PLACE_ATTEMPTS = 6
-- How near a streaming square has to be to a pending cluster to trigger it.
local TRIGGER_RADIUS = 60

local function log(msg) print("[WabbajackRaid] " .. tostring(msg)) end
local function state() return ModData.getOrCreate(MODDATA_KEY) end

local REAL_MINUTES_PER_DAY = 120
local function realMinutesSince(worldAgeHours)
    if not worldAgeHours then return 0 end
    local elapsed = getGameTime():getWorldAgeHours() - worldAgeHours
    return elapsed * (REAL_MINUTES_PER_DAY / 24)
end

-- ---------------------------------------------------------------- request io

--[[
Reads the bot's request.

    id=1786971828767
    perPlayer=40
    expire=180

The bot deliberately does NOT send coordinates. Claims are created and released
while the server runs, and SafeHouse.getSafehouseList() here is live, whereas
anything parsed out of map_meta.bin on the Discord side is as old as the last
save. Sending only "how many, for how long" keeps one source of truth.
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
    if not req.id then return nil end
    req.perPlayer = tonumber(req.perPlayer or "40") or 40
    req.expire = tonumber(req.expire or "180") or 180
    return req
end

local function writeStatus(st)
    local w = getFileWriter(STATUS_FILE, true, false)
    if not w then return end
    w:write("id=" .. tostring(st.id or "") .. "\n")
    w:write("armed=" .. tostring(st.armed or 0) .. "\n")
    w:write("fired=" .. tostring(st.fired or 0) .. "\n")
    w:write("pending=" .. tostring(st.pending or 0) .. "\n")
    w:write("spawned=" .. tostring(st.spawned or 0) .. "\n")
    w:write("players=" .. tostring(st.players or "") .. "\n")
    w:close()
end

-- ------------------------------------------------------------------ placing

--- Online players, keyed by lowercased username, with their current square.
local function onlinePlayers()
    local out = {}
    local players = getOnlinePlayers()
    if not players then return out end
    for i = 0, players:size() - 1 do
        local p = players:get(i)
        if p and not p:isDead() and p:getUsername() then
            out[string.lower(p:getUsername())] = p
        end
    end
    return out
end

--[[
The claim belonging to a username, by owner OR membership.

Members matter: a group that shares one base should get one raid on it, not
none because only the owner's name is on the deed.
]]
local function claimFor(username, list)
    local want = string.lower(username)
    for i = 0, list:size() - 1 do
        local s = list:get(i)
        local owner = s.getOwner and s:getOwner()
        if owner and string.lower(tostring(owner)) == want then return s end
        local players = s.getPlayers and s:getPlayers()
        if players then
            for j = 0, players:size() - 1 do
                local m = players:get(j)
                if m and string.lower(tostring(m)) == want then return s end
            end
        end
    end
    return nil
end

--- True when any online player is standing within `clearance` of x,y.
local function tooCloseToAnyone(x, y, clearance)
    local players = getOnlinePlayers()
    if not players then return false end
    for i = 0, players:size() - 1 do
        local p = players:get(i)
        if p then
            local dx, dy = p:getX() - x, p:getY() - y
            if dx * dx + dy * dy < clearance * clearance then return true end
        end
    end
    return false
end

--[[
A random point on the perimeter of the claim, pushed out by a few tiles.

Walks the boundary of the expanded rectangle by arc length so points are spread
evenly around it rather than bunched at the corners, which is what picking a
random side and then a random offset gives you when the sides are unequal.
]]
local function perimeterPoint(s)
    local out = RING_OUT_MIN + ZombRand(RING_OUT_MAX - RING_OUT_MIN + 1)
    local x0, y0 = s:getX() - out, s:getY() - out
    local w = s:getW() + out * 2
    local h = s:getH() + out * 2
    if w < 2 or h < 2 then return nil end

    local t = ZombRandFloat(0, 2 * (w + h))
    local x, y
    if t < w then                      x, y = x0 + t, y0
    elseif t < w + h then              x, y = x0 + w, y0 + (t - w)
    elseif t < w + h + w then          x, y = x0 + w - (t - w - h), y0 + h
    else                               x, y = x0, y0 + h - (t - w - h - w) end
    return math.floor(x), math.floor(y)
end

--- Spawns up to `count` tagged zombies at x,y. Returns how many landed.
local function spawnCluster(x, y, z, count, raidId)
    local cell = getCell()
    if not cell then return 0 end
    local placed = 0
    for _ = 1, count do
        for _ = 1, PLACE_ATTEMPTS do
            -- Scatter within the cluster so they are a crowd, not a stack.
            local cx = x + ZombRand(CLUSTER_SCATTER * 2 + 1) - CLUSTER_SCATTER
            local cy = y + ZombRand(CLUSTER_SCATTER * 2 + 1) - CLUSTER_SCATTER
            if cell:getGridSquare(cx, cy, z) then
                local list = addZombiesInOutfit(cx, cy, z, 1, nil, 50)
                local zed = list and list:size() > 0 and list:get(0) or nil
                if zed then
                    local md = zed.getModData and zed:getModData()
                    if md then md[TAG] = raidId end
                    placed = placed + 1
                end
                break
            end
        end
    end
    return placed
end

-- ------------------------------------------------------------------- arming

--- Builds the pending cluster list for every online player with a claim.
local function arm(req)
    local st = state()
    local list = SafeHouse and SafeHouse.getSafehouseList and SafeHouse.getSafehouseList()
    if not list then
        log("cannot arm: safehouse list unavailable")
        return
    end

    local pending = {}
    local named, armed, skipped = {}, 0, 0
    local perCluster = math.max(1, math.floor(req.perPlayer / CLUSTERS))

    for name, _ in pairs(onlinePlayers()) do
        local claim = claimFor(name, list)
        if not claim then
            skipped = skipped + 1
        else
            local made = 0
            for _ = 1, CLUSTERS do
                local x, y = perimeterPoint(claim)
                if x and not tooCloseToAnyone(x, y, PLAYER_CLEARANCE) then
                    table.insert(pending, { x = x, y = y, z = 0, count = perCluster })
                    made = made + 1
                end
            end
            if made > 0 then
                armed = armed + 1
                table.insert(named, name)
            end
        end
    end

    -- Supersede handling belongs here, not in poll(): the in-game menu calls
    -- arm() directly, so putting it in the caller left the menu path silently
    -- discarding a running raid. Nothing has spawned yet for unfired clusters,
    -- so this loses no zombies -- but it should say so.
    if st.current then
        log("raid " .. tostring(st.current.id) .. " superseded with " ..
            #(st.current.pending or {}) .. " clusters unfired")
        st.done = st.done or {}
        st.done[st.current.id] = true
    end

    -- Bounding box over every pending cluster, so onLoadGridsquare can reject
    -- the overwhelming majority of squares with four comparisons. That handler
    -- runs for EVERY square streamed anywhere on the server -- thousands a
    -- second with people moving -- and scanning all ~80 clusters on each was a
    -- per-square cost paid continuously for an event that fires once.
    local bx1, by1, bx2, by2 = 999999, 999999, -999999, -999999
    for _, c in ipairs(pending) do
        if c.x < bx1 then bx1 = c.x end
        if c.y < by1 then by1 = c.y end
        if c.x > bx2 then bx2 = c.x end
        if c.y > by2 then by2 = c.y end
    end

    st.current = {
        id = req.id,
        pending = pending,
        bx1 = bx1 - TRIGGER_RADIUS, by1 = by1 - TRIGGER_RADIUS,
        bx2 = bx2 + TRIGGER_RADIUS, by2 = by2 + TRIGGER_RADIUS,
        armedAt = getGameTime():getWorldAgeHours(),
        expire = req.expire,
        fired = 0,
        spawned = 0,
        players = table.concat(named, ","),
        armed = armed,
    }
    log("armed " .. #pending .. " clusters across " .. armed .. " claims (" ..
        skipped .. " online players had no claim)")
    writeStatus({
        id = req.id, armed = armed, fired = 0, pending = #pending,
        spawned = 0, players = st.current.players,
    })
end

--- Fires any pending cluster whose square is streamed. Returns how many fired.
local function firePending(onlyNear)
    local st = state()
    local ev = st.current
    if not ev or not ev.pending then return 0 end
    local cell = getCell()
    if not cell then return 0 end

    local fired = 0
    for i = #ev.pending, 1, -1 do
        local c = ev.pending[i]
        local near = true
        if onlyNear then
            local dx, dy = onlyNear.x - c.x, onlyNear.y - c.y
            near = (dx * dx + dy * dy) <= TRIGGER_RADIUS * TRIGGER_RADIUS
        end
        if near and cell:getGridSquare(c.x, c.y, c.z) then
            local n = spawnCluster(c.x, c.y, c.z, c.count, ev.id)
            ev.spawned = (ev.spawned or 0) + n
            ev.fired = (ev.fired or 0) + 1
            table.remove(ev.pending, i)
            fired = fired + 1
            log("cluster fired at " .. c.x .. "," .. c.y .. " - " .. n .. "/" .. c.count ..
                " zombies (" .. #ev.pending .. " clusters still waiting)")
        end
    end
    if fired > 0 then
        writeStatus({
            id = ev.id, armed = ev.armed, fired = ev.fired,
            pending = #ev.pending, spawned = ev.spawned, players = ev.players,
        })
    end
    return fired
end

-- ------------------------------------------------------------------ ticking

local function poll()
    local st = state()
    local req = readRequest()
    if not req then return end
    if st.current and st.current.id == req.id then return end
    if st.done and st.done[req.id] then return end
    arm(req)
end

local function tick()
    local st = state()
    local ev = st.current
    if not ev then return end

    -- Anything already streamed fires straight away: players near their own
    -- base when the raid is armed should not have to walk away and back.
    firePending(nil)

    if not ev.pending or #ev.pending == 0 then
        log("raid " .. tostring(ev.id) .. " complete - " .. tostring(ev.spawned) ..
            " zombies across " .. tostring(ev.fired) .. " clusters")
        st.done = st.done or {}
        st.done[ev.id] = true
        st.current = nil
        return
    end

    if realMinutesSince(ev.armedAt) >= (ev.expire or 180) then
        log("raid " .. tostring(ev.id) .. " expired with " .. #ev.pending ..
            " clusters unfired - nobody went near those claims")
        st.done = st.done or {}
        st.done[ev.id] = true
        st.current = nil
        writeStatus({
            id = ev.id, armed = ev.armed, fired = ev.fired,
            pending = 0, spawned = ev.spawned, players = ev.players,
        })
    end
end

--- Streaming a square is what triggers the horde waiting there.
local function onLoadGridsquare(square)
    local ev = state().current
    if not ev or not ev.pending or #ev.pending == 0 then return end
    if not square then return end
    local x, y = square:getX(), square:getY()
    -- Cheap rejection first; see the bounding box note in arm().
    if ev.bx1 and (x < ev.bx1 or x > ev.bx2 or y < ev.by1 or y > ev.by2) then return end
    firePending({ x = x, y = y })
end

--[[
Entry point for the in-game menu.

Global rather than local for the same reason WabbajackSweep_start is: the
context-menu handler lives in WabbajackSiege.lua and there is no import
mechanism between server files. Only ever called from that handler, which
re-checks staff access first.
]]
function WabbajackBaseRaid_arm(perPlayer, whoName)
    arm({
        id = tostring(getTimestamp()) .. "-" .. tostring(ZombRand(1000)),
        perPlayer = math.max(1, math.min(tonumber(perPlayer) or 40, 200)),
        expire = 180,
    })
    local ev = state().current
    log("armed from the in-game menu by " .. tostring(whoName))
    return (ev and ev.armed) or 0, (ev and ev.pending and #ev.pending) or 0
end

Events.EveryOneMinute.Add(poll)
Events.EveryOneMinute.Add(tick)
Events.LoadGridsquare.Add(onLoadGridsquare)

log("loaded")
