--[[
The crown ledger: one crown per skill, one holder each, server-wide.

THE RULE, AND WHY IT IS THE INTERESTING ONE
A crown is awarded to whoever stands highest in that skill. It is NOT taken back
when somebody out-levels the holder. It moves on one event only: the holder
dies. Then it passes to the next highest.

That single choice is what makes this a server feature instead of a leaderboard.
PvP is always on here, so a crown holder is not merely ranked - they are the
only route to that crown for everybody below them. Somebody wearing all thirty
is the most hunted survivor in Knox County, and the only way down is through
them. A "highest level wins, continuously" rule would have produced a scoreboard
nobody fights over.

WHY THERE IS A LEDGER AND NOT JUST A LOOK AT WHO IS ONLINE
"The next highest player on the server" has to include people who are logged
off, or a crown would hop to whoever happened to be standing around when the
holder died, and a player could lose their claim by being asleep. Lua can only
see online players, so this file keeps its own record: every player's best-seen
level per skill, written while they are connected and kept afterwards. Ranking
reads the ledger, so an offline veteran still outranks an online novice.

WHY THE SERVER IS THE ONLY WRITER
Everything here runs server-side and the table lives in global mod data, which
persists with the save. Clients are sent a read-only copy to draw with. A client
that could write its own crowns would be a client that could award itself all
thirty.

WHY isServer() IS CHECKED AND NOT ASSUMED
media/lua/server is not a guarantee - it is a convention the game mostly honours.
In single player, and in a co-op host's process, these files run alongside the
client. Every entry point below no-ops unless this really is the authority, so a
host playing on their own server cannot end up with two writers.
]]

if not isServer() and not isCoopHost() then return end

local MODDATA_KEY = "WabbajackCrowns"

--[[
How long a crown survives its holder's absence.

Seven days, deliberately the same number as a safehouse claim lapse, because it
is the same promise: hold a thing by turning up. The stated rule is "only death
moves a crown", and for anybody actually playing that still holds exactly. This
covers the other case - somebody quits the server holding five crowns, and those
five are otherwise dead to everyone forever, unreachable because the one way to
take them is to kill a player who will never log in again.
]]
local DEFAULT_IDLE_DAYS = 7

--[[
Read at use, never at load. Same rule as the rest of this mod: a value pulled
into a local at file scope stops tracking the admin panel, and there is no
guaranteed load order between Lua files here.
]]
local function setting(key, fallback)
    if WabbajackSettings_get then
        local v = WabbajackSettings_get(key)
        if v ~= nil then return v end
    end
    return fallback
end

local function log(fmt, ...)
    print("[WabbajackCrowns] " .. string.format(fmt, ...))
end

--[[
The store.

  crowns[skill]  = { steamid, username, claimedAt (ms) }
  ledger[steamid] = { username, lastSeen (ms), levels = { [skill] = n } }

getOrCreate hands back the same table every call and the engine persists it, so
there is no save step and no write-back to forget.
]]
local function store()
    local d = ModData.getOrCreate(MODDATA_KEY)
    d.crowns = d.crowns or {}
    d.ledger = d.ledger or {}
    return d
end

local function nowMs()
    return getTimestampMs and getTimestampMs() or (getTimestamp() * 1000)
end

