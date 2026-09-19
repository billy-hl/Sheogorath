# Why this sits beside common/ instead of inside it

Everything else in this mod lives under `common/`, which is the B42 multi-version
layout and works for scripts, Lua and textures.

**PZ's clothing loader does not appear to scan `common/media/clothing/`.**
Evidence from the live server, 2026-09-02: every mod whose clothing demonstrably
works puts it outside `common/` —

    SkullysDufflesAndRigs   <mod>/media/clothing/          22 items worn in-world
    alicesWeaponSling       <mod>/42/media/clothing/       17 items worn in-world
    FluffyHair              <mod>/media/clothing/

while the Thayne set, at `<mod>/common/media/clothing/`, produced a null
`ItemVisual` on every wear:

    SyncClothingPacket$ItemDescription.<init>
      -> InventoryItem.getVisual() == null -> .getTint() NPE

The item scripts and loot Lua loaded fine from `common/` the whole time, which is
what made this hard to see: the items existed, had icons, and spawned. Only the
clothingItem XML was never registered, so the item was built as a plain
InventoryItem with no visual.

So the clothing XMLs and their textures are duplicated here, at the path the
loader actually reads. The copies under `common/` are left in place because they
cost nothing and would be the right location if a later build starts scanning it.

`scripts/make-thayne-assets.py` writes the `common/` copy; `scripts/sync-thayne-clothing.sh`
mirrors it here. Run both after changing a texture.
