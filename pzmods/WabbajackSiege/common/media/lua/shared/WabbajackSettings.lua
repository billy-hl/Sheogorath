--[[
The settings accessor.

Every module in this mod reads its settings through WabbajackSettings_get(key),
and that has not changed. What changed is what sits behind it: settings now live
in sandbox options, edited at Admin Panel -> Sandbox Options -> Wabbajack Server
Toolkit, instead of in a bespoke ModData store driven by a generated right-click
submenu.

WHY THE OLD STORE IS GONE
It was a private reimplementation of something the game already does. It carried
its own persistence, its own wire format, its own staff check, its own value
whitelist and its own client-side cache, and every one of those was a thing that
could be wrong on its own. Sandbox options are how the other hundred mods on
this server expose settings, they persist with the save, they are already
staff-gated by the admin panel, and the whole apparatus above collapses into the
table below.

The right-click menu is events only now. That is the other half of the same
change: arming a siege is an action, and belongs on the thing you are pointing
at; "how long does siege loot last" is configuration, and belongs where the rest
of this server's configuration is.

READ AT USE, NEVER AT LOAD
Unchanged, and still the rule. Modules call this at the moment they need the
number. A value read into a local at the top of a file stops tracking the admin
panel, and there is no guaranteed load order between the Lua files in this mod.

NO MEMO ANY MORE
The old accessor cached, because each miss was a ModData call across into Java
and the sweep and the foliage pass both read settings from genuinely hot loops.
SandboxVars is a plain Lua table that Java fills once at load, so a read is a
table lookup and a cache would only be somewhere for a stale value to hide.

DEFAULTS LIVE IN sandbox-options.txt, NOT HERE
The fallbacks below are reached only when SandboxVars is missing entirely - a
load-order accident, or this file running somewhere the sandbox never loaded.
They exist so a module asking for a number in a tick handler gets one instead of
a nil. sandbox-options.txt is the source of truth and the two must agree.
]]

--[[
Dotted key -> sandbox option name, plus the last-resort fallback.

The dotted keys are kept exactly as they were so that no call site had to
change. Sandbox option names cannot carry a dot beyond the page prefix, hence
the two spellings.
]]
local FIELDS = {
    ["raid.enabled"]            = { field = "RaidProtectionEnabled",      fallback = true },
    ["raid.grace"]              = { field = "RaidProtectionGraceMinutes", fallback = 5 },
    ["shield.enabled"]          = { field = "LoginShieldEnabled",           fallback = true },
    ["shield.seconds"]          = { field = "LoginShieldSeconds",           fallback = 5 },
    ["foliage.enabled"]         = { field = "RoadsideFoliageEnabled",          fallback = true },
    ["foliage.maxTreeSize"]     = { field = "RoadsideFoliageMaxTreeSize",      fallback = 2 },
    ["sweep.safeBuffer"]        = { field = "GroundSweepSafeBuffer",         fallback = 30 },
    ["sweep.expireHours"]       = { field = "GroundSweepExpireHours",        fallback = 6 },
    ["baseraid.nightInterval"]  = { field = "BaseRaidNightInterval",   fallback = 1 },
    ["baseraid.nightHour"]      = { field = "BaseRaidNightHour",       fallback = 22 },
    ["baseraid.autoPerPlayer"]  = { field = "BaseRaidAutoPerPlayer",   fallback = 40 },
    ["baseraid.clusters"]       = { field = "BaseRaidClusters",        fallback = 8 },
    ["baseraid.playerClearance"] = { field = "BaseRaidPlayerClearance", fallback = 12 },
    ["siege.lootMinutes"]       = { field = "SiegeLootMinutes",        fallback = 9 },
    ["siege.cleanupMinutes"]    = { field = "SiegeCleanupMinutes",     fallback = 2 },
    ["siege.maxEventMinutes"]   = { field = "SiegeMaxEventMinutes",    fallback = 120 },
    ["siege.fillPercent"]       = { field = "SiegeFillPercent",        fallback = 60 },
    ["siege.airdropMinutes"]    = { field = "SiegeAirdropMinutes",     fallback = 30 },
    ["gather.maxTransfers"]     = { field = "GatherMaxTransfers",      fallback = 40 },
    ["gather.overfillPercent"]  = { field = "GatherOverfillPercent",   fallback = 150 },
    ["world.realMinutesPerDay"] = { field = "WorldRealMinutesPerDay",  fallback = 120 },

}

--[[
The live value of a setting.

An unknown key returns nil rather than throwing, because the thing asking is
usually a tick handler and a throw there is thirty a second in the log.
]]
function WabbajackSettings_get(key)
    local spec = FIELDS[key]
    if not spec then return nil end

    local vars = SandboxVars and SandboxVars.WabbajackSiege
    if not vars then return spec.fallback end

    local value = vars[spec.field]
    if value == nil then return spec.fallback end
    return value
end

--[[
The same answer, under the name the client half already calls.

This file is in shared/ precisely so there is one implementation rather than a
server store and a client cache kept in step over the wire. The engine syncs
SandboxVars to clients, so the client reads the same table the server does and
the sync, the wire format and the "has it arrived yet" question all stop
existing. WabbajackGather calls this; nothing has to change there.
]]
WabbajackSettings_client = WabbajackSettings_get
