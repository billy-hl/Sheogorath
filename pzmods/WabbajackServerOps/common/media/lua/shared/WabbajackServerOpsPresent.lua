--[[
Presence marker. One line of substance, and it earns its file.

lua/shared loads into BOTH the client and the server state, which lua/server
does not. That is the whole trick: the Wabbajack admin menu is client-side and
cannot see this mod's server globals, so without a marker it would have to draw
its entries blindly and let an absent mod answer with silence. This lets the
menu leave the entry out instead.

Guarded because load order between mods is not guaranteed - if this happens to
run before WabbajackCore, it creates the table rather than throwing.
]]
WabbajackCore = WabbajackCore or {}
WabbajackCore.present = WabbajackCore.present or {}
WabbajackCore.present.serverOps = true
