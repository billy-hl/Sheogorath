#!/usr/bin/env python3
"""Generates the Discord server icon for Wabbajack Community.

THREE DIRECTIONS, ONE SCRIPT, ON PURPOSE. A server icon is judged at 32px in a
sidebar, not at 512 in a preview - so all three are built from the same rules:
one silhouette, two colours, nothing that survives only at full size. Drawn at
4x and Lanczos'd down, because Discord will resample this again and a soft
source resamples worse than a sharp one.

    make-server-icon.py           write brand/wabbajack-community-*.png
"""
import math, os
from PIL import Image, ImageDraw, ImageFilter

S   = 1024                  # delivered size
SS  = 4                     # supersample factor
W   = S * SS
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "brand")

VOID    = (16, 10, 22)
PLUM    = (66, 28, 84)
GOLD    = (232, 182, 82)
GOLD_HI = (255, 228, 156)
GOLD_LO = (168, 122, 44)
MAGENTA = (198, 72, 170)
GREEN   = (128, 216, 120)


# ---------------------------------------------------------------- primitives

def radial_bg(inner, outer, power=1.35):
    """Low-frequency gradient: build small, scale up. Nobody can tell."""
    n = 256
    im = Image.new("RGB", (n, n))
    px = im.load()
    c = (n - 1) / 2.0
    for y in range(n):
        for x in range(n):
            d = min(1.0, math.hypot(x - c, y - c) / c)
            t = d ** power
            px[x, y] = tuple(int(inner[i] + (outer[i] - inner[i]) * t) for i in range(3))
    return im.resize((W, W), Image.LANCZOS)


def glow(base, cx, cy, r, color, strength=1.0, power=2.2):
    """Additive radial bloom, generated small and blown up."""
    n = 256
    layer = Image.new("L", (n, n))
    px = layer.load()
    c = (n - 1) / 2.0
    for y in range(n):
        for x in range(n):
            d = min(1.0, math.hypot(x - c, y - c) / c)
            px[x, y] = int(255 * strength * max(0.0, 1.0 - d) ** power)
    d = int(r * 2)
    mask = layer.resize((d, d), Image.LANCZOS)
    tint = Image.new("RGB", (d, d), color)
    base.paste(tint, (int(cx - r), int(cy - r)), mask)


def stroke(draw, pts, widths, color):
    """Variable-width polyline as a filled polygon. Round the joins with discs."""
    if callable(widths):
        widths = [widths(i / max(1, len(pts) - 1)) for i in range(len(pts))]
    left, right = [], []
    for i, (x, y) in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        nx, ny = -ty / L, tx / L
        h = widths[i] / 2.0
        left.append((x + nx * h, y + ny * h))
        right.append((x - nx * h, y - ny * h))
    draw.polygon(left + right[::-1], fill=color)
    for (x, y), w in zip(pts[::6], widths[::6]):
        draw.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=color)


def arc_pts(cx, cy, r, a0, a1, n=120):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n),
             cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def crescent(draw, cx, cy, r_out, r_in, dx, dy, color):
    outer = arc_pts(cx, cy, r_out, math.radians(120), math.radians(-140), 160)
    inner = arc_pts(cx + dx, cy + dy, r_in, math.radians(-140), math.radians(120), 160)
    draw.polygon(outer + inner, fill=color)


def shard(draw, cx, cy, r, rot, color):
    pts = []
    for i in range(4):
        a = rot + i * math.pi / 2
        rr = r if i % 2 == 0 else r * 0.38
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    draw.polygon(pts, fill=color)


def finish(img, name):
    os.makedirs(ROOT, exist_ok=True)
    out = img.resize((S, S), Image.LANCZOS)
    path = os.path.join(ROOT, "wabbajack-community-%s.png" % name)
    out.save(path, optimize=True)
    print(path)
    return path


# ------------------------------------------------------------------ variant A
# The staff itself: twisted shaft, hooked head, one mad green spark.

