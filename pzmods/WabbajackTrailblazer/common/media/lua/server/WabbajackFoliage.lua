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

NO ARM, NO STOP, NO EXPIRY. This runs for every driven vehicle on the server,
whoever is driving, from the moment the mod loads. An earlier version defaulted
to off and had to be turned on by staff from a context menu, which made it a
staff tool that happened to help whoever was nearby; it is meant to be a
property of the roads instead.

There is now one server-wide switch, foliage.enabled, defaulting to on. That is
not a walk-back of the paragraph above: it is a setting for the server, not a
per-session arm for a member of staff, and nothing turns it on or off but a
deliberate change from the settings menu.

That removal is why the remaining gates matter more, not less. What still limits
it: only vehicles with a driver, only bushes the engine itself flags plus trees
at or below the foliage.maxTreeSize setting, never indoors, and never more than
MAX_KILLS_PER_PASS at a time.

There is no speed floor. That one was a guess and a self-defeating one -- see
the driver check. The tree size cutoff stays, but it is read off the game's own
LOGS_PER_SIZE table rather than picked; see clearable().

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

--- Persisted tally only. The on/off switch is a setting, not state kept here.
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
There are TWO kinds of roadside growth and they need different tests.

Decompiling IsoObject.isBush() settles what the engine means by "bush":

    sprite.tilesetName.equals("f_bushes_1") || sprite.getProperties().get("Bush") != null

That is the brown, flat bush. It is NOT a tree, which is why an instanceof
IsoTree test never saw one. The green sapling is the other thing: a genuine
IsoTree with a small getSize(), which isBush() returns false for.

So each of the last two selectors caught exactly one kind:
  1.12.1  instanceof IsoTree + getSize() <= N   ->  saplings only
  1.13.0  getBushes() / isBush()                ->  brown bushes only

1.13.0 was never published, which is the only reason this is not a regression
report. Neither test was wrong; each was half of the answer. This is the union.

A SIZE CUTOFF IS STILL NEEDED, BUT ONLY FOR TREES. isBush needs no threshold --
a bush sprite is a bush. Trees do, because "every IsoTree" would fell mature
oaks, which do not grow back inside a wipe.

WHERE THE CUTOFF COMES FROM, RATHER THAN A GUESS. IsoTree's static init builds
LOGS_PER_SIZE as an 8-entry array {1,1,2,3,4,5,6,8}, so getSize() runs 0..7 and
the log yield climbs with it. Sizes 0 and 1 both yield a single log -- saplings.
Size 2 yields two. By 3 and up you are felling something that gives 3, 4, 5, 6,
8 logs, which is a tree in every sense that matters.

So 2 is "young tree", and it is a real boundary in the game's own data rather
than a number picked because it felt safe. The count reports a full size
histogram of nearby trees INCLUDING those above the cutoff, so raising it is a
decision made against what is actually growing out there.
]]
--[[
Live settings -- `foliage.maxTreeSize` and `foliage.enabled`, which are the
FoliageMaxTreeSize and FoliageEnabled sandbox options. Functions rather than
locals so a change from the admin panel takes effect on the next pass instead of
the next publish.
]]
local function maxTreeSize()
    return (WabbajackSettings_get and WabbajackSettings_get("foliage.maxTreeSize")) or 2
end
local function foliageOn()
    if not WabbajackSettings_get then return true end   -- shipped default is on
    return WabbajackSettings_get("foliage.enabled") == true
end

--- A label when this object is roadside growth we clear, nil when it is not.
local function clearable(o)
    if not o then return nil end
    -- isBush is public on IsoObject, so it is safe on anything from a square.
    local ok, bush = pcall(function() return o:isBush() end)
    if ok and bush then return "bush" end
    if instanceof(o, "IsoTree") then
        local size = o:getSize()
        if size and size <= maxTreeSize() then return "tree" end
    end
    return nil
end

--[[
Counts, and optionally clears, roadside growth on one square.

Iterates the square's own object list rather than getBushes(), because
getBushes() is defined as exactly the isBush() subset -- it filters the same
list on that one test -- so using it would discard every sapling before this
code ever saw it.

Indoor squares are skipped outright. Vehicles do get inside buildings -- garages,
warehouses, the odd wall a player drove through -- and a potted plant in
somebody's base is not roadside growth.
]]
local function clearSquare(sq, cut, budget, tally)
    if not sq then return 0 end
    if sq:getRoom() then return 0 end            -- indoors, leave it alone

    local objs = sq:getObjects()
    if not objs or objs:size() == 0 then return 0 end

    local n = 0
    -- Backwards, because clearing mutates the square underneath us.
    for i = objs:size() - 1, 0, -1 do
        if n >= budget then break end
        local o = objs:get(i)
        local kind = clearable(o)
        if kind then
            if tally then tally[kind] = (tally[kind] or 0) + 1 end
            if not cut then
                n = n + 1
            elseif kind == "tree" then
                -- Damage() runs the engine's own destruction, which is what
                -- makes the removal reach clients AND drops vanilla's own
                -- yield -- the twigs and branch. See the header.
                if pcall(function() o:Damage(1000.0) end) then n = n + 1 end
            else
                -- A brown bush is not a tree: no yield to drop, and
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

