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
local function clusters()
    return (WabbajackSettings_get and WabbajackSettings_get("baseraid.clusters")) or 8
end
-- Never place a cluster this close to anybody, so no one has a horde appear on
-- top of them - including a player standing in their own yard when it fires.
-- Fallback is the widest option, not zero: this is the number that stops a horde
-- materialising on top of somebody, so failing open would put zombies in laps.
local function playerClearance()
    return (WabbajackSettings_get and WabbajackSettings_get("baseraid.playerClearance")) or 30
end
-- Attempts per zombie before that one is given up on. Same reasoning as the
-- siege: a nil square is a silent failure, and one attempt each lost a third of
-- the horde in production.
local PLACE_ATTEMPTS = 6
-- How near a streaming square has to be to a pending cluster to trigger it.
local TRIGGER_RADIUS = 60

local function log(msg) print("[WabbajackRaid] " .. tostring(msg)) end
local function state() return ModData.getOrCreate(MODDATA_KEY) end

-- One setting shared with the siege and sweep modules; see world.realMinutesPerDay.
local function realMinutesPerDay()
    return (WabbajackSettings_get and WabbajackSettings_get("world.realMinutesPerDay")) or 120
end
local function realMinutesSince(worldAgeHours)
    if not worldAgeHours then return 0 end
    local elapsed = getGameTime():getWorldAgeHours() - worldAgeHours
    return elapsed * (realMinutesPerDay() / 24)
end

-- ---------------------------------------------------------------- request io

