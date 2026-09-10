#!/usr/bin/env python3
"""Generates the poster.png for every Wabbajack mod.

ONE SCRIPT, SEVEN POSTERS, ON PURPOSE. These have to read as a family in the
mod list - same frame, same ground, same weight of mark - while being told apart
at a glance in a column of forty other mods. Seven separately drawn images drift
apart; a shared frame with a per-mod emblem and accent cannot.

Drawn at 2x and box-filtered down, which is the cheapest antialiasing there is
and the only reason these do not look like 1998.

    make-mod-posters.py            write poster.png into each mod
"""
import math, os, struct, zlib

S = 256
SS = 2                      # supersample factor
W = S * SS
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pzmods")

BG      = (19, 20, 25)
FRAME   = (58, 61, 72)
INK     = (232, 234, 240)
MUTED   = (128, 133, 146)

def clamp(v): return 0 if v < 0 else (255 if v > 255 else int(v))

class C:
    def __init__(s):
        s.px = [[BG for _ in range(W)] for _ in range(W)]
    def put(s, x, y, col, a=1.0):
        if 0 <= x < W and 0 <= y < W:
            if a >= 1.0: s.px[y][x] = col
            else:
                o = s.px[y][x]
                s.px[y][x] = tuple(clamp(o[i] + (col[i] - o[i]) * a) for i in range(3))
    def rect(s, x0, y0, x1, y1, col):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)): s.put(x, y, col)
    def poly(s, pts, col):
        ys = [p[1] for p in pts]
        for y in range(int(min(ys)), int(max(ys)) + 1):
            xs = []
            for i in range(len(pts)):
                a, b = pts[i], pts[(i + 1) % len(pts)]
                if (a[1] <= y < b[1]) or (b[1] <= y < a[1]):
                    xs.append(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
            xs.sort()
            for i in range(0, len(xs) - 1, 2):
                for x in range(int(xs[i]), int(xs[i + 1]) + 1): s.put(x, y, col)
    def disc(s, cx, cy, r, col):
        for y in range(int(cy - r), int(cy + r) + 1):
            for x in range(int(cx - r), int(cx + r) + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r: s.put(x, y, col)
    def ring(s, cx, cy, r, t, col):
        for y in range(int(cy - r - t), int(cy + r + t) + 1):
            for x in range(int(cx - r - t), int(cx + r + t) + 1):
                d = math.hypot(x - cx, y - cy)
                if r - t <= d <= r: s.put(x, y, col)
    def line(s, x0, y0, x1, y1, t, col):
        n = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
        for i in range(n + 1):
            x = x0 + (x1 - x0) * i / n; y = y0 + (y1 - y0) * i / n
            s.disc(x, y, t / 2.0, col)
    def down(s):
        out = [[(0, 0, 0, 255)] * S for _ in range(S)]
        for y in range(S):
            for x in range(S):
                r = g = b = 0
                for dy in range(SS):
                    for dx in range(SS):
                        p = s.px[y * SS + dy][x * SS + dx]
                        r += p[0]; g += p[1]; b += p[2]
                n = SS * SS
                out[y][x] = (r // n, g // n, b // n, 255)
        return out

def write_png(path, px):
    raw = bytearray()
    for row in px:
        raw.append(0)
        for p in row: raw += bytes(p)
    def ch(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    open(path, "wb").write(
        b"\x89PNG\r\n\x1a\n" +
        ch(b"IHDR", struct.pack(">IIBBBBB", len(px[0]), len(px), 8, 6, 0, 0, 0)) +
        ch(b"IDAT", zlib.compress(bytes(raw), 9)) + ch(b"IEND", b""))

def frame(c, accent):
    """The shared furniture: a hairline border and an accent foot."""
    m = 14 * SS
    c.rect(m, m, W - m, m + 2 * SS, FRAME)
    c.rect(m, W - m - 2 * SS, W - m, W - m, FRAME)
    c.rect(m, m, m + 2 * SS, W - m, FRAME)
    c.rect(W - m - 2 * SS, m, W - m, W - m, FRAME)
    c.rect(m, W - m - 10 * SS, W - m, W - m - 2 * SS, accent)

# ------------------------------------------------------------------- emblems
K = W / 2.0
def em_core(c, a):
    for r, col in ((58 * SS, a), (40 * SS, BG)):
        pts = [(K + r * math.cos(math.radians(60 * i - 90)),
                K + r * math.sin(math.radians(60 * i - 90))) for i in range(6)]
        c.poly(pts, col)
    c.disc(K, K, 20 * SS, a)

def em_siege(c, a):
    c.poly([(K-34*SS, K+52*SS), (K-34*SS, K-18*SS), (K, K-52*SS),
            (K+34*SS, K-18*SS), (K+34*SS, K+52*SS)], INK)
    c.rect(K-10*SS, K+10*SS, K+10*SS, K+52*SS, BG)
    for i in range(8):
        ang = math.radians(i * 45 + 22)
        c.disc(K + 74*SS*math.cos(ang), K + 74*SS*math.sin(ang), 7*SS, a)

def em_raids(c, a):
    pts = [(K, K-56*SS), (K+44*SS, K-34*SS), (K+44*SS, K+16*SS),
           (K, K+58*SS), (K-44*SS, K+16*SS), (K-44*SS, K-34*SS)]
    c.poly(pts, INK)
    c.poly([(K, K-56*SS), (K+44*SS, K-34*SS), (K+44*SS, K+16*SS), (K, K+58*SS)], a)
    c.rect(K-2*SS, K-56*SS, K+2*SS, K+58*SS, BG)

def em_trail(c, a):
    for sx in (-26, 26):                       # two tyre tracks
        c.poly([(K+sx*SS-13*SS, K+60*SS), (K+sx*SS-7*SS, K-58*SS),
                (K+sx*SS+7*SS, K-58*SS), (K+sx*SS+13*SS, K+60*SS)], MUTED)
        for i in range(7):
            y = K - 50*SS + i * 18*SS
            c.rect(K+sx*SS-12*SS, y, K+sx*SS+12*SS, y + 7*SS, BG)
    for dx, dy, r in ((-64, 34, 17), (66, 22, 14), (-58, -30, 12), (62, -40, 15)):
        c.disc(K + dx*SS, K + dy*SS, r*SS, a)

def em_ops(c, a):
    c.ring(K, K - 6*SS, 46*SS, 9*SS, INK)      # shield ring = login shield
    c.disc(K, K - 6*SS, 17*SS, a)
    c.rect(K-52*SS, K+44*SS, K+52*SS, K+52*SS, a)   # swept ground line
    for i in range(5):
        c.disc(K - 40*SS + i*20*SS, K + 32*SS, 5*SS, MUTED)

def em_qol(c, a):
    for i, col in enumerate((MUTED, a, INK)):
        y = K - 44*SS + i * 34*SS
        c.poly([(K-46*SS, y), (K, y+30*SS), (K+46*SS, y),
                (K+46*SS, y+14*SS), (K, y+44*SS), (K-46*SS, y+14*SS)], col)

def em_arsenal(c, a):
    # the katar, straight on: blade, collar, rails, grip bar
    c.poly([(K, K-66*SS), (K+21*SS, K+4*SS), (K-21*SS, K+4*SS)], INK)
    c.rect(K-26*SS, K+4*SS, K+26*SS, K+16*SS, a)
    c.rect(K-26*SS, K+16*SS, K-15*SS, K+66*SS, MUTED)
    c.rect(K+15*SS, K+16*SS, K+26*SS, K+66*SS, MUTED)
    c.rect(K-15*SS, K+36*SS, K+15*SS, K+48*SS, a)

MODS = [
    ("WabbajackCore",        (122, 132, 152), em_core),
    ("WabbajackSiege",       (198, 138,  56), em_siege),
    ("WabbajackRaids",       (176,  66,  62), em_raids),
    ("WabbajackTrailblazer", ( 96, 152,  86), em_trail),
    ("WabbajackServerOps",   ( 78, 128, 178), em_ops),
    ("WabbajackQoL",         ( 88, 158, 156), em_qol),
    ("WabbajackArsenal",     (166, 134,  62), em_arsenal),
]

for mid, accent, emblem in MODS:
    c = C()
    emblem(c, accent)
    frame(c, accent)
    out = os.path.join(ROOT, mid, "common", "poster.png")
    write_png(out, c.down())
    print("wrote %s" % os.path.relpath(out, ROOT))
