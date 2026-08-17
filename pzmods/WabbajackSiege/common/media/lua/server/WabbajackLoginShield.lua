--[[
Login shield - five seconds of invisibility to zombies when you connect.

WHY
Measured, not guessed. After a restart on 2026-08-17 a player fully connected at
16:38:18 and was hit by a zombie at 16:38:20. Two seconds. He had logged out
clean thirty-four seconds into a sixty-second restart warning, spent twelve
minutes queueing and loading, and arrived back on the same tile with a zombie on
him. There is nothing a player can do about that, because it happens before
their client is responsive.

WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
Invisibility to zombies only, for five seconds. NOT god mode: the player is
still mortal, can still be hurt by anything else, and is still a target in PvP.
It buys them the moment they needed to see what is around them and step away.

Five seconds is also short enough that it cannot be used as a tactic. Relogging
in the middle of a horde would give you the time to take about two steps, and
the horde is still there when it lapses -- so there is nothing to farm, and no
need for the usual "cancel on move or attack" machinery that would come with a
longer window.

TWO TRAPS THIS AVOIDS
1. An admin who has deliberately turned invisibility on for themselves must not
   have it silently switched off five seconds after they log in. So a player who
   is ALREADY invisible on arrival is left alone.

2. That check, on its own, creates something worse. If a player logs out inside
   their five second window, the shield is never cleared -- and if invisibility
   survives into the save, they reconnect already invisible, get skipped by rule
   1, and stay invisible to zombies permanently. So the obligation is recorded
   in ModData rather than in a local: if we shielded somebody and never cleared
   it, we know on their next login that the invisibility is ours to remove, not
   an admin's to preserve.

Whether invisibility actually persists into the save is unverified either way --
nothing in the vanilla Lua touches it server-side. Rule 2 costs almost nothing
and makes the answer not matter.
]]

local SHIELD_SECONDS = 5
-- Ticks between polls. getOnlinePlayers() is cheap and this is ~4 times a
-- second, which is a fraction of the window; the player who prompted this was
-- hit two seconds in, so the detection delay has to be well under that.
local POLL_TICKS = 15
local MODDATA_KEY = "WabbajackLoginShield"

local function log(msg) print("[WabbajackShield] " .. tostring(msg)) end
local function state() return ModData.getOrCreate(MODDATA_KEY) end

--[[
Joins are detected by polling rather than by a join event.

Events.OnCreatePlayer is only ever hooked in media/lua/client in vanilla, so it
cannot be relied on to fire here, and there is no server-side per-player connect
event to use instead. Diffing getOnlinePlayers() against the previous poll needs
no event at all and cannot be wrong about who is actually present.
]]
local seen = {}        -- username -> true, present at the last poll
local expiry = {}      -- username -> real ms at which the shield lapses
local ticks = 0

local function nowMs()
    return (getTimestampMs and getTimestampMs()) or (getTimestamp() * 1000)
end

local function shield(player, name, owed)
    local ok, already = pcall(function() return player:isInvisible() end)
    if not ok then return end

    -- Already invisible and we do not owe them a clear: an admin turned it on
    -- deliberately. Leave it, and do not take on an obligation to remove it.
    if already and not owed then
        log(name .. " is already invisible - leaving it alone")
        return
    end

    if not pcall(function() player:setInvisible(true) end) then return end
    owed[name] = true
    expiry[name] = nowMs() + SHIELD_SECONDS * 1000
    log(name .. " shielded from zombies for " .. SHIELD_SECONDS .. "s")
end

local function lapse(player, name, owed)
    if player then pcall(function() player:setInvisible(false) end) end
    owed[name] = nil
    expiry[name] = nil
end

local function poll()
    local players = getOnlinePlayers()
    if not players then return end
    local st = state()
    st.owed = st.owed or {}
    local owed = st.owed

    local present = {}
    for i = 0, players:size() - 1 do
        local p = players:get(i)
        local ok, name = pcall(function() return p:getUsername() end)
        if ok and name then
            present[name] = p
            if not seen[name] then shield(p, name, owed) end
        end
    end

    local t = nowMs()
    for name, at in pairs(expiry) do
        if not present[name] then
            -- Logged out inside the window. The obligation in `owed` survives
            -- in ModData, so their next login clears it; see trap 2 above.
            expiry[name] = nil
            log(name .. " left while shielded - will be cleared on next login")
        elseif t >= at then
            lapse(present[name], name, owed)
        end
    end

    -- Anyone we owe a clear who is present but has no live timer: they logged
    -- out mid-shield previously and have now come back. shield() re-arms them
    -- with owed set, so this is only a safety net for a shield that failed to
    -- take.
    for name, _ in pairs(owed) do
        if present[name] and not expiry[name] then
            lapse(present[name], name, owed)
            log(name .. " had a stale shield from an earlier session - cleared")
        end
    end

    seen = present
end

Events.OnTick.Add(function()
    ticks = ticks + 1
    if ticks < POLL_TICKS then return end
    ticks = 0
    poll()
end)

log("loaded - " .. SHIELD_SECONDS .. "s zombie invisibility on login")