--[[
Reads the bot's request.

    id=1786971828767
    perPlayer=40
    expire=180

Read from <Zomboid>/Lua/, which is where getFileReader is rooted -- BOTH ends of
the file API are, despite a long-standing note here claiming the reader used the
Zomboid root. Requests written to the root are never seen, and the miss is
indistinguishable from no request at all.

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
    local clusterCount = clusters()
    local perCluster = math.max(1, math.floor(req.perPlayer / clusterCount))

    for name, _ in pairs(onlinePlayers()) do
        local claim = claimFor(name, list)
        if not claim then
            skipped = skipped + 1
        else
            local made = 0
            for _ = 1, clusterCount do
                local x, y = perimeterPoint(claim)
                if x and not tooCloseToAnyone(x, y, playerClearance()) then
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

-- --------------------------------------------------------- automatic nights

--[[
Base raids on a schedule, counted in in-game nights.

WHY NIGHTS AND NOT REAL HOURS
A night is the unit players actually feel. This world runs a two-hour day, so
"every 3 nights" is about six real hours and moves with the day-length setting
instead of drifting away from it - change world.realMinutesPerDay and the
schedule still means what it says, because it never mentions real time at all.

getNightsSurvived() is a stored counter on GameTime that persists with the save,
so the count survives restarts without this module keeping its own.

TWO SCHEDULES, ONE MECHANISM
The interval modes fire on every Nth night. The random mode rolls a percentage
instead, once per night, and that is the difference between a raid and an
appointment: a horde due on a night everyone can name is met by a server that is
home, stocked and standing on the roof. A one-in-three night nobody can predict
is the thing this feature was for.

Either way the hour is drawn fresh out of a window rather than fixed, so a night
that does fire is not also "at ten o'clock, like last time".

PLAN FIRST, FIRE LATER
Each night is planned once, the first time this handler sees a new night
counter: roll whether a raid happens at all, and if it does, draw the hour it
arms at. The plan lives in ModData so it survives a restart, and the drawn hour
is consumed the moment it comes round, BEFORE any decision about whether to
actually arm. So:

- a night can never fire twice, including across a restart inside that hour;
- a night that is skipped, because the roll lost or nobody was online, is
  skipped for good rather than fired late.

That second one is deliberate. A raid that was due at 22:00 and instead lands at
04:00 on the one person who happened to log in is not "every three nights", it
is an ambush with a schedule's name on it. A plan that is already in the past
when it is drawn - the server was started late - is missed on the same grounds,
and says so in the log.

ONE PLAN PER IN-GAME DAY, AND THE WINDOW NEVER CROSSES MIDNIGHT
The plan is keyed on the in-game date rather than on the night counter, even
though the counter is what the intervals are counted in. A date turns over at
midnight by definition, and getNightsSurvived() is an engine counter that turns
over whenever the engine says so - if that ever landed inside the evening
window, a plan would be redrawn halfway through the night it had already made a
decision about, and one night could roll twice.

Both ends of the window are hours on that one day, and a later end below the
earlier is pushed up rather than wrapping. A window written 22 to 02 would be
two different days either side of midnight, and the half past midnight would
belong to a day already planned and consumed, so it would silently never fire.
An evening window is what people mean by "tonight" in any case.

NOBODY ONLINE MEANS NO RAID
Base raids arm at the claims of players who are online, so an empty server has
nothing to arm against - and the whole premise is that raids land on people who
can fight back. The night is still consumed.

OFF BY DEFAULT, AND THAT IS NOT TIMIDITY
Every zombie this places is permanent: ZombieRespawn is None here and no command
removes them. A setting that quietly starts placing hundreds of them at
everybody's base on a timer has to be switched on deliberately.
]]

-- Sandbox enum values. 1 is Off and 6 rolls a chance each night; 2-5 are the
-- fixed intervals, in nights between raids. The order must match the value
-- strings in Sandbox_EN.txt.
local CHOICE_OFF      = 1
local CHOICE_RANDOM   = 6
local NIGHT_INTERVALS = { [2] = 1, [3] = 2, [4] = 3, [5] = 7 }

local function autoChoice()
    return tonumber(WabbajackSettings_get and WabbajackSettings_get("baseraid.nightInterval")) or CHOICE_OFF
end

local function autoChance()
    local pct = tonumber(WabbajackSettings_get and WabbajackSettings_get("baseraid.nightChance")) or 33
    return math.max(0, math.min(100, math.floor(pct)))
end

local function clampHour(h, fallback)
    h = tonumber(h)
    if not h then return fallback end
    return math.max(0, math.min(23, math.floor(h)))
end

--- The window the arming hour is drawn from: earliest, latest, never wrapping.
local function autoHourWindow()
    local earliest = clampHour(WabbajackSettings_get and WabbajackSettings_get("baseraid.nightHourEarliest"), 20)
    local latest   = clampHour(WabbajackSettings_get and WabbajackSettings_get("baseraid.nightHourLatest"), 23)
    if latest < earliest then latest = earliest end
    return earliest, latest
end

local function autoPerPlayer()
    return tonumber(WabbajackSettings_get and WabbajackSettings_get("baseraid.autoPerPlayer")) or 40
end

local function scheduleName()
    local choice = autoChoice()
    if choice == CHOICE_RANDOM then
        return "the schedule (" .. tostring(autoChance()) .. "% chance each night)"
    end
    return "the schedule (every " .. tostring(NIGHT_INTERVALS[choice] or 0) .. " night(s))"
end

--- The hour tonight arms at, or nil for a night that does not raid at all.
local function rollNight(night)
    local choice = autoChoice()
    if choice == CHOICE_RANDOM then
        if ZombRand(100) >= autoChance() then return nil end
    else
        local every = NIGHT_INTERVALS[choice]
        if not every or every <= 0 then return nil end
        if (night % every) ~= 0 then return nil end
    end
    local earliest, latest = autoHourWindow()
    return earliest + ZombRand(latest - earliest + 1)
end

local function autoTick()
    if autoChoice() == CHOICE_OFF then return end

    local gt = getGameTime and getGameTime()
    if not gt then return end

    local ok, night, hour, day = pcall(function()
        return gt:getNightsSurvived(), gt:getHour(),
            gt:getYear() * 10000 + gt:getMonth() * 100 + gt:getDay()
    end)
    if not ok or not night or not hour or not day then return end
    hour = math.floor(hour)

    local st = state()
    local plan = st.autoPlan
    if not plan or plan.day ~= day then
        local at = rollNight(night)
        plan = { day = day, night = night, hour = at or -1 }
        st.autoPlan = plan
        if at and at < hour then
            -- Drawn into the past, which only happens when the server came up
            -- after the window. Missed, not rescheduled; see the header.
            plan.hour = -1
            log("night " .. tostring(night) .. " drew " .. tostring(at) ..
                ":00 but it is already " .. tostring(hour) .. ":00 - missed, not rescheduled")
        elseif at then
            log("night " .. tostring(night) .. " will arm a raid at " .. tostring(at) .. ":00")
        end
    end

    if plan.hour < 0 or hour ~= plan.hour then return end
    -- Consume the hour first. Everything below this line may decline to arm,
    -- and none of it may cause a retry a minute later.
    plan.hour = -1

    local online = 0
    for _ in pairs(onlinePlayers()) do online = online + 1 end
    if online == 0 then
        log("scheduled raid due on night " .. tostring(night) .. " but nobody is online - skipped")
        return
    end

    local armed = WabbajackBaseRaid_arm(autoPerPlayer(), scheduleName())
    log("scheduled raid armed on night " .. tostring(night) .. " across " ..
        tostring(armed) .. " claim(s)")
end

Events.EveryOneMinute.Add(poll)
Events.EveryOneMinute.Add(autoTick)
Events.EveryOneMinute.Add(tick)
Events.LoadGridsquare.Add(onLoadGridsquare)

log("loaded")
