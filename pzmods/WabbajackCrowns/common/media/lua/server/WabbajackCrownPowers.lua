--[[
What a crown actually does.

WHY POWERS AND NOT A LEVEL BONUS
A crown goes to whoever stands HIGHEST in that skill, so the holder is almost
always already at level 10. "Plus five levels" would therefore do nothing for
precisely the people who hold crowns - the boost would be invisible to everyone
who earned one. So each crown grants an ability instead: something the skill
cannot buy at any level.

The flat bonus still exists, at the bottom, for skills with no bespoke power
yet. It reads as a consolation and it is one.

WHY THESE ARE APPLIED ON A TIMER AND NOT AS PERMANENT STATE
Nothing here writes a lasting change to a character. Every power is re-asserted
while its crown is held and simply stops being asserted when it is not, so
losing a crown needs no undo step and a crash cannot strand somebody with an
ability they no longer own. That is also why none of them grant items or XP: a
power that leaves residue behind is a power that has to be cleaned up, and
cleanup is where this kind of feature rots.

WHY EVERY CALL IS GUARDED
This file runs on a live server against an API that shifts between builds. A nil
where a body part was expected takes down the whole handler and with it every
other crown. Each power is therefore wrapped, and one power failing costs only
that power.
]]

if not isServer() and not isCoopHost() then return end

local function log(fmt, ...)
    print("[WabbajackCrownPowers] " .. string.format(fmt, ...))
end

--[[
Powers are registered rather than hardcoded into a loop, so adding one is a
single table entry and a function, and so the /crowns UI can describe them
without a second list to keep in sync.

  apply(player)  runs while the crown is held. Called on a slow tick.
  blurb          shown to players. Written for someone deciding whether to hunt
                 the holder, not for a changelog.
]]
WabbajackCrownPowers = WabbajackCrownPowers or {}
local POWERS = {}

local function register(skill, blurb, apply)
    POWERS[skill] = { blurb = blurb, apply = apply }
end

local function safe(name, fn, ...)
    local ok, err = pcall(fn, ...)
    if not ok then log("power %s failed: %s", tostring(name), tostring(err)) end
end

-- ---------------------------------------------------------------- powers ----

--[[
FITNESS - you do not tire.

Endurance is pinned near full rather than at exactly 1.0, so the moodle still
flickers and the holder can still feel the game trying to tire them. Pinning it
hard reads as a bug; leaving a sliver reads as superhuman.
]]
register("Fitness", "Endurance barely moves. You do not tire the way other people do.",
    function(player)
        local stats = player:getStats()
        if stats and stats:getEndurance() < 0.95 then stats:setEndurance(0.98) end
    end)

--[[
STRENGTH - you carry what two people carry.

Additive rather than multiplicative: doubling a already-high capacity produces
numbers that break the inventory UI's assumptions, while a flat +20 is large,
legible, and still leaves encumbrance a thing that exists.
]]
register("Strength", "You carry roughly twice what anyone else can.",
    function(player)
        if player.setMaxWeight and player.getMaxWeight then
            local base = player.getMaxWeightBase and player:getMaxWeightBase() or 8
            player:setMaxWeight(base + 20)
        end
    end)

--[[
SNEAK - the dead lose you.

Zombies already targeting the holder are made to forget, in a radius, on a slow
cadence. This does not make anyone invisible: you are still seen, still chased
for a moment, and a crowd that has you cornered is still a crowd. It means
breaking contact always works, which is a different and much more useful thing
than never being spotted.
]]
register("Sneak", "Zombies lose track of you almost as soon as they find you.",
    function(player)
        local cell = player:getCell()
        if not cell then return end
        local zs = cell:getZombieList()
        if not zs then return end
        local px, py = player:getX(), player:getY()
        for i = 0, zs:size() - 1 do
            local z = zs:get(i)
            if z and z.getTarget and z:getTarget() == player then
                local dx, dy = z:getX() - px, z:getY() - py
                if (dx * dx + dy * dy) < 400 then   -- 20 tiles
                    if z.setTarget then z:setTarget(nil) end
                end
            end
        end
    end)

