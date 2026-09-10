#!/usr/bin/env python3
"""Generates every texture and icon for the Thayne set.

    make-thayne-assets.py            write into WabbajackArsenal
    make-thayne-assets.py --check    build in memory, report, write nothing

WHY THE TEXTURES ARE MATERIAL, NOT ARTWORK
The vanilla clothing textures live inside media/texturepacks/*.pack, so the UV
layout of bob_huntingvest and friends cannot be read from here. Painting a
placed design - a crest on the chest, a stripe down the leg - would require
knowing which rectangle of the image lands on which panel of the mesh, and
getting that wrong puts the crest on an armpit.

So nothing here is placed. Every texture is a seamless material: scale, hide or
weave in the set's palette, statistically uniform across the whole image. A
uniform material maps correctly onto ANY UV layout, because there is no feature
whose position can be wrong. It is the one kind of texture that can be authored
blind and still be right.

WHY PIL HERE WHEN make-katar-assets.py HAND-ROLLS PNGs
That script emits a mesh as well, and its PNG writer exists so the whole
pipeline has no dependencies. This one only paints, PIL is present, and 200
lines of zlib plumbing to avoid an import that already works would be its own
kind of mistake. If PIL ever goes missing, the fix is `pip install pillow`, not
a rewrite.

THE PALETTE
Jake Thayne's colours after the Malefic Viper: deep venom green, near-black
scale, and a little gold. The gold is deliberately sparse - it reads as an
accent at a distance and as trim up close, and a gold-heavy character stops
looking like a hunter and starts looking like a boss mob.
"""
import argparse
import math
import os
import random
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    sys.exit("needs pillow:  pip3 install pillow")

MOD = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "pzmods", "WabbajackArsenal", "common", "media")

SIZE = 512          # vanilla clothing textures sit at 512; mods here use 256-512
ICON = 32           # PZ inventory icons

# ------------------------------------------------------------------- palette
VENOM_DARK  = (14, 28, 20)
VENOM_MID   = (26, 56, 38)
VENOM_LIT   = (44, 88, 58)
SCALE_BLACK = (16, 18, 17)
SCALE_GREY  = (34, 38, 36)
GOLD        = (176, 141, 60)
HIDE_DARK   = (38, 30, 22)
HIDE_MID    = (62, 49, 35)


def _noise(img, amount, rng):
    """Per-pixel jitter. Breaks up flat fill so the material reads as fabric
    rather than a colour swatch, at a strength low enough not to shimmer when
    the camera moves."""
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            n = rng.randint(-amount, amount)
            px[x, y] = (max(0, min(255, r + n)),
                        max(0, min(255, g + n)),
                        max(0, min(255, b + n)), 255)
    return img