--[[
Every skill the running build actually has, asked of the game rather than
hardcoded.

PerkFactory.PerkList is the engine's own list, so a build that adds Tracking or
renames a perk is followed for free. A hardcoded table would silently stop
awarding a crown for anything added after this file was written, and silently
keep one for anything removed.

Passive perks are skipped: they are not skills anybody trains toward in the
sense this feature means, and a Fitness crown awarded for a starting trait would
be noise.
]]
local function allSkills()
    local out = {}
    local list = PerkFactory and PerkFactory.PerkList
    if not list then return out end
    for i = 0, list:size() - 1 do
        local perk = list:get(i)
        if perk and not perk:isPassiv() then
            local name = perk:getId()
            if name and name ~= "" then out[#out + 1] = name end
        end
    end
    return out
end

local function perkFromName(name)
    if not (Perks and PerkFactory) then return nil end
    return PerkFactory.getPerkFromName and PerkFactory.getPerkFromName(name) or Perks[name]
end

local function steamIdOf(player)
    if not player then return nil end
    local id = player.getSteamID and player:getSteamID()
    if id and tostring(id) ~= "0" then return tostring(id) end
    -- Non-Steam servers still need a stable key; the username is the only other
    -- thing that survives a reconnect.
    return "name:" .. tostring(player:getUsername())
end

--[[
Record what a player currently has, so ranking can see them after they log off.

Levels only ever move up in the ledger. A death resets the character to zero,
and if that zero were written the dead player's replacement would instantly rank
below everyone - which is correct - but the ledger is also how we rank people
who are NOT here, and a stale zero from a death months ago is worse than a stale
high from last week. releaseFor() clears the entry on death instead, which is
the honest place to handle it.
]]
local function remember(player)
    if not player then return end
    local id = steamIdOf(player)
    if not id then return end
    local d = store()
    local row = d.ledger[id] or { levels = {} }
    row.username = player:getUsername()
    row.lastSeen = nowMs()
    row.levels = row.levels or {}
    for _, skill in ipairs(allSkills()) do
        local perk = perkFromName(skill)
        if perk then
            local lvl = player:getPerkLevel(perk) or 0
            if lvl > (row.levels[skill] or -1) then row.levels[skill] = lvl end
        end
    end
    d.ledger[id] = row
end

--[[
Who should hold this crown, ignoring whoever holds it now.

Ranked on the ledger so offline players count. Ties break on the most recently
seen player, which quietly favours somebody still playing over a name from
weeks ago - the alternative is a coin toss that can flip every time the function
runs.

Level 0 never qualifies. A crown for a skill nobody has trained should sit
vacant and visibly unclaimed rather than being handed to an arbitrary beginner.
]]
local function bestFor(skill, excludeId)
    local d = store()
    local bestId, bestRow, bestLvl = nil, nil, 0
    for id, row in pairs(d.ledger) do
        if id ~= excludeId then
            local lvl = (row.levels or {})[skill] or 0
            if lvl > bestLvl
               or (lvl == bestLvl and lvl > 0 and bestRow
                   and (row.lastSeen or 0) > (bestRow.lastSeen or 0)) then
                bestId, bestRow, bestLvl = id, row, lvl
            end
        end
    end
    if bestLvl <= 0 then return nil end
    return bestId, bestRow, bestLvl
end

--[[
Tell the world. Kept in one place so the wording is identical everywhere and so
there is a single seam for the Discord bot to read later.
]]
local function announce(msg)
    log("%s", msg)
    if isServer() then
        local players = getOnlinePlayers()
        if players then
            for i = 0, players:size() - 1 do
                local p = players:get(i)
                if p then
                    sendServerCommand(p, "WabbajackCrowns", "announce", { text = msg })
                end
            end
        end
    end
end

local function pushState()
    if not isServer() then return end
    local d = store()
    local players = getOnlinePlayers()
    if not players then return end
    for i = 0, players:size() - 1 do
        local p = players:get(i)
        if p then sendServerCommand(p, "WabbajackCrowns", "state", { crowns = d.crowns }) end
    end
end

--[[
Award any crown that currently has no holder.

Deliberately only fills vacancies. It never re-examines a held crown, because
that is the rule: out-levelling the holder earns you nothing until they die.
]]
local function fillVacancies(reason)
    local d = store()
    local changed = false
    for _, skill in ipairs(allSkills()) do
        if not d.crowns[skill] then
            local id, row, lvl = bestFor(skill, nil)
            if id then
                d.crowns[skill] = { steamid = id, username = row.username,
                                    claimedAt = nowMs(), level = lvl }
                changed = true
                announce(string.format("%s claims the %s Crown (level %d).",
                                       row.username or "Someone", skill, lvl))
            end
        end
    end
    if changed then pushState() end
    return changed
end

--[[
Release every crown a player holds and pass each to the next in line.

Called on death, and on the idle sweep. The old holder is excluded from the
re-award explicitly rather than relying on their ledger row already being gone,
so the same function is correct for both callers.
]]
local function releaseFor(id, username, why)
    local d = store()
    local moved = 0
    for _, skill in ipairs(allSkills()) do
        local held = d.crowns[skill]
        if held and held.steamid == id then
            d.crowns[skill] = nil
            local nid, nrow, nlvl = bestFor(skill, id)
            if nid then
                d.crowns[skill] = { steamid = nid, username = nrow.username,
                                    claimedAt = nowMs(), level = nlvl }
                announce(string.format("%s %s - the %s Crown passes to %s (level %d).",
                                       username or "A survivor", why, skill,
                                       nrow.username or "someone", nlvl))
            else
                announce(string.format("%s %s - the %s Crown is vacant.",
                                       username or "A survivor", why, skill))
            end
            moved = moved + 1
        end
    end
    if moved > 0 then pushState() end
    return moved
end

-- ---------------------------------------------------------------- events ----

--[[
Death is the only thing that moves a held crown.

The ledger row is cleared as well as the crowns released: the character is gone,
and leaving their levels behind would let a dead player keep outranking the
living for the next crown that falls vacant.
]]
local function onDeath(character)
    if not character or not instanceof(character, "IsoPlayer") then return end
    local id = steamIdOf(character)
    if not id then return end
    local d = store()
    local username = character:getUsername()
    releaseFor(id, username, "has died")
    d.ledger[id] = nil
    fillVacancies("death")
end

local function onLevelUp(player)
    if not player then return end
    remember(player)
    fillVacancies("levelup")
end

local function onConnect(player)
    if not player then return end
    remember(player)
    fillVacancies("login")
    pushState()
end

--[[
The idle sweep. See DEFAULT_IDLE_DAYS for why this exists at all.
]]
local function sweepIdle()
    local days = tonumber(setting("crowns.idleDays", DEFAULT_IDLE_DAYS)) or DEFAULT_IDLE_DAYS
    if days <= 0 then return end
    local cutoff = nowMs() - (days * 24 * 60 * 60 * 1000)
    local d = store()
    for _, skill in ipairs(allSkills()) do
        local held = d.crowns[skill]
        if held then
            local row = d.ledger[held.steamid]
            local seen = row and row.lastSeen or held.claimedAt or 0
            if seen < cutoff then
                releaseFor(held.steamid, held.username,
                           string.format("has not been seen for %d days", days))
            end
        end
    end
    fillVacancies("idle sweep")
end

--[[
Keep the ledger current for everybody online.

Every ten minutes rather than on a tick: this walks every online player against
every skill, and the numbers it is chasing move slowly. The login and level-up
hooks catch anything that matters sooner.
]]
local function tenMinutes()
    local players = getOnlinePlayers()
    if players then
        for i = 0, players:size() - 1 do
            remember(players:get(i))
        end
    end
    sweepIdle()
    fillVacancies("periodic")
end

Events.OnCharacterDeath.Add(onDeath)
Events.LevelPerk.Add(function(player) onLevelUp(player) end)
Events.OnServerStarted.Add(function() log("armed") end)
Events.EveryTenMinutes.Add(tenMinutes)
if Events.OnConnected then Events.OnConnected.Add(onConnect) end
Events.OnCreatePlayer.Add(function(_, player) onConnect(player) end)

--[[
Read-only accessors for the rest of the mod.

The powers file needs to ask "does this player hold this crown?" on hot paths,
so it gets a direct answer rather than a copy of the table to search.
]]
function WabbajackCrowns_holds(player, skill)
    if not player or not skill then return false end
    local held = store().crowns[skill]
    return held ~= nil and held.steamid == steamIdOf(player)
end

function WabbajackCrowns_all()
    return store().crowns
end

function WabbajackCrowns_holderOf(skill)
    return store().crowns[skill]
end

--[[
Admin escape hatch. A feature this sticky needs a way to be unstuck by hand when
a name changes, an account is replaced, or a test leaves a crown somewhere silly.
]]
function WabbajackCrowns_forceRelease(skill)
    local d = store()
    local held = d.crowns[skill]
    if not held then return false end
    releaseFor(held.steamid, held.username, "was stripped by staff")
    fillVacancies("admin")
    return true
end
