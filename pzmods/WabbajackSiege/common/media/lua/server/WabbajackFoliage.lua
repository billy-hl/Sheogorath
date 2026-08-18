--[[
Roadside foliage — bushes and saplings die under wheels, for everyone, always.

WHAT THIS CANNOT DO, STATED FIRST
It does not reduce the slowdown. That collision lives in BaseVehicle (Java):
the square is asked HasTree(), the IsoTree is checked for isBush, and
Hit_Tree_Shudder plays. No Lua event goes anywhere near it -- BaseVehicle fires
exactly five (OnContainerUpdate, OnEnterVehicle, OnFillContainer,
OnPlayerGetDamage, OnSpawnVehicleStart) and none is a collision; OnObjectCollide
belongs to IsoMovingObject, which is characters. Lua cannot override a Java
method, so the slowdown is not moddable from here OR from a client mod.

What is moddable is whether the bush is still standing next time. The driver
still feels the first hit -- their own client resolved that collision before the
server saw the position, because BaseVehicle$Authorization is Local/LocalCollide
for a driven vehicle -- and then the bush dies. Roads clear themselves along the
routes people actually drive. That is the whole feature.

NO SWITCH. This runs unconditionally from the moment the mod loads, for every
driven vehicle on the server, whoever is driving. There is deliberately no arm,
no stop and no expiry: an earlier version defaulted to off and had to be turned
on by staff from a context menu, which made it a staff tool that happened to
help whoever was nearby. It is meant to be a property of the roads instead.

That removal is why the remaining gates matter more, not less. What still limits
it: only vehicles with a driver, only things the engine itself flags as a bush,
never indoors, and never more than MAX_KILLS_PER_PASS at a time.

There is no speed floor and no size threshold. Both were guesses, and both made
this miss the thing it exists to catch -- see clearSquare and the driver check.

WHY Damage() AND NOT removeFromWorld()
The same lesson the siege horde taught us. removeFromWorld() does not broadcast
from a dedicated server: it drops the object out of the server's simulation and
leaves every client still looking at it. IsoTree:Damage(float) is the engine's
own destruction path -- it is what chopping calls -- so removal and drop are
whatever vanilla does, on every client, for free.

It also means the loot is vanilla's own yield. IsoTree carries TWIGS,
LARGE_BRANCH, TREE_BRANCH_2 and LOGS_PER_SIZE, so a felled sapling drops what
felling a sapling drops. No item ids were guessed here, which matters because
guessed ids are the other thing in this mod that fails silently -- AddItem() on
an unknown id returns nil and adds nothing.

WHY THIS IS NOT THE SWEEP
The sweep nearly hung the server by walking an 81x81 box around every player:
~485,000 iterations in one synchronous tick with twelve online. This walks the
squares a vehicle is actually sitting on -- a handful per pass, regardless of
how many people are logged in. If you ever find yourself scanning near *players*
in this file, you have rebuilt that freeze under a new name.
]]

local FOLIAGE_KEY = "WabbajackFoliage"

--[[
Per vehicle, per pass. A car crossing a hedge row could otherwise destroy
dozens of objects inside a second, and every destruction broadcasts to every
client that can see it. The cap turns a burst into a trickle without changing
the outcome -- the rest die on the next pass, 300ms later.
]]
local MAX_KILLS_PER_PASS = 3

--[[
How far along its own path one vehicle is followed per pass.

A car at speed crosses several tiles between passes, so checking only the square
it is on now would let it drive straight through a bush without touching it.
The path from the last known position is walked instead. The cap is what stops a
teleport (a respawn, a chunk reload, an admin move) from turning into a
kilometre-long line of destruction.
]]
local MAX_PATH_SQUARES = 12

--[[
Passes per second. Events.OnTick fires per frame, which is far more often than
this needs: at ~10Hz a car at highway speed still lands inside every tile it
crosses, and the work is a few square lookups. Anything faster is pure cost.
]]
local TICK_EVERY = 6

local function log(msg) print("[WabbajackFoliage] " .. tostring(msg)) end

--- Persisted tally only. There is no on/off state to keep any more.
local function state() return ModData.getOrCreate(FOLIAGE_KEY) end

--[[
Last known position per vehicle, for path interpolation.

Deliberately a plain local and NOT ModData: this is transient, it is rebuilt
within one pass of any vehicle that matters, and ModData is persisted to the
save. Writing a row per vehicle per tick into the save would be the expensive
mistake in an otherwise cheap feature.
]]
local lastPos = {}

--[[
Accessor failures since the last minute tick.

Counted rather than logged at the point of failure, because this runs ~10 times
a second: a vehicle that throws on every pass would produce six hundred
identical lines a minute and bury everything else in the server log. The minute
tick reports the total and resets it, which is enough to notice a problem
without the noise. Silence here would be worse -- a mod that loads proves
nothing about whether its work is landing.
]]
local failures = 0

