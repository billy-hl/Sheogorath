--[[
Raid window - the server's answer to "is this base raidable right now?".

THE RULE
A safehouse is OPEN while anybody who lives there is online, and for five real
minutes after the last of them logs off. Otherwise it is PROTECTED. That is the
whole feature: raids land on people who can fight back, and the five minutes
mean logging out is not an escape from one already in progress.

Owner and members count equally. Vanilla does not - see the note in
WabbajackRaidGate.lua - and a rule that only counts the owner is an exploit
rather than a policy: a group seals a base permanently by making an alt whose
only job is to hold the deed and never log in.

WHY THE DECISION IS MADE HERE AND NOT ON THE CLIENT
The client cannot answer it. Every vanilla safehouse check runs client-side, and
the only roster a client has is GameClient.IDToPlayerMap, which holds the players
it has instantiated - the ones near enough to be drawn. "Is a member online
somewhere on the map" is a question only the server can answer, so the server
answers it and tells everyone. The client half does nothing but enforce.

WHY NOTHING IS PERSISTED
`lastSeen` is a plain table, so a server restart starts every base protected. It
is tempting to keep it in ModData, and it would be wrong: everyone is offline
across a restart, so a persisted window would hand raiders five free minutes on
every base in the world at 03:55 every morning. There is no raid in progress
during a restart, so there is nothing for the grace period to protect.

WHAT THIS DOES NOT TOUCH
Dismantling, destruction and trespass are left exactly as vanilla has them.
SafehouseAllowTrepass is already true and AllowDestructionBySledgehammer is
already true on this server, so walls come down either way; this is about what is
inside the containers.
]]

local MODULE = "WabbajackRaid"

--[[
The two things about this feature anybody would want to change -- whether it is
on, and how long the grace after the last logout is -- are settings, not
constants: `raid.enabled` and `raid.grace` in WabbajackSettingsSchema, set from
the staff right-click menu. They are read at the moment they are used, never
into a local at the top of this file, so a change from the menu takes effect on
the next poll rather than the next publish.
]]

--[[
Ticks between polls, at the ~60/s the login shield measured.

Two seconds. The poll decides when the five-minute grace STARTS, so its error
lands on the end of the window: a combat-logger gets somewhere between 5:00 and
5:00.03 rather than a flat 5:00, which is well inside what anybody could notice
or exploit. A per-minute event was the obvious alternative and would have made
that error a full minute in the raider's face.
]]
local POLL_TICKS = 120
-- Re-send the open set this often even when it has not changed, so a client
-- that missed a broadcast heals without anybody noticing. See the note on
-- fail-closed defaults in the client file: a client with no state protects
-- everything, which is safe but wrong.
local HEARTBEAT_TICKS = 60 * 60

--[[
Guarded the same way every other module guards its settings: if the store fails
to load, this falls back to the values the feature shipped with rather than
throwing inside the poll, thirty times a second. Protection ON with a five
minute grace is the shipped behaviour and the safe one.
]]
local function raidEnabled()
    if not WabbajackSettings_get then return true end
    return WabbajackSettings_get("raid.enabled") == true
end
local function graceMinutes()
    return (WabbajackSettings_get and WabbajackSettings_get("raid.grace")) or 5
end

local function log(msg) print("[WabbajackRaidWindow] " .. tostring(msg)) end

local function nowMs()
    return (getTimestampMs and getTimestampMs()) or (getTimestamp() * 1000)
end

-- key -> real ms at which the last member of that safehouse was last seen online
local lastSeen = {}
local published = nil      -- the last string broadcast, so we only speak on change
local ticks, heartbeat = 0, 0

--[[
The key both halves agree on.

Top-left corner rather than getOnlineID(). The id is a Cantor pairing of exactly
these two numbers so it carries no more information, and it is stored in a field
the client receives by sync rather than computes - one fewer thing that has to
have arrived intact for the gate to be right about a base.
]]
local function keyOf(safehouse)
    return tostring(safehouse:getX()) .. "," .. tostring(safehouse:getY())
end

--- Lowercased usernames of everyone online, for case-insensitive matching.
local function onlineNames()
    local out = {}
    local players = getOnlinePlayers()
    if not players then return out end
    for i = 0, players:size() - 1 do
        local p = players:get(i)
        local ok, name = pcall(function() return p:getUsername() end)
        if ok and name then out[string.lower(tostring(name))] = true end
    end
    return out
end

--[[
Whether anybody who lives at this safehouse is online.

Case-insensitive, unlike vanilla, which compares with String.equals and
ArrayList.contains. Account names on this server are entered by hand in three
different places - the whitelist, an invite, and the claim itself - and a base
that silently never opens because one of them differs by a capital letter is
indistinguishable from the feature being broken.
]]
local function anyoneHome(safehouse, online)
    local owner = safehouse.getOwner and safehouse:getOwner()
    if owner and online[string.lower(tostring(owner))] then return true end

    local players = safehouse.getPlayers and safehouse:getPlayers()
    if players then
        for i = 0, players:size() - 1 do
            local m = players:get(i)
            if m and online[string.lower(tostring(m))] then return true end
        end
    end
    return false