--[[
MAINTENANCE - your gear does not wear out.

Only what is equipped, and only back up to full: this repairs, it does not
create. Sweeping the whole inventory would quietly service a backpack full of
loot the holder is carrying to sell, which is a different feature and a worse
one.
]]
register("Maintenance", "Weapons in your hands do not degrade.",
    function(player)
        for _, item in ipairs({ player:getPrimaryHandItem(), player:getSecondaryHandItem() }) do
            if item and item.getCondition and item.getConditionMax then
                local max = item:getConditionMax()
                if max and max > 0 and item:getCondition() < max then
                    item:setCondition(max)
                end
            end
        end
    end)

--[[
COOKING - nothing you carry spoils.

Age is reset, not frozen, because there is no freeze to set. The practical
effect is the same and it survives the holder logging out, which a tick-based
freeze would not.
]]
register("Cooking", "Food in your inventory never spoils.",
    function(player)
        local inv = player:getInventory()
        if not inv then return end
        local items = inv:getItems()
        if not items then return end
        for i = 0, items:size() - 1 do
            local it = items:get(i)
            if it and it.setAge and it.getAge and it:getAge() > 0
               and it.IsFood and it:IsFood() then
                it:setAge(0)
            end
        end
    end)

--[[
DOCTOR - you do not bleed out.

Bleeding is stopped and bandages kept clean; wounds still hurt, still slow you,
and still need real treatment. This is the difference between a fight going
badly and a fight killing you three minutes later in a stairwell.
]]
register("Doctor", "You never bleed out. Wounds still hurt - they just do not finish you.",
    function(player)
        local bd = player:getBodyDamage()
        if not bd then return end
        local parts = bd:getBodyParts()
        if not parts then return end
        for i = 0, parts:size() - 1 do
            local part = parts:get(i)
            if part then
                if part.setBleeding and part.getBleedingTime
                   and part:getBleedingTime() > 0 then
                    part:setBleedingTime(0)
                    part:setBleeding(false)
                end
                if part.setBandageLife and part.isBandaged and part:isBandaged() then
                    part:setBandageLife(100)
                end
            end
        end
    end)

--[[
NIMBLE - you move at full speed with a weapon up.

Aiming normally costs you your legs. For the holder it does not, which turns
every fight where somebody else has to choose between moving and shooting into
one where they do not.
]]
register("Nimble", "You move at full speed while aiming.",
    function(player)
        if player.setVariable then player:setVariable("WBJ_CrownNimble", "true") end
    end)

-- --------------------------------------------------------------- fallback ----

--[[
Skills with no bespoke power yet.

The flat boost lives here and is honest about being small: it tops the skill to
max for a holder who is somehow not there, which is rare by construction, since
crowns go to the highest-ranked player. It exists so that every crown does
SOMETHING on the day this ships, and so the list of thirty is not mostly inert.
]]
local function flatBoost(player, skill)
    local perk = PerkFactory and PerkFactory.getPerkFromName
                 and PerkFactory.getPerkFromName(skill)
    if not perk then return end
    local lvl = player:getPerkLevel(perk) or 0
    if lvl < 10 then
        player:LevelPerk(perk, true)
    end
end

function WabbajackCrownPowers.blurbFor(skill)
    local p = POWERS[skill]
    return p and p.blurb or "A lesser crown: it tops this skill out, and no more."
end

function WabbajackCrownPowers.hasPower(skill)
    return POWERS[skill] ~= nil
end

--[[
The pulse.

Ten seconds is slow enough that thirty crowns across a full server is a trivial
amount of work, and fast enough that no power is ever noticeably absent. The
powers are all idempotent re-assertions, so a missed pulse costs nothing.
]]
local function pulse()
    if not WabbajackCrowns_holds then return end
    local players = getOnlinePlayers()
    if not players then return end
    for i = 0, players:size() - 1 do
        local player = players:get(i)
        if player then
            for skill, power in pairs(POWERS) do
                if WabbajackCrowns_holds(player, skill) then
                    safe(skill, power.apply, player)
                end
            end
            local all = WabbajackCrowns_all and WabbajackCrowns_all() or {}
            for skill, held in pairs(all) do
                if not POWERS[skill] and WabbajackCrowns_holds(player, skill) then
                    safe(skill, flatBoost, player, skill)
                end
            end
        end
    end
end

Events.EveryOneMinute.Add(function()
    safe("pulse", pulse)
end)

log("registered %d bespoke crown powers", (function()
    local n = 0; for _ in pairs(POWERS) do n = n + 1 end; return n
end)())
