--[[
Ground-item sweep — clears loose items outside player claims.

WHY IT WORKS THE WAY IT DOES
Vanilla's own item removal says it plainly: "Items are removed the next time
that part of the map is loaded." That is not a design choice, it is the only
option — Lua can only touch squares that are currently streamed, and on a
dedicated server that means squares near an online player. A one-shot "clear the
whole map" is impossible from inside the game, so this arms a sweep that runs
for a while and cleans each area as somebody walks through it.

WHAT IT WILL NOT TOUCH
- anything inside a player claim, or within SAFE_BUFFER tiles of one
- anything in a container (this is loose ground items only)
- anything a player is carrying

WHAT IT WILL TOUCH
Everything else on the floor, everywhere, with no way to tell a discarded corpse
pile from a deliberate stash. There is no timestamp on a world item that Lua can
read, so "only old items" is not available — vanilla tracks age internally and
does not expose it. That bluntness is why this defaults to counting rather than
removing, and why it expires on its own.
]]

local SWEEP_KEY = "WabbajackSweep"
-- Keep well clear of claims. A player's yard, their parked car, the crate they
-- left by the door - none of that is litter, and the cost of skipping a square
-- is nothing.
local SAFE_BUFFER = 30
-- A sweep stops on its own after this many real hours, so a forgotten one does
-- not quietly delete things for the rest of the wipe.
local EXPIRE_HOURS = 6
local REAL_MINUTES_PER_DAY = 120

local function log(msg) print("[WabbajackSweep] " .. tostring(msg)) end
local function state() return ModData.getOrCreate(SWEEP_KEY) end

local function realHoursSince(worldAgeHours)
    if not worldAgeHours then return 0 end
    local gameHours = getGameTime():getWorldAgeHours() - worldAgeHours
    return gameHours * (REAL_MINUTES_PER_DAY / 24) / 60
end

--[[
Distance from a point to the nearest claim, in tiles.

The claim list is rebuilt each call rather than cached: claims are created and
released while the server runs, and a stale list here means sweeping somebody's
new base. It is a short list (tens of entries) against a check that already
early-exits on empty squares.
]]
local function nearClaim(x, y)
    if not SafeHouse then return false end
    local ok, result = pcall(function()
        local list = SafeHouse.getSafehouseList()
        if not list then return false end
        for i = 0, list:size() - 1 do
            local s = list:get(i)
            local sx, sy = s:getX(), s:getY()
            local sw, sh = s:getW(), s:getH()
            local dx = math.max(sx - x, 0, x - (sx + sw))
            local dy = math.max(sy - y, 0, y - (sy + sh))
            if (dx * dx + dy * dy) < (SAFE_BUFFER * SAFE_BUFFER) then return true end
        end
        return false
    end)
    -- Fail SAFE: if the claim list cannot be read we treat everywhere as
    -- claimed and remove nothing, rather than sweeping blind.
    if not ok then return true end
    return result
end

--- Counts, and optionally removes, loose items on one square.
local function sweepSquare(sq, remove)
    if not sq then return 0 end
    local world = sq:getWorldObjects()
    if not world or world:size() == 0 then return 0 end   -- cheap early exit
    if nearClaim(sq:getX(), sq:getY()) then return 0 end

    local n = 0
    for i = world:size() - 1, 0, -1 do
        local item = world:get(i)
        if item then
            if remove then
                sq:transmitRemoveItemFromSquare(item)
                sq:removeWorldObject(item)
            end
            n = n + 1
        end
    end
    return n
end

--[[
Sweeps what is currently streamed around each online player.

BUDGETED ON PURPOSE. This runs synchronously inside one server tick, and the
first version used a radius of 100 — 201x201 = 40,401 squares per player, or
~485,000 iterations with twelve people online, each allocating a string key for
the dedupe table. That is a multi-second freeze of the whole server, long enough
for the hang watchdog to consider restarting it.

So: a modest radius, a hard ceiling on squares examined, and an integer dedupe
key instead of a string. The immediate pass is only ever a head start anyway —
LoadGridsquare does the real work as players move, one square at a time, for
free.
]]
local IMMEDIATE_RADIUS = 40          -- 81x81 = 6,561 squares per player
local MAX_SQUARES = 60000            -- ceiling across all players, per call

local function sweepLoaded(remove)
    local cell = getCell()
    if not cell then return 0, 0 end
    local players = getOnlinePlayers()
    if not players then return 0, 0 end

    local total, squares, examined = 0, 0, 0
    local seen = {}
    for p = 0, players:size() - 1 do
        local pl = players:get(p)
        if pl then
            local px, py = math.floor(pl:getX()), math.floor(pl:getY())
            for x = px - IMMEDIATE_RADIUS, px + IMMEDIATE_RADIUS do
                for y = py - IMMEDIATE_RADIUS, py + IMMEDIATE_RADIUS do
                    -- Integer key: x*32768+y is unique for a 32k-wide map and
                    -- allocates nothing, unlike string concatenation.
                    local key = x * 32768 + y
                    if not seen[key] then
                        seen[key] = true
                        examined = examined + 1
                        if examined > MAX_SQUARES then
                            log("immediate pass hit the " .. MAX_SQUARES ..
                                "-square ceiling; the rest clears as areas load")
                            return total, squares
                        end
                        local sq = cell:getGridSquare(x, y, 0)
                        if sq then
                            local n = sweepSquare(sq, remove)
                            if n > 0 then total = total + n; squares = squares + 1 end
                        end
                    end
                end
            end
        end
    end
    return total, squares
end

--[[
Public: called by the client command handler.

A COUNT MUST NOT DISTURB A RUNNING SWEEP. This used to write st.active,
st.startedAt and st.removed unconditionally, so "Count what would go (safe)" —
the option the menu offers first precisely because it is the harmless one —
silently disarmed any sweep already in progress and reset its running total to
zero. Only an actual sweep touches the sweep's state now.
]]
function WabbajackSweep_start(remove, whoName)
    local st = state()
    local now, sq = sweepLoaded(remove)
    if remove then
        st.active = true
        st.startedAt = getGameTime():getWorldAgeHours()
        st.removed = now
        st.by = whoName
    end
    log((remove and "SWEEP armed by " or "count requested by ") .. tostring(whoName)
        .. " - " .. now .. " items on " .. sq .. " squares in the loaded area"
        .. ((not remove) and st.active and " (a sweep is already running; unchanged)" or ""))
    return now, sq
end

function WabbajackSweep_stop()
    local st = state()
    st.active = false
    log("sweep stopped - removed " .. tostring(st.removed or 0) .. " items in total")
    return st.removed or 0
end

function WabbajackSweep_status()
    local st = state()
    return st.active and true or false, st.removed or 0, st.by
end

--- Chunks streaming in while a sweep is armed get cleaned as they arrive.
local function onLoadGridsquare(square)
    local st = state()
    if not st.active then return end
    local n = sweepSquare(square, true)
    if n > 0 then st.removed = (st.removed or 0) + n end
end

--- Expiry, so a forgotten sweep does not run for the rest of the wipe.
local function tick()
    local st = state()
    if not st.active then return end
    if realHoursSince(st.startedAt) >= EXPIRE_HOURS then
        log("sweep expired after " .. EXPIRE_HOURS .. "h - removed "
            .. tostring(st.removed or 0) .. " items")
        st.active = false
    end
end

Events.LoadGridsquare.Add(onLoadGridsquare)
Events.EveryOneMinute.Add(tick)
log("loaded")