--[[
Counts, and optionally fells, bushes on one square.

ASK THE ENGINE WHAT A BUSH IS. `IsoGridSquare:getBushes()` and `IsoObject:isBush()`
are both public, and isBush is the *same property BaseVehicle consults* when it
decides to slow you down. So the selector is now definitionally the set of
things that cost you speed -- which is exactly the feature.

THIS REPLACES A GUESS THAT WAS WRONG TWICE OVER. 1.12.1 selected
`instanceof(o, "IsoTree")` with `getSize() <= MAX_TREE_SIZE`, on the assumption
that a bush was a small tree. Reported symptom: one bush died and several beside
it did not. Both halves of the guess were broken -- isBush is not on IsoTree at
all (it is on IsoObject and IsoSprite), so plenty of roadside growth is a plain
IsoObject that the instanceof never matched, and among the real IsoTrees the
size cutoff dropped the rest. There is no size threshold here any more, and
nothing left to calibrate.

It is also *safer* than the guess it replaces: a sprite flagged as a bush is
never a mature oak, so the "raise the threshold and start felling real trees"
risk is gone rather than merely tuned.

hasBush() first: a cheap boolean that skips allocating the list on the
overwhelming majority of squares, which matters at 10Hz.

Indoor squares are skipped outright. Vehicles do get inside buildings -- garages,
warehouses, the odd wall a player drove through -- and a potted plant in
somebody's base is not roadside growth.
]]
local function clearSquare(sq, cut, budget)
    if not sq then return 0 end
    if sq:getRoom() then return 0 end            -- indoors, leave it alone
    if not sq:hasBush() then return 0 end        -- cheap reject, no allocation

    local bushes = sq:getBushes()
    if not bushes or bushes:size() == 0 then return 0 end

    local n = 0
    -- getBushes() returns java.util.List, which really does have get(int) --
    -- unlike getCell():getVehicles(), which is a Set and cost us a tick-rate
    -- exception storm. Different collection, different rules; do not "fix"
    -- this one to match the other.
    -- Backwards, because felling mutates the square underneath us.
    for i = bushes:size() - 1, 0, -1 do
        if n >= budget then break end
        local o = bushes:get(i)
        if o then
            if not cut then
                n = n + 1
            elseif instanceof(o, "IsoTree") then
                -- Damage() runs the engine's own destruction, which is what
                -- makes the removal reach clients AND drops vanilla's own
                -- yield -- the twigs and branch. See the header.
                if pcall(function() o:Damage(1000.0) end) then n = n + 1 end
            else
                -- A bush that is not a tree has no yield to drop, and
                -- removeFromWorld() would not broadcast. transmitRemoveItemFromSquare
                -- takes an IsoObject and is the call the sweep already relies on
                -- for exactly this reason.
                local ok = pcall(function()
                    sq:transmitRemoveItemFromSquare(o)
                    sq:RemoveTileObject(o)
                end)
                if ok then n = n + 1 end
            end
        end
    end
    return n
end