def variant_staff():
    img = radial_bg(PLUM, VOID)
    glow(img, W * 0.62, W * 0.36, W * 0.42, (124, 42, 112), 0.78)
    glow(img, W * 0.64, W * 0.30, W * 0.22, (154, 94, 42), 0.60)
    d = ImageDraw.Draw(img)

    # Diagonal, corner to corner: a vertical staff shrinks to a hairline at 28px.
    x0, y0 = W * 0.235, W * 0.845       # butt
    x1, y1 = W * 0.660, W * 0.300       # neck, under the head

    def axis(t):
        return x0 + (x1 - x0) * t, y0 + (y1 - y0) * t

    ax, ay = x1 - x0, y1 - y0
    L = math.hypot(ax, ay)
    nx, ny = -ay / L, ax / L            # perpendicular, for the twist

    for phase, col in ((0.0, GOLD), (math.pi, GOLD_LO)):
        pts, wid = [], []
        for i in range(161):
            t = i / 160.0
            x, y = axis(t)
            amp = W * 0.062 * (1.0 - 0.35 * t)
            s = amp * math.sin(t * math.pi * 4.2 + phase)
            pts.append((x + nx * s, y + ny * s))
            wid.append(W * 0.055 * (1.0 - 0.22 * t))
        stroke(d, pts, wid, col)

    hx, hy = W * 0.700, W * 0.238
    crescent(d, hx, hy, W * 0.180, W * 0.124, -W * 0.040, W * 0.026, GOLD)
    glow(img, hx - W * 0.030, hy + W * 0.010, W * 0.150, (140, 86, 36), 0.95)
    d = ImageDraw.Draw(img)
    d.ellipse([hx - W * 0.098, hy - W * 0.058, hx + W * 0.006, hy + W * 0.046], fill=GOLD_HI)
    d.ellipse([hx - W * 0.070, hy - W * 0.030, hx - W * 0.022, hy + W * 0.018], fill=GREEN)

    d.ellipse([x0 - W * 0.058, y0 - W * 0.058, x0 + W * 0.058, y0 + W * 0.058], fill=GOLD)

    shard(d, W * 0.300, W * 0.310, W * 0.060, 0.4, GREEN)
    shard(d, W * 0.800, W * 0.640, W * 0.048, 0.9, MAGENTA)
    shard(d, W * 0.235, W * 0.520, W * 0.030, 0.2, MAGENTA)
    return finish(img, "staff")


# ------------------------------------------------------------------ variant B
# The sigil: a chaos star with deliberately unequal spokes, ringed, with an eye.

def variant_sigil():
    img = radial_bg((52, 22, 68), VOID)
    glow(img, W * 0.50, W * 0.50, W * 0.42, (128, 44, 116), 0.70)
    d = ImageDraw.Draw(img)

    c = W * 0.50
    # Deliberately irregular: even spacing reads as a compass rose, not madness.
    spokes = [(-90, 0.375), (-38, 0.255), (12, 0.345), (58, 0.230),
              (104, 0.360), (152, 0.245), (196, 0.330), (238, 0.270)]
    for i, (deg, L) in enumerate(spokes):
        a = math.radians(deg)
        tip = (c + W * L * math.cos(a), c + W * L * math.sin(a))
        w = W * (0.060 if L > 0.30 else 0.042)
        b1 = (c + w * math.cos(a + math.pi / 2), c + w * math.sin(a + math.pi / 2))
        b2 = (c + w * math.cos(a - math.pi / 2), c + w * math.sin(a - math.pi / 2))
        d.polygon([b1, tip, b2], fill=GOLD if L > 0.30 else GOLD_LO)

    d.ellipse([c - W * 0.140, c - W * 0.140, c + W * 0.140, c + W * 0.140], fill=VOID)
    d.ellipse([c - W * 0.122, c - W * 0.122, c + W * 0.122, c + W * 0.122], fill=GOLD)
    d.ellipse([c - W * 0.078, c - W * 0.078, c + W * 0.078, c + W * 0.078], fill=VOID)
    d.ellipse([c - W * 0.044, c - W * 0.044, c + W * 0.044, c + W * 0.044], fill=GREEN)

    d.ellipse([c - W * 0.452, c - W * 0.452, c + W * 0.452, c + W * 0.452],
              outline=MAGENTA, width=int(W * 0.011))
    return finish(img, "sigil")


# ------------------------------------------------------------------ variant C
# The lettermark: a W whose centre spike is the staff, orb and all.

def variant_letter():
    img = radial_bg((60, 24, 78), VOID)
    glow(img, W * 0.50, W * 0.56, W * 0.40, (120, 40, 112), 0.72)
    d = ImageDraw.Draw(img)

    y0, y1 = W * 0.34, W * 0.74
    pts = [(W * 0.205, y0), (W * 0.335, y1), (W * 0.500, W * 0.235),
           (W * 0.665, y1), (W * 0.795, y0)]
    dense = []
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        for k in range(24):
            t = k / 24.0
            dense.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    dense.append(pts[-1])
    stroke(d, dense, lambda t: W * (0.072 - 0.020 * abs(t - 0.5) * 2), GOLD)

    ox, oy = W * 0.500, W * 0.205
    glow(img, ox, oy, W * 0.155, (130, 80, 34), 0.9)
    d = ImageDraw.Draw(img)
    d.ellipse([ox - W * 0.058, oy - W * 0.058, ox + W * 0.058, oy + W * 0.058], fill=GOLD_HI)
    d.ellipse([ox - W * 0.026, oy - W * 0.026, ox + W * 0.026, oy + W * 0.026], fill=GREEN)

    shard(d, W * 0.845, W * 0.255, W * 0.040, 0.5, MAGENTA)
    shard(d, W * 0.160, W * 0.290, W * 0.030, 0.2, GREEN)
    return finish(img, "letter")


if __name__ == "__main__":
    variant_staff()
    variant_sigil()
    variant_letter()
