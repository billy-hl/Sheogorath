#!/usr/bin/env bash
#
# Assembles the Workshop project zip the PC-side installer pulls.
#
# WHY THIS EXISTS
# Nothing in this repo used to produce that zip - it was assembled by hand, and
# an undocumented manual step is how you publish last week's build without
# noticing. That was survivable with one mod. It is not with seven, where the
# failure mode is a set that half-updates and leaves mods declaring
# require=WabbajackCore against a Core that did not move.
#
# The layout is what update-wabbajack-mod.ps1 expects:
#     Contents/mods/<ModId>/common/mod.info
#     Contents/mods/<ModId>/common/media/...
#
# Every directory under pzmods/ that contains common/mod.info is included, so
# adding a mod means adding a folder and nothing else.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/pzmods"
OUT="${1:-$HOME/Desktop/WabbajackSiege-project.zip}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/Contents/mods"

count=0
for dir in "$SRC"/*/; do
    id="$(basename "$dir")"
    [ -f "$dir/common/mod.info" ] || { echo "  skip $id (no common/mod.info)"; continue; }
    cp -R "$dir" "$STAGE/Contents/mods/$id"
    printf '  %-24s %s\n' "$id" "$(grep -m1 '^modversion=' "$dir/common/mod.info" | cut -d= -f2)"
    count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "FAILED: no mods found under $SRC" >&2; exit 1; }

# macOS sprinkles these through any directory Finder has looked at, and they
# ride into the zip and then onto the Workshop as junk files.
find "$STAGE" -name '.DS_Store' -delete

# Cross-check every declared dependency before shipping. The installer checks
# this too, but finding it here costs a rebuild rather than a round trip to the
# PC and back.
missing=0
for mi in "$STAGE"/Contents/mods/*/common/mod.info; do
    id="$(basename "$(dirname "$(dirname "$mi")")")"
    req="$(grep -m1 '^require=' "$mi" | cut -d= -f2- || true)"
    [ -n "$req" ] || continue
    IFS=';' read -ra deps <<< "$req"
    for d in "${deps[@]}"; do
        if [ ! -f "$STAGE/Contents/mods/$d/common/mod.info" ]; then
            echo "FAILED: $id requires $d, which is not in the build" >&2
            missing=1
        fi
    done
done
[ "$missing" -eq 0 ] || exit 1

rm -f "$OUT"
( cd "$STAGE" && zip -r -q -X "$OUT" Contents )

echo
echo "  $count mods -> $OUT"
echo "  $(find "$STAGE" -type f | wc -l | tr -d ' ') files, $(du -h "$OUT" | cut -f1) compressed"
shasum -a 256 "$OUT"
