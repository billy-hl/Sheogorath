# WabbajackCrowns is deliberately excluded from builds

`common/mod.info` has been renamed to `common/mod.info.disabled`.

`scripts/build-project-zip.sh` includes every directory under `pzmods/` that
contains `common/mod.info`, so removing that one file is enough to keep the mod
out of the upload while leaving all of its source in the repo. The build prints
`skip WabbajackCrowns (no common/mod.info)` so the omission is visible rather
than silent.

## To ship it

    mv common/mod.info.disabled common/mod.info

Nothing else needs changing. Nothing depends on this mod, and it depends only on
WabbajackCore, which is always present.

## Why it was held back

The crown system is written and its Lua parses, but none of its PZ API calls
have run against a live server - `setMaxWeight`, `setBleedingTime` and
`z:setTarget(nil)` are all unverified on 42.20. Every power is individually
pcall-wrapped so a wrong call logs and costs only that power, but the sensible
order is to ship the Thayne set first and put Crowns on a later upload once
there is time to watch the server log while it runs.
