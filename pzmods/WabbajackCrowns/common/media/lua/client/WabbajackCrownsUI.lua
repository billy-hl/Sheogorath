--[[
The player-facing half: seeing who holds what, and hearing when it changes.

WHY THIS IS WORTH BUILDING AT ALL
A crown nobody can see is a private stat. The whole mechanic depends on players
knowing who holds what, because the only route to a crown is through its holder
and you cannot hunt a name you were never told. The announcements are not
flavour - they are the feature working.

WHY THE CLIENT NEVER COMPUTES ANYTHING
Everything below draws a copy the server sent. There is no ranking, no claiming
and no "am I highest" check on this side, because a client that could work that
out is a client that could be persuaded it had won.

WHY ISModalRichText AND NOT A BESPOKE WINDOW
Thirty rows of text, read and dismissed. A custom ISCollapsableWindow would be
more code, more API surface that shifts between builds, and no more useful. The
one thing it would buy - staying open while you play - is not wanted here.
]]

if isServer() then return end

local state = {}   -- skill -> { username, level, claimedAt }

--[[
Skills worth listing first.

Crowns are not equal: the ones with bespoke powers are the ones people will
fight over, and burying them alphabetically among thirty entries hides the whole
point. This is presentation only - the server neither knows nor cares about the
order.
]]
local MARQUEE = { "Fitness", "Strength", "Sneak", "Maintenance",
                  "Cooking", "Doctor", "Nimble" }

local function isMarquee(skill)
    for _, s in ipairs(MARQUEE) do if s == skill then return true end end
    return false
end

local function line(skill, held)
    local who = held and held.username or nil
    if who then
        return string.format(" <RGB:1,0.84,0> %s <RGB:1,1,1> - %s (level %s)",
                             skill, who, tostring(held.level or "?"))
    end
    return string.format(" <RGB:0.5,0.5,0.5> %s - unclaimed", skill)
end

local function showCrowns()
    local held, vacant = {}, {}
    for skill, v in pairs(state) do
        if v then held[skill] = v end
    end

    local body = { "<CENTRE> <RGB:1,0.84,0> THE CROWNS <LINE> <RGB:1,1,1>",
                   "One per skill. One holder each. <LINE>",
                   "A crown moves only when its holder dies. <LINE> <LINE>" }

    body[#body + 1] = "<RGB:1,0.84,0> Crowns that grant a power <LINE> <RGB:1,1,1>"
    for _, skill in ipairs(MARQUEE) do
        body[#body + 1] = line(skill, held[skill]) .. " <LINE>"
    end

    local others = {}
    for skill, v in pairs(held) do
        if not isMarquee(skill) then others[#others + 1] = skill end
    end
    table.sort(others)
    if #others > 0 then
        body[#body + 1] = " <LINE> <RGB:1,0.84,0> Held elsewhere <LINE> <RGB:1,1,1>"
        for _, skill in ipairs(others) do
            body[#body + 1] = line(skill, held[skill]) .. " <LINE>"
        end
    end

    body[#body + 1] = " <LINE> <RGB:0.6,0.6,0.6> Out-levelling a holder earns you nothing."
        .. " <LINE> They have to die first."

    local modal = ISModalRichText:new(
        getCore():getScreenWidth() / 2 - 260, getCore():getScreenHeight() / 2 - 260,
        520, 520, table.concat(body), false)
    modal:initialise()
    modal:addToUIManager()
end

--[[
Right-click yourself to see them.

Deliberately on the player and not in a global menu: it puts the list one click
from wherever you are standing, and it matches how the rest of this mod's
player-facing entries are reached.
]]
local function onFillMenu(playerIndex, context, worldObjects)
    local player = getSpecificPlayer(playerIndex)
    if not player then return end
    context:addOption("The Crowns", nil, showCrowns)
end

Events.OnFillWorldObjectContextMenu.Add(onFillMenu)

--[[
Server messages.

"state" replaces the whole table rather than patching it. The table is thirty
short rows, sent rarely, and a full replace cannot drift out of sync the way a
sequence of deltas can if one is missed.
]]
Events.OnServerCommand.Add(function(module, command, args)
    if module ~= "WabbajackCrowns" then return end
    if command == "state" and args and args.crowns then
        state = args.crowns
    elseif command == "announce" and args and args.text then
        local player = getPlayer()
        if player then
            player:setHaloNote(args.text, 255, 215, 0, 400)
        end
        if ISChat and ISChat.instance and ISChat.addLineInChat then
            ISChat.addLineInChat(args.text)
        end
    end
end)
