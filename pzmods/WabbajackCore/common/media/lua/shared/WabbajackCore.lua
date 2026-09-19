--[[
Wabbajack Core - the pieces every Wabbajack mod needs and none of them should
own.

WHY THIS FILE EXISTS
The toolkit used to be one mod, so "who is staff" and "how do we answer an
admin" were locals inside WabbajackSiege.lua and everything else reached them
by being in the same file. Split into separate mods, that stops working: each
mod would need its own copy, and a permission allowlist that exists in four
copies is a permission allowlist that will disagree with itself. It lives here
once.

SHARED, NOT SERVER. The admin menu is client-side and hides itself from
non-staff; the command handlers are server-side and re-check. Both need
isStaff, so this is lua/shared and loads into both states.

EVERY OTHER WABBAJACK MOD DEPENDS ON THIS ONE. Their mod.info carries
require=WabbajackCore. A feature mod without Core loaded will not silently
half-work - it will not load at all, which is the failure you want.
]]

WabbajackCore = WabbajackCore or {}

-- Which Wabbajack feature mods are installed. Each one sets its own flag from a
-- marker in its lua/shared; declared here so the admin menu can read it safely
-- even when every feature mod is switched off.
WabbajackCore.present = WabbajackCore.present or {}

--[[
Who may arm events.

ACCOUNT USERNAMES, not character names. getUsername() is the account -- the same
name the logs and the Discord bridge use; the RP character name lives only in
players.db and is not a permission handle.

DELIBERATELY AN ALLOWLIST, NOT A ROLE CHECK. This used to admit every
admin/moderator/gm/overseer, and that is the wrong grain: `admin` is not a small
group on this server, and arming a siege places hundreds of zombies that
ZombieRespawn=None means nobody can ever take back. Adding somebody is editing
this line and publishing, which is the friction this deserves.

Compared LOWERCASED, and that is not fussiness. Account names on this server are
typed by hand in three separate places, and a previous version of this check
compared against "Admin" capitalised while the role table stores `admin` -- so
the menu was invisible to everybody, including the owner. A permission test that
fails closed on a capital letter is indistinguishable from the mod being broken.

BOTH of the owner's accounts are listed, because they are two separate accounts
in the whitelist and only one of them is staff: `Allisteras` is role 2 (a plain
user, and the one actually played on) and `AllisterasAdmin` is role 7. Listing
only the admin account would mean the menu never appearing during normal play;
listing only the play account would mean it missing from the account staff work
is done on. Drop whichever is not wanted.

THIS IS NOW THE ONLY COPY. It used to be a local in WabbajackSiege.lua. Any mod
that gates on staff calls WabbajackCore.isStaff and does not keep its own list.
]]
WabbajackCore.EVENT_HOSTS = { allisteras = true, allisterasadmin = true }

function WabbajackCore.isStaff(player)
    if not player or not player.getUsername then return false end
    local ok, name = pcall(function() return player:getUsername() end)
    if not ok or not name then return false end
    return WabbajackCore.EVENT_HOSTS[string.lower(tostring(name))] == true
end

function WabbajackCore.accessLevel(player)
    if not player or not player.getAccessLevel then return "" end
    local ok, lvl = pcall(function() return player:getAccessLevel() end)
    if not ok or not lvl then return "" end
    return string.lower(tostring(lvl))
end

function WabbajackCore.log(tag, msg)
    print("[" .. tostring(tag) .. "] " .. tostring(msg))
end

--[[
Answer one admin, visibly.

Say() alone has proven not to be enough: the foliage count ran and logged its
result server-side while the admin who asked saw nothing, which reads as a dead
feature. Both channels are used because it is not worth another round of
guessing which one carries -- Say costs nothing when the halo note is what
actually lands.

Server-side only in practice, but harmless to call from anywhere.
]]
function WabbajackCore.reply(player, text)
    if not player then return end
    pcall(function() player:Say(text) end)
    pcall(function()
        sendServerCommand(player, "WabbajackSiege", "adminNote", { text = text })
    end)
end

--[[
The shared gate every admin command handler starts with.

Access is re-checked SERVER SIDE, not trusted from the client. The menu hides
itself from non-staff, but hiding a menu is not a permission check -- a modified
client can send whatever it likes, and arming a siege spawns hundreds of
permanent zombies.

Returns true when the command should be handled.
]]
function WabbajackCore.allow(tag, module, player)
    if module ~= "WabbajackSiege" then return false end
    if not player then return false end
    if not WabbajackCore.isStaff(player) then
        WabbajackCore.log(tag, "refused a command from " ..
            tostring(player.getUsername and player:getUsername()) ..
            " (access=" .. WabbajackCore.accessLevel(player) .. ")")
        return false
    end
    return true
end

--[[
THE COMMAND CHANNEL NAME IS STILL "WabbajackSiege".

Same reasoning as the sandbox option names: it is a wire protocol shared by the
client menu and every server handler, and renaming it to match the new mod ids
would break the menu against any server or client still on the old build for
exactly no benefit. It is a string, not a description.
]]
WabbajackCore.CHANNEL = "WabbajackSiege"