--[[
The squares one vehicle has occupied since the last pass, current one included.

Straight-line interpolation. It does not matter that a real path curves: at 10Hz
the gap is a few tiles and the error is under a tile, while the cost of getting
it wrong -- driving through a bush that never notices -- is the bug this exists
to avoid.
]]
local function pathSquares(cell, lx, ly, x, y, z)
    local out = {}
    local dx, dy = x - lx, y - ly
    local steps = math.max(math.abs(dx), math.abs(dy))
    if steps > MAX_PATH_SQUARES then steps = MAX_PATH_SQUARES end
    if steps < 1 then steps = 1 end

    local seen = {}
    for s = 0, steps do
        local px = math.floor(lx + dx * (s / steps) + 0.5)
        local py = math.floor(ly + dy * (s / steps) + 0.5)
        local key = px * 32768 + py       -- integer key, allocates nothing
        if not seen[key] then
            seen[key] = true
            local sq = cell:getGridSquare(px, py, z)
            if sq then out[#out + 1] = sq end
        end
    end
    return out
end

--[[
One pass over every driven vehicle on the server.

`getVehicles()` RETURNS A java.util.Set, AND IT MEANS IT. It has size(); it has
no get(int). `vehicles:get(i)` throws "Object tried to call nil" on every call,
which at 10Hz is six hundred stack traces a minute and not one bush felled --
shipped exactly that in 1.11.0.

The trap is that vanilla's own ISVehicleBloodUI calls `vehicles:get(i-1)`, which
reads like proof that the Lua wrapper exposes list semantics. It is not; that is
client debug UI behind a tickbox and it is just as broken. damnlib shows the
real history: its B41-era copy uses `:get(i)` and its 42.17 override rewrites
the same function to `:toArray()`. Iterate a Set as a Set. Verified against
DoomedRoadkillPhysics, which is installed here and does exactly this.

THE WHOLE BODY IS INSIDE A pcall as well as each vehicle. The per-vehicle pcall
was never the problem -- the throw was in the loop machinery around it, so it
escaped to OnTick and spammed the log ten times a second. A backstop here means
a mistake of that shape costs a counter increment instead of the server log.
]]
local function doPass()
    local cell = getCell()
    if not cell then return 0, 0 end

    local vehicles = cell:getVehicles()
    if not vehicles or vehicles:size() == 0 then return 0, 0 end

    local felled, touched = 0, 0

    local iter = vehicles:iterator()
    while iter:hasNext() do
        local v = iter:next()
        if v then
            -- Everything about one vehicle is inside the pcall, including the
            -- id read: a vehicle that is mid-despawn throws on any accessor,
            -- and reaching for getId() again in the failure branch would throw
            -- a second time with nothing left to catch it.
            local ok = pcall(function()
                local id = v:getId()
                local x, y = math.floor(v:getX()), math.floor(v:getY())
                local z = math.floor(v:getZ() or 0)
                local last = lastPos[id]
                lastPos[id] = { x = x, y = y, z = z }

                --[[
                NO SPEED FLOOR, ON PURPOSE, AND THE REASON IS THE BUG ITSELF.
                There used to be a 15km/h minimum, which was self-defeating:
                hitting a bush is what costs you speed, so ploughing into one
                could drop the vehicle under the floor and switch off the very
                thing meant to clear it. Slow going through heavy growth is
                precisely when this should be working hardest.

                A driver is still required. That is what keeps this "under
                wheels" rather than "near any parked car", and it is the only
                remaining gate on which vehicles act.
                ]]
                if not v:getDriver() then return end

                local lx, ly = x, y
                if last and last.z == z then lx, ly = last.x, last.y end

                local budget = MAX_KILLS_PER_PASS
                for _, sq in ipairs(pathSquares(cell, lx, ly, x, y, z)) do
                    if budget <= 0 then break end
                    local n = clearSquare(sq, true, budget)
                    if n > 0 then
                        felled = felled + n
                        touched = touched + 1
                        budget = budget - n
                    end
                end
            end)
            -- One bad vehicle must not stop the pass for the rest. Its stale
            -- position row is harmless and gets flushed on the minute tick.
            if not ok then failures = failures + 1 end
        end
    end

    return felled, touched
end

--- Backstop: nothing from doPass may reach OnTick. See the note above.
local function pass()
    local ok, felled, touched = pcall(doPass)
    if not ok then
        failures = failures + 1
        return 0, 0
    end
    return felled or 0, touched or 0
end

local ticks = 0

--- Unconditional. The only gate is the tick divider.
local function onTick()
    ticks = ticks + 1
    if ticks < TICK_EVERY then return end
    ticks = 0
    local n = pass()
    if n > 0 then
        local st = state()
        st.felled = (st.felled or 0) + n
    end
end

--[[
Public: what would be felled around the admin asking, right now.

STILL WORTH HAVING WITH NO SWITCH AND NO THRESHOLD. It no longer calibrates
anything -- the engine's own isBush decides that now -- but it answers the
question that actually gets asked when a bush survives: "does the server agree
this is a bush at all?" A zero here next to something leafy means the sprite is
not flagged, which is a different problem from the clearing not running.

DELIBERATELY NOT A PASS OVER VEHICLES. Counting that way would only ever report
foliage under a vehicle currently being driven, so an admin standing
still -- which is exactly what an admin does when they open a context menu --
would always be told zero. A count that reads zero whenever you run it is
indistinguishable from a broken feature, and this mod has shipped that bug
before.

THE RADIUS IS SAFE HERE AND WOULD NOT BE IN A LOOP. 21x21 is 441 squares, once,
when a human clicks a menu item. The sweep's freeze was 485,000 squares every
tick. The shape is only dangerous when it repeats.
]]
local COUNT_RADIUS = 10

function WabbajackFoliage_count(player)
    if not player then return 0, 0 end
    local cell = getCell()
    if not cell then return 0, 0 end

    local px, py = math.floor(player:getX()), math.floor(player:getY())
    local pz = math.floor(player:getZ() or 0)
    local found, squares = 0, 0

    for x = px - COUNT_RADIUS, px + COUNT_RADIUS do
        for y = py - COUNT_RADIUS, py + COUNT_RADIUS do
            local sq = cell:getGridSquare(x, y, pz)
            if sq then
                -- Budget high enough not to cap a count: this reports, it does
                -- not cut, so the per-pass kill cap is meaningless here.
                local n = clearSquare(sq, false, math.huge)
                if n > 0 then found = found + n; squares = squares + 1 end
            end
        end
    end

    log("count by " .. tostring(player:getUsername()) .. " - " .. found ..
        " bushes within " .. COUNT_RADIUS .. " tiles")
    return found, squares
end

--- Running total since the mod was installed. Always live, so there is no
--- "active" to report.
function WabbajackFoliage_status()
    return state().felled or 0
end

--- Flushes position rows for vehicles that have since unloaded -- the only way
--- that table would otherwise grow -- and reports accumulated failures.
local function tick()
    lastPos = {}
    if failures > 0 then
        log(failures .. " vehicle read(s) failed in the last minute")
        failures = 0
    end
end

Events.OnTick.Add(onTick)
Events.EveryOneMinute.Add(tick)
log("loaded - always on, engine isBush selector, any speed, driver required")
