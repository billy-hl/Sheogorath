--[[
Stop Beyond Ten's medical bonuses from throwing on a dedicated server.

THE BUG, as seen on wipe night 2026-08-28
Players could not bandage. Nor disinfect, splint, stitch, or dig out a bullet.
The server log filled with, once per attempt:

    attempted index: getPerkLevel of non-table: null
        Lua(Vanilla).new(ISApplyBandage.lua:177)
        Lua((MOD:Beyond Ten - Level 15 Skills)).name(ExtendedBonuses.lua:127)

Beyond Ten's ExtendedBonuses safeRequire()s the client TimedActions so it can
wrap their `new` and grant duration bonuses for Doctor levels past 10. On a
dedicated server that require succeeds -- the classes load -- but the server
constructs them without a real character, and vanilla line 177 is

    o.doctorLevel = character:getPerkLevel(Perks.Doctor)

so every medical action dies in the constructor before it can start.

WHY THIS CLEARS A HANDLER RATHER THAN UNWRAPPING
Beyond Ten's wrapper is deliberately indirect, and that is what makes this safe:

    local activeHandler = Ext.handlers[id]
    if type(activeHandler) ~= "function" then return original(...) end
    return activeHandler(original, ...)

Dropping the handler turns the wrapper into a pass-through to vanilla. Its
wrapper stays installed and stays in the call chain, so any other mod that
wrapped the same method still works, and Beyond Ten can reinstall over the top
without stacking. Deleting or restoring `owner[methodName]` ourselves would do
none of that -- it would silently evict whoever wrapped after them.

SERVER ONLY, ON PURPOSE
This file lives in media/lua/server, so it never reaches a client. On a client
the character is a real IsoPlayer, the bonus works, and levels past ten still
shorten the action -- which is the whole reason the mod is in the list. Players
keep the feature; only the server, where the bonus is meaningless because there
is no character to read a level from, stops trying to apply it.

LOAD ORDER MATTERS AND IS NOT LEFT TO CHANCE
Beyond Ten calls Ext.Install() at file load AND registers it on OnServerStarted.
Event handlers fire in registration order, so if we loaded first our clear would
run first and be undone a moment later. `BeyondTen` is therefore ordered ahead of
`WabbajackCore` in MOD_IDS. The EveryOneMinute sweep below is the belt to that
braces: if the order is ever changed back, this self-heals within a minute
instead of silently breaking wound care again.
]]

if not isServer() then return end

-- Every action Beyond Ten wraps in installMedicalBonuses(). The id it registers
-- is "medical.new." .. name; see wrapMethod() in ExtendedBonuses.lua.
local MEDICAL_ACTIONS = {
    "ISApplyBandage",
    "ISCleanBurn",
    "ISComfreyCataplasm",
    "ISDisinfect",
    "ISGarlicCataplasm",
    "ISPlantainCataplasm",
    "ISRemoveBullet",
    "ISRemoveGlass",
    "ISSplint",
    "ISStitch",
}

local announced = false

--- Drop Beyond Ten's medical handlers, leaving its wrappers as pass-throughs.
-- Returns how many were actually cleared, so the first call can say so once.
local function clearMedicalHandlers()
    local BT = rawget(_G, "BeyondTen")
    if type(BT) ~= "table" then return 0 end
    local Ext = BT.ExtendedBonuses
    if type(Ext) ~= "table" or type(Ext.handlers) ~= "table" then return 0 end

    local cleared = 0
    for _, name in ipairs(MEDICAL_ACTIONS) do
        local id = "medical.new." .. name
        if Ext.handlers[id] ~= nil then
            Ext.handlers[id] = nil
            cleared = cleared + 1
        end
    end

    if cleared > 0 and not announced then
        announced = true
        print("[WabbajackMedicalFix] neutralised " .. cleared ..
              " Beyond Ten medical wrapper(s) server-side - "
              .. "bandage/disinfect/splint/stitch now call vanilla directly.")
    end
    return cleared
end

-- At load, for the Ext.Install() that already ran when Beyond Ten's file loaded.
clearMedicalHandlers()

-- After the OnServerStarted reinstall. Registered later than Beyond Ten's own
-- handler because BeyondTen is ordered ahead of WabbajackCore in MOD_IDS.
if Events.OnServerStarted then
    Events.OnServerStarted.Add(clearMedicalHandlers)
end

-- Self-healing sweep. Costs ten table lookups a minute and means a future load
-- order change degrades to "broken for under a minute" rather than "broken".
if Events.EveryOneMinute then
    Events.EveryOneMinute.Add(clearMedicalHandlers)
end

print("[WabbajackMedicalFix] loaded.")