end

--[[
Recomputes the open set. Returns it as the wire string, or nil if unavailable.

The wire format is the keys of the open safehouses joined by ";" - "1234,5678;90,12".
Everything absent is protected, which makes the empty string a meaningful and
safe message rather than an ambiguous one: it says "protect everything", and it
is also what a client that has heard nothing at all already believes.
]]
local function recompute()
    local list = SafeHouse and SafeHouse.getSafehouseList and SafeHouse.getSafehouseList()
    if not list then return nil end

    --[[
    Switched off means vanilla, not "everything open". An empty set protects
    every base exactly as the server did before this feature existed, so the
    kill switch is safe to reach for mid-argument -- and `lastSeen` deliberately
    keeps updating below the return, so switching back on does not hand out a
    fresh grace period to every base on the map.
    ]]
    local enabled = raidEnabled()

    local online = onlineNames()
    local t = nowMs()
    local graceMs = graceMinutes() * 60 * 1000
    local open, live = {}, {}

    for i = 0, list:size() - 1 do
        local s = list:get(i)
        if s then
            local key = keyOf(s)
            live[key] = true
            if anyoneHome(s, online) then
                lastSeen[key] = t
                if enabled then table.insert(open, key) end
            elseif enabled and lastSeen[key] and (t - lastSeen[key]) < graceMs then
                table.insert(open, key)
            end
        end
    end

    -- Drop keys for safehouses that no longer exist. Claims are released and
    -- SafeHouseRemovalTime expires them at 168 hours, so without this the table
    -- only ever grows, and a new claim on the same corner would inherit a
    -- stranger's grace period.
    for key in pairs(lastSeen) do
        if not live[key] then lastSeen[key] = nil end
    end

    table.sort(open)   -- so an unchanged set always serialises identically
    return table.concat(open, ";")
end

local function broadcast(wire, player)
    if player then
        sendServerCommand(player, MODULE, "open", { keys = wire })
    else
        sendServerCommand(MODULE, "open", { keys = wire })
    end
end

local function poll()
    local wire = recompute()
    if not wire then return end

    heartbeat = heartbeat + POLL_TICKS
    if wire == published and heartbeat < HEARTBEAT_TICKS then return end

    if wire ~= published then
        local n = wire == "" and 0 or (select(2, wire:gsub(";", "")) + 1)
        log("open set changed: " .. n .. " safehouse(s) raidable")
    end
    published = wire
    heartbeat = 0
    broadcast(wire)
end

Events.OnTick.Add(function()
    ticks = ticks + 1
    if ticks < POLL_TICKS then return end
    ticks = 0
    poll()
end)

--[[
Client requests.

"sync" is a client that has just loaded in asking for the current set, because
until it hears one it protects everything. "gate" is that client reporting which
way its half managed to install itself, and it is here for one reason: the whole
feature rests on a Lua override of a Java static, and if that override ever stops
taking - a build change, a mod load order - every base on the server silently
reverts to permanently protected with nothing in any log to say so. This puts a
line in server-console.txt on every single login instead.
]]
Events.OnClientCommand.Add(function(module, command, player, args)
    if module ~= MODULE then return end
    if not player then return end

    if command == "sync" then
        local wire = published or recompute() or ""
        log(tostring(player:getUsername()) .. " asked for a sync, sent " ..
            (wire == "" and 0 or (select(2, wire:gsub(";", "")) + 1)) .. " key(s)")
        broadcast(wire, player)
        return
    end

    if command == "gate" then
        local how  = tostring((args and args.how) or "unknown")
        local keys = tostring((args and args.keys) or "?")
        local beat = tostring((args and args.beat) or "?")
        local line = tostring(player:getUsername()) ..
            " gate=" .. how .. " keys=" .. keys .. " beat=" .. beat
        if how == "failed" then
            log("WARNING: " .. line .. " - that client cannot open a base for a raid")
        elseif keys == "0" and (published or "") ~= "" then
            -- The client is talking to us, so client->server is fine; it just
            -- has nothing to show for the broadcasts we have been sending.
            -- This is the line that names server->client as the broken leg.
            log("WARNING: " .. line .. " - client has heard no open set, but one is published")
        else
            log(line)
        end
        return
    end
end)

-- No values in this line on purpose: settings are read at use, and reading one
-- here would be reading it at load, from a file whose load order relative to the
-- settings store is not something this mod controls.
log("loaded - bases open while anyone who lives there is online, plus the grace period")
