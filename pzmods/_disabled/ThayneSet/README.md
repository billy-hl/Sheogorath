# The Thayne set — pulled from the Arsenal 2026-09-02

Removed from `WabbajackArsenal` after four failed fixes on the live server.

## The symptom

Wearing any piece threw, server-side, every time:

    SyncClothingPacket$ItemDescription.<init>
      -> InventoryItem.getVisual() == null -> .getTint() NPE

Items existed, icons rendered, and all five populated 152 loot tables. Only the
visual was missing — so anything that synced a worn piece, or drew one lying on
the ground, failed. A dropped piece corrupted the tile it sat on.

## The cause, as far as the evidence goes

**A mod's clothingItem XML cannot reliably reference a vanilla skinned mesh on a
dedicated server.** Checked against every clothing mod on that server:

    SkullysDufflesAndRigs   own mesh (skinned\backpacks\m_duffelbag_lb)   22 worn in-world
    alicesWeaponSling       own mesh (skinned\clothes\sling_m)            17 worn in-world
    82oshkoshM911           REUSES vanilla bob_hoodieup                    0 worn in-world

Every mod proven to work ships its own geometry. The only one reusing a vanilla
mesh has no in-world usage at all — it was never evidence the technique works,
and was almost certainly broken in the same way.

## Four things tried that were NOT the cause

1. `m_AltMaleModel`/`m_AltFemaleModel` — vanilla ships them, no working mod does.
   Removing them changed nothing (1.31.1 still threw).
2. Missing `WorldStaticModel` — added to three pieces. No effect.
3. `common/media/clothing/` not being scanned — the XMLs were duplicated to
   `<mod>/media/clothing/`. No effect.
4. `Type = Clothing` instead of `ItemType = base:clothing` — actively harmful.
   It produced items that silently did not exist: `additem` returned nothing
   while the control item (CelestialShovel) granted fine.

## To revive this

The textures, icons, item script, loot Lua and clothingItem XMLs are all here and
all valid. What is missing is geometry: each garment needs a real exported mesh
rather than a pointer at a vanilla one.

Test it in local single player first. This was developed straight onto a live
server with players on it, which is how four bad fixes reached production and how
a dropped item ate a tile.