def scales(size, base, edge, accent=None, rng=None):
    """A seamless overlapping-scale field.

    Rows are offset by half a scale and the pattern wraps in both axes, so the
    image tiles: whatever slice of it the UVs take, the scales continue across
    the seam instead of butting into a hard line.
    """
    rng = rng or random.Random(7)
    img = Image.new("RGBA", (size, size), base + (255,))
    d = ImageDraw.Draw(img)
    step = size // 16              # 16 scales across, so each is chunky enough to read
    r = int(step * 0.72)
    for row, y in enumerate(range(-step, size + step, step // 2)):
        offset = 0 if row % 2 == 0 else step // 2
        for x in range(-step, size + step, step):
            cx, cy = x + offset, y
            shade = tuple(max(0, min(255, c + rng.randint(-10, 10))) for c in edge)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=shade + (255,))
            d.arc([cx - r, cy - r, cx + r, cy + r], 200, 340,
                  fill=tuple(max(0, c - 14) for c in shade) + (255,))
    if accent:
        # Gold is TRIM, not spots. Earlier versions filled whole scales with it
        # and the result read as confetti: bright discs scattered over a dark
        # field, with nothing tying them to the scale shapes underneath. Drawing
        # the lower arc of a scale instead makes the gold follow an edge that is
        # already there, which is what catching the light actually looks like.
        for row, y in enumerate(range(-step, size + step, step // 2)):
            offset = 0 if row % 2 == 0 else step // 2
            for x in range(-step, size + step, step):
                if rng.random() < 0.045:
                    cx, cy = x + offset, y
                    d.arc([cx - r, cy - r, cx + r, cy + r], 235, 305,
                          fill=accent + (255,), width=1)
    img = img.filter(ImageFilter.GaussianBlur(0.4))
    return _noise(img, 7, rng)


def hide(size, dark, mid, rng=None):
    """Worn leather.

    WHY THIS IS NOT BLOBS ANY MORE
    The first version scattered randomly-tinted ellipses and blurred them. Any
    field of overlapping random tints converges on its own mean, so whatever hue
    you start from you end up with desaturated grey - and grey sitting between a
    warm and a cool sample reads as mauve. It looked like porridge.

    Leather is two things instead: a consistent base hue, and grain. So the base
    colour is laid down once and never re-randomised, fine grain is added at high
    frequency and low amplitude, and broad mottling is added at low frequency -
    both as multipliers on the base rather than as new colours, which is what
    keeps the hue exactly where it was put.
    """
    rng = rng or random.Random(11)
    img = Image.new("RGBA", (size, size), mid + (255,))
    px = img.load()

    # Low-frequency mottling, built small and scaled up so it wraps cleanly.
    coarse = Image.new("L", (16, 16))
    cpx = coarse.load()
    for y in range(16):
        for x in range(16):
            cpx[x, y] = rng.randint(96, 160)
    coarse = coarse.resize((size, size), Image.BICUBIC)
    mpx = coarse.load()

    for y in range(size):
        for x in range(size):
            # 0.75-1.25 broad variation, then +/-6% grain, both multiplicative
            k = (mpx[x, y] / 128.0) * 0.5 + 0.75
            k *= 1.0 + rng.uniform(-0.06, 0.06)
            r_ = max(0, min(255, int(mid[0] * k)))
            g_ = max(0, min(255, int(mid[1] * k)))
            b_ = max(0, min(255, int(mid[2] * k)))
            px[x, y] = (r_, g_, b_, 255)

    # A few dark creases. Thin, sparse, and wrapped - worn leather has lines in
    # it, and without them the surface reads as suede.
    d = ImageDraw.Draw(img)
    for _ in range(size // 12):
        x0, y0 = rng.randrange(size), rng.randrange(size)
        x1 = x0 + rng.randint(-size // 6, size // 6)
        y1 = y0 + rng.randint(-size // 6, size // 6)
        shade = tuple(int(c * 0.72) for c in dark)
        for ox in (0, size, -size):
            for oy in (0, size, -size):
                d.line([(x0 + ox, y0 + oy), (x1 + ox, y1 + oy)],
                       fill=shade + (255,), width=1)
    return img.filter(ImageFilter.GaussianBlur(0.35))


def weave(size, base, rng=None):
    """Tight cloth weave for the mask - finer than scale, still seamless."""
    rng = rng or random.Random(13)
    img = Image.new("RGBA", (size, size), base + (255,))
    d = ImageDraw.Draw(img)
    # 4px lines at +/-6 brightness vanished completely once the texture was
    # scaled onto a face. Coarser threads and real contrast make it read as
    # cloth instead of a flat swatch.
    step = 9
    dark = tuple(max(0, c - 9) for c in base)
    lit = tuple(min(255, c + 16) for c in base)
    for x in range(0, size, step):
        d.line([(x, 0), (x, size)], fill=dark + (255,), width=4)
    for y in range(0, size, step):
        d.line([(0, y), (size, y)], fill=lit + (255,), width=2)
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    return _noise(img, 6, rng)


def icon(name, base, accent, rng=None):
    """A 32x32 inventory icon.

    Silhouette only - at this size a shape reads and detail does not. Each piece
    gets a distinct outline so the set is separable at a glance in a full bag.
    """
    rng = rng or random.Random(hash(name) & 0xffff)
    img = Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    shapes = {
        "mask":     [(6, 12, 26, 22)],
        "hood":     [(6, 6, 26, 24)],
        "vest":     [(9, 6, 23, 27)],
        "trousers": [(10, 5, 15, 28), (17, 5, 22, 28)],
        "gloves":   [(7, 10, 15, 24), (17, 10, 25, 24)],
    }
    for box in shapes.get(name, [(8, 8, 24, 24)]):
        d.rounded_rectangle(box, radius=3, fill=base + (255,),
                            outline=tuple(max(0, c - 10) for c in base) + (255,))
    d.line([(4, ICON - 5), (ICON - 4, ICON - 5)], fill=accent + (200,))
    return img


PIECES = {
    # name              texture builder                          icon shape
    "thayne_mask":     (lambda: weave(SIZE, VENOM_DARK),          "mask"),
    "thayne_hood":     (lambda: scales(SIZE, VENOM_DARK, VENOM_MID, GOLD), "hood"),
    "thayne_vest":     (lambda: scales(SIZE, SCALE_BLACK, SCALE_GREY, GOLD), "vest"),
    "thayne_trousers": (lambda: hide(SIZE, HIDE_DARK, HIDE_MID),  "trousers"),
    "thayne_gloves":   (lambda: hide(SIZE, SCALE_BLACK, SCALE_GREY), "gloves"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="build in memory and report; write nothing")
    args = ap.parse_args()

    tex_dir = os.path.join(MOD, "textures", "Clothes", "Thayne")
    icon_dir = os.path.join(MOD, "textures")
    if not args.check:
        os.makedirs(tex_dir, exist_ok=True)
        os.makedirs(icon_dir, exist_ok=True)

    for name, (build, shape) in PIECES.items():
        tex = build()
        ic = icon(shape, VENOM_MID if shape != "trousers" else HIDE_MID, GOLD)
        if tex.size != (SIZE, SIZE):
            sys.exit("texture %s came out %s, expected %dx%d" % (name, tex.size, SIZE, SIZE))
        if args.check:
            print("  %-18s texture %dx%d  icon %dx%d" % (name, *tex.size, *ic.size))
            continue
        tp = os.path.join(tex_dir, name + ".png")
        ip = os.path.join(icon_dir, "Item_" + name + ".png")
        tex.save(tp)
        ic.save(ip)
        print("  wrote %s" % os.path.relpath(tp, MOD))
        print("  wrote %s" % os.path.relpath(ip, MOD))

    if args.check:
        print("\n  %d pieces built, nothing written" % len(PIECES))


if __name__ == "__main__":
    main()