--- The only gates are the tick divider and the foliage.enabled setting.
local function onTick()
    ticks = ticks + 1
    if ticks < TICK_EVERY then return end
    ticks = 0
    -- Checked here rather than inside pass(): switched off should cost the tick
    -- handler a table lookup, not a walk of every loaded vehicle's path.
    if not foliageOn() then return end
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
    local tally = {}
    local sizes = {}      -- every tree nearby by size, cutoff or not

    for x = px - COUNT_RADIUS, px + COUNT_RADIUS do
        for y = py - COUNT_RADIUS, py + COUNT_RADIUS do
            local sq = cell:getGridSquare(x, y, pz)
            if sq then
                -- Budget high enough not to cap a count: this reports, it does
                -- not cut, so the per-pass kill cap is meaningless here.
                local n = clearSquare(sq, false, math.huge, tally)
                if n > 0 then found = found + n; squares = squares + 1 end

                --[[
                Trees ABOVE the cutoff are surveyed too, and this is the whole
                point of the histogram: "nothing happened" and "that is a size 4
                and we deliberately leave those" look identical in game. Seeing
                the sizes that are actually out there is what turns raising
                foliage.maxTreeSize into a decision instead of another guess.
                ]]
                if not sq:getRoom() then
                    local objs = sq:getObjects()
                    if objs then
                        for i = 0, objs:size() - 1 do
                            local o = objs:get(i)
                            if o and instanceof(o, "IsoTree") then
                                local s = o:getSize()
                                if s then sizes[s] = (sizes[s] or 0) + 1 end
                            end
                        end
                    end
                end
            end
        end
    end

    local hist = {}
    for s = 0, 7 do
        if sizes[s] then hist[#hist + 1] = "size " .. s .. ":" .. sizes[s] end
    end
    local histText = (#hist > 0) and table.concat(hist, ", ") or "no trees"

    log("count by " .. tostring(player:getUsername()) .. " - "
        .. (tally.bush or 0) .. " bushes, " .. (tally.tree or 0)
        .. " young trees (<=" .. maxTreeSize() .. ") within "
        .. COUNT_RADIUS .. " tiles | all trees: " .. histText)

    return found, squares, (tally.bush or 0), (tally.tree or 0), histText
end

--- Running total since the mod was installed. There is no per-session "active"
--- to report -- only the foliage.enabled setting, which the settings menu shows.
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

-- ---------------------------------------------------------------- sweep

--[[
Staff-armed clearing of overgrowth, everywhere rather than under wheels.

WHY THIS EXISTS
Erosion on this server was set to reach full growth in 15 days rather than the
500 it ran at last season, and by day three the average map cell held two and a
half times the objects it used to (7,552 bytes against 3,020, measured against
the pre-wipe backup). That density is what the server pays for on every cell it
unloads, and unloading is where two thirds of its tick time goes. Turning
erosion off stops it getting worse; nothing in the game removes what already
grew. This does.

WHY IT RIDES LoadGridsquare RATHER THAN A TIMER
The same wall the ground sweep hit, and its file said it plainly: Lua can only
touch squares that are currently streamed. There is no "clear the map" from
inside the game. So this clears each square at the moment the server loads it,
which means it follows players around and cleans the routes people actually
drive -- which is exactly where the cost is felt.

WHAT IT COSTS WHEN IDLE
One table lookup per streamed square. That matters: LoadGridsquare handlers are
the single most expensive class of Lua on this server, ~18% of the simulation
thread across every mod that hooks it, so an idle handler here must be cheap
enough to disappear. `sweepActive()` returns on a nil field before it touches
the square. WabbajackRaids gates its own LoadGridsquare hook the same way and
profiles clean.

WHY IT EXPIRES ON ITS OWN
A forgotten sweep would keep felling every bush anybody drove past for the rest
of the wipe. It carries its own deadline and stops itself.
]]
local SWEEP_HOURS_DEFAULT = 6
-- Objects cleared per square per visit. A square rarely holds more, and a cap
-- means one pathological square cannot stall the streaming thread.
local SWEEP_BUDGET = 12

local function nowMs()
    return (getTimestampMs and getTimestampMs()) or (getTimestamp() * 1000)
end

--- The live sweep, or nil. Clears the record once it has expired.
local function sweepActive()
    local st = state()
    local s = st.foliageSweep
    if not s then return nil end
    if nowMs() >= (s.expires or 0) then
        log("sweep expired - cleared " .. tostring(s.cleared or 0) .. " objects")
        st.foliageSweep = nil
        return nil
    end
    return s
end

--- Arms a sweep. Hours is real time, not in-game.
function WabbajackFoliage_sweepStart(hours, whoName)
    local h = tonumber(hours) or SWEEP_HOURS_DEFAULT
    if h <= 0 then h = SWEEP_HOURS_DEFAULT end
    local st = state()
    st.foliageSweep = {
        expires = nowMs() + (h * 60 * 60 * 1000),
        cleared = 0,
        by = tostring(whoName or "?"),
    }
    log("sweep armed for " .. h .. "h by " .. tostring(whoName))
    return h
end

function WabbajackFoliage_sweepStop()
    local st = state()
    local n = st.foliageSweep and st.foliageSweep.cleared or 0
    st.foliageSweep = nil
    log("sweep stopped - cleared " .. tostring(n) .. " objects")
    return n
end

function WabbajackFoliage_sweepStatus()
    local s = sweepActive()
    if not s then return nil end
    return {
        cleared = s.cleared or 0,
        minutesLeft = math.max(0, math.floor(((s.expires or 0) - nowMs()) / 60000)),
        by = s.by,
    }
end

Events.LoadGridsquare.Add(function(sq)
    local s = sweepActive()
    if not s then return end
    if not sq then return end
    -- clearSquare already skips indoor squares and picks out bushes and
    -- saplings while leaving mature trees standing, so a sweep and a set of
    -- wheels remove exactly the same things.
    local n = clearSquare(sq, true, SWEEP_BUDGET, nil)
    if n > 0 then
        s.cleared = (s.cleared or 0) + n
        local st = state()
        st.felled = (st.felled or 0) + n
    end
end)

Events.OnTick.Add(onTick)
Events.EveryOneMinute.Add(tick)
-- No values in this line: settings are read at use, and reading one at load
-- would read it before the settings store is guaranteed to exist.
log("loaded - bushes and young trees, any speed, driver required")

--[[
The menu's channel for the foliage check.

Moved here from WabbajackSiege.lua when the toolkit was split. There is no arm
or stop - the module runs for every driven vehicle whenever foliage.enabled is
on. This is the diagnostic that remains, and it is the only way to check the
size threshold against the actual world.

WabbajackCore.reply rather than Say: the count once ran and logged its result
server-side while the admin who asked saw nothing, which reads as a dead
feature. Core sends both the halo and the note for exactly that reason.
]]
Events.OnClientCommand.Add(function(module, command, player, args)
    -- Sweep controls. Access is re-checked here for the same reason the count
    -- is: the menu hiding an entry is not a permission boundary.
    if command == "foliageSweepStart" or command == "foliageSweepStop"
        or command == "foliageSweepStatus" then
        if not WabbajackCore.allow("WabbajackFoliage", module, player) then return end

        if command == "foliageSweepStart" then
            local h = WabbajackFoliage_sweepStart(args and args.hours, player:getUsername())
            WabbajackCore.reply(player,
                "Overgrowth sweep armed for " .. h .. "h. Bushes and young trees now clear " ..
                "as areas load - drive the routes you want cleaned.")
        elseif command == "foliageSweepStop" then
            local n = WabbajackFoliage_sweepStop()
            WabbajackCore.reply(player, "Sweep stopped. " .. n .. " cleared this run.")
        else
            local s = WabbajackFoliage_sweepStatus()
            WabbajackCore.reply(player, s
                and ("Sweep running: " .. s.cleared .. " cleared, " ..
                     s.minutesLeft .. " min left (armed by " .. tostring(s.by) .. ").")
                or "No sweep is running.")
        end
        return
    end

    if command ~= "foliageCount" then return end
    if not WabbajackCore.allow("WabbajackFoliage", module, player) then return end

    local n, sq, bushes, trees, hist = WabbajackFoliage_count(player)
    local total = WabbajackFoliage_status and WabbajackFoliage_status() or 0
    -- Two lines: what would go, then what is standing. The second is the one
    -- that explains a survivor -- a size 4 is left on purpose.
    WabbajackCore.reply(player, bushes .. " bushes + " .. trees ..
        " young trees would go here (" .. n .. " on " .. sq .. " squares). " ..
        total .. " cleared server-wide.")
    WabbajackCore.reply(player, "Trees nearby: " .. tostring(hist))
end)
