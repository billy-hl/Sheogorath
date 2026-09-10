#!/bin/bash
# Mirror the Thayne clothing XMLs and textures from common/ to the non-common
# media/ path that PZ's clothing loader actually reads. See
# pzmods/WabbajackArsenal/media/README.md for why both copies exist.
set -euo pipefail
A="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pzmods/WabbajackArsenal"
mkdir -p "$A/media/clothing/clothingItems" "$A/media/textures/Clothes/Thayne"
cp -f "$A"/common/media/clothing/clothingItems/Thayne_*.xml "$A/media/clothing/clothingItems/"
cp -f "$A"/common/media/textures/Clothes/Thayne/*.png "$A/media/textures/Clothes/Thayne/"
echo "  mirrored $(ls "$A"/media/clothing/clothingItems/Thayne_*.xml | wc -l | tr -d ' ') xml, $(ls "$A"/media/textures/Clothes/Thayne/*.png | wc -l | tr -d ' ') png"
