#!/usr/bin/env python3
"""Generates every Onyx Katar asset: the mesh, its texture, and the icon.

WHY ALL THREE LIVE IN ONE FILE
The UV layout is a shared secret between the geometry and the paint. Split them
across two scripts and the day someone nudges a region boundary in one, the
other keeps painting the old rectangle and the blade comes out wearing the grip
wrap. REGIONS below is the single definition both halves read.

    make-katar-assets.py            write all three into the mod
    make-katar-assets.py --check    build in memory, report counts, write nothing

WHAT IS AND IS NOT VERIFIED
The .x is emitted in DirectX text format, the shape Blender's exporter produces
and the shape PZ's parser reads. It has not been loaded by the game - there is
no Zomboid on the Mac this was written on. Structure is self-checked below
(index ranges, array lengths, winding, UV bounds); what cannot be checked from
here is scale, axis convention and winding-vs-culling. See TUNING.
"""
import argparse
import math
import os
import struct
import sys
import zlib

# WabbajackArsenal, not WabbajackSiege. The katar and the shovel moved into
# their own mod when the toolkit was split; this constant did not follow, so for
# a while the generator was quietly writing its output into the siege mod while
# the Arsenal copy went stale. Nothing errored - both paths existed.
MOD = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "pzmods", "WabbajackArsenal", "common", "media")

# --------------------------------------------------------------------- TUNING
#
# The three numbers that cannot be checked without the game in front of you.
# Each is one edit followed by a re-run.
#
#   SCALE      metres per model unit. The katar is modelled at life size (455mm
#              overall, which is mid-range for a real one). If it arrives in
#              game as a toy or a telegraph pole, this is the knob.
#   ORIENT     which way the blade points in the mesh's OWN space.
#
#              THIS IS THE KNOB THAT ACTUALLY AIMS THE WEAPON, not the script's
#              attachment rotate. Vanilla proves it: Knife_Bone and HuntingKnife
#              carry byte-identical rotations (0.0 -82.5857 2.9014) despite
#              being different shapes, Hammer uses 0.0 -86.9102 0.0, and 193 of
#              the 284 models that set one sit within 10 degrees of -85. The
#              rotation is boilerplate. Vanilla's *_Hand.x meshes are authored
#              already pointing the right way, and the orientation lives in the
#              geometry. Four rotate values were tried on this item in game and
#              every one rendered identically, which is that fact the hard way.
#
#              Measured in game: with the blade on +Y it renders pointing
#              FORWARD out of the fist. So the axis chosen here IS the render
#              direction, and the values below are named for what they produce
#              rather than for an axis letter.
#
#                "forward"  blade out from the fist   (+Y, the original)
#                "down"     blade hanging at the leg  (-Z)
#                "up"       blade raised              (+Z)
#                "across"   blade across the body     (+X)
#
#              LEFT ON "forward", WHICH MATCHES EVERY VANILLA WEAPON.
#              "down" was built and tested in game on 2026-08-27 to try to make
#              the katar hang at the leg, and it rendered identically to
#              "forward" - the blade still pointed out of the fist. That result
#              contradicts the measurement above and is unexplained. Since the
#              deviation bought nothing visible, the mesh is back on the vanilla
#              convention rather than shipping an unexplained difference.
#              If you pick this up again: the game has ONE idle pose
#              (Idle_Weapon2, all 267 weapons) and no vanilla weapon is held
#              blade-down, so there is no working example to copy.
SCALE = 1.0
ORIENT = "forward"
FLIP_WIND = False

# ------------------------------------------------------------------- UV atlas
# u0, v0, u1, v1 in 0..1, v measured from the TOP of the image.
REGIONS = {
    "blade":  (0.02, 0.02, 0.48, 0.98),
    "rail":   (0.52, 0.02, 0.70, 0.98),
    "collar": (0.72, 0.02, 0.86, 0.30),
    "grip":   (0.72, 0.35, 0.98, 0.98),
}

def uv(region, fu, fv):
    """Place a fraction (0..1, 0..1) inside a named atlas region."""
    u0, v0, u1, v1 = REGIONS[region]
    return (u0 + (u1 - u0) * fu, v0 + (v1 - v0) * fv)

# ------------------------------------------------------------------- geometry
# Everything is built blade-up (+Y), thickness on Z, width on X, with the ORIGIN
# AT THE FIST. That last part is the whole reason to own the mesh: the vanilla
# reskin had to guess vanilla's attachment offsets, but a mesh whose origin is
# already where the hand closes attaches at 0,0,0 and there is nothing to guess.

verts, faces, norms, uvs = [], [], [], []

def add_tri(a, b, c, ua, ub, uc):
    i = len(verts)
    verts.extend([a, b, c])
    uvs.extend([ua, ub, uc])
    ax, ay, az = a
    n = ((b[1]-ay)*(c[2]-az) - (b[2]-az)*(c[1]-ay),
         (b[2]-az)*(c[0]-ax) - (b[0]-ax)*(c[2]-az),
         (b[0]-ax)*(c[1]-ay) - (b[1]-ay)*(c[0]-ax))
    ln = math.sqrt(sum(k*k for k in n)) or 1.0
    norms.append((n[0]/ln, n[1]/ln, n[2]/ln))
    faces.append((i, i+2, i+1) if FLIP_WIND else (i, i+1, i+2))

def add_quad(a, b, c, d, ua, ub, uc, ud):
    add_tri(a, b, c, ua, ub, uc)
    add_tri(a, c, d, ua, uc, ud)

def add_box(x0, x1, y0, y1, z0, z1, region, fu0=0.0, fu1=1.0, fv0=0.0, fv1=1.0):
    """Axis-aligned box. All six faces share the region rectangle - these are
    dark iron parts with no detail that has to land anywhere in particular."""
    p = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),
         (x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    A, B, C, D = (uv(region,fu0,fv1), uv(region,fu1,fv1),
                  uv(region,fu1,fv0), uv(region,fu0,fv0))
    for q in ((0,3,2,1), (4,5,6,7), (0,1,5,4), (3,7,6,2), (0,4,7,3), (1,2,6,5)):
        add_quad(p[q[0]], p[q[1]], p[q[2]], p[q[3]], A, B, C, D)

# ---- blade: a flattened diamond section, tapering to a point.
# Ring order is left edge -> front ridge -> right edge -> back ridge, so the two
# CUTTING EDGES land at perimeter fractions 0.0 and 0.5 and the midrib ridges at
# 0.25 and 0.75. paint_blade() below relies on exactly that.
# A straighter taper than a knife's: a katar blade is broad at the collar and
# runs to the point in more or less a line, with only a slight belly. The
# earlier convex version read as a rocket nose.
BLADE = [(0.098, 0.040, 0.0070),
         (0.155, 0.035, 0.0062),
         (0.215, 0.028, 0.0052),
         (0.270, 0.019, 0.0039),
         (0.315, 0.010, 0.0025)]
TIP_Y = 0.350

def ring(y, hw, ht):
    return [(-hw, y, 0.0), (0.0, y, ht), (hw, y, 0.0), (0.0, y, -ht)]

def build_blade():
    n = len(BLADE)
    for i in range(n - 1):
        y0, w0, t0 = BLADE[i]
        y1, w1, t1 = BLADE[i + 1]
        r0, r1 = ring(y0, w0, t0), ring(y1, w1, t1)
        fv0, fv1 = 1.0 - i / float(n - 1), 1.0 - (i + 1) / float(n - 1)
        for k in range(4):
            k2 = (k + 1) % 4
            fu0, fu1 = k / 4.0, (k + 1) / 4.0
            add_quad(r0[k], r0[k2], r1[k2], r1[k],
                     uv("blade", fu0, fv0), uv("blade", fu1, fv0),
                     uv("blade", fu1, fv1), uv("blade", fu0, fv1))
    y, w, t = BLADE[-1]
    r = ring(y, w, t)
    tip = (0.0, TIP_Y, 0.0)
    for k in range(4):
        k2 = (k + 1) % 4
        add_tri(r[k], r[k2], tip,
                uv("blade", k / 4.0, 0.02), uv("blade", (k + 1) / 4.0, 0.02),
                uv("blade", (k + 0.5) / 4.0, 0.0))

def build_frame():
    # collar: the block the blade stands on
    add_box(-0.042, 0.042, 0.075, 0.098, -0.012, 0.012, "collar")
    # side rails, running back along the forearm, open at the far end
    add_box(-0.044, -0.034, -0.115, 0.075, -0.009, 0.009, "rail", fu0=0.0, fu1=0.5)
    add_box( 0.034,  0.044, -0.115, 0.075, -0.009, 0.009, "rail", fu0=0.5, fu1=1.0)

def build_grips():
    # Two transverse bars, which is what the fist actually closes on and the
    # single most katar-shaped thing about the object.
    for idx, cy in enumerate((0.014, -0.016)):
        r = 0.010
        seg = 8
        fv0, fv1 = (0.0, 0.45) if idx == 0 else (0.55, 1.0)
        rings = []
        for x in (-0.034, 0.034):
            rings.append([(x, cy + r * math.cos(2*math.pi*k/seg),
                              0.0 + r * math.sin(2*math.pi*k/seg)) for k in range(seg)])
        for k in range(seg):
            k2 = (k + 1) % seg
            fua, fub = k / float(seg), (k + 1) / float(seg)
            add_quad(rings[0][k], rings[1][k], rings[1][k2], rings[0][k2],
                     uv("grip", fua, fv0), uv("grip", fua, fv1),
                     uv("grip", fub, fv1), uv("grip", fub, fv0))
        for side, rg in enumerate(rings):
            c = (rg[0][0], cy, 0.0)
            for k in range(seg):
                k2 = (k + 1) % seg
                a, b = (rg[k], rg[k2]) if side else (rg[k2], rg[k])
                add_tri(c, a, b, uv("grip", 0.5, 0.5),
                        uv("grip", 0.45, 0.5), uv("grip", 0.55, 0.5))

build_blade()
build_frame()
build_grips()

# ------------------------------------------------------------- orient + scale
# Blade is authored on +Y throughout the builder above; this maps it onto the
# axis that renders the way ORIENT names. Applied to positions and, rotation
# only, to normals.
_AXIS = {
    "forward": lambda x, y, z: ( x,  y,  z),   # +Y unchanged
    "down":    lambda x, y, z: ( x,  z, -y),   # +Y -> -Z
    "up":      lambda x, y, z: ( x, -z,  y),   # +Y -> +Z
    "across":  lambda x, y, z: ( y,  x,  z),   # +Y -> +X
}

def orient_only(p):
    if ORIENT not in _AXIS:
        raise SystemExit("ORIENT must be one of: %s" % ", ".join(sorted(_AXIS)))
    return _AXIS[ORIENT](*p)

def transform(p):
    x, y, z = orient_only(p)
    return (x * SCALE, y * SCALE, z * SCALE)

verts = [transform(v) for v in verts]
norms = [orient_only(n) for n in norms]   # direction only: scaling a normal is
                                          # how you get lighting that dims as
                                          # the model gets bigger

# ------------------------------------------------------------- sanity checks
def check():
    assert len(verts) == len(uvs), (len(verts), len(uvs))
    assert len(norms) == len(faces), (len(norms), len(faces))
    for f in faces:
        for i in f:
            assert 0 <= i < len(verts), i
    for (u, v) in uvs:
        assert -0.001 <= u <= 1.001 and -0.001 <= v <= 1.001, (u, v)
    for n in norms:
        assert abs(math.sqrt(sum(k*k for k in n)) - 1.0) < 1e-4, n
    ax = 1 if ORIENT == "forward" else (0 if ORIENT == "across" else 2)
    ys = [v[ax] for v in verts]
    return len(verts), len(faces), min(ys), max(ys)

# ------------------------------------------------------------------ .x writer

# The template declarations, lifted verbatim from vanilla's
# models_X/weapons/1handed/HuntingKnife.x. Standard .x readers have these built
# in and the first version of this file omitted them - but every model the game
# ships declares them, and a parser that is template-driven rather than
# hardcoded would reject a file that does not. Matching vanilla byte for byte
# here costs nothing and removes the question.
TEMPLATES = """template ColorRGBA {
 <35ff44e0-6c7c-11cf-8f52-0040333594a3>
 FLOAT red;
 FLOAT green;
 FLOAT blue;
 FLOAT alpha;
}

template ColorRGB {
 <d3e16e81-7835-11cf-8f52-0040333594a3>
 FLOAT red;
 FLOAT green;
 FLOAT blue;
}

template Material {
 <3d82ab4d-62da-11cf-ab39-0020af71e433>
 ColorRGBA faceColor;
 FLOAT power;
 ColorRGB specularColor;
 ColorRGB emissiveColor;
 [...]
}

template TextureFilename {
 <a42790e1-7810-11cf-8f52-0040333594a3>
 STRING filename;
}

template Frame {
 <3d82ab46-62da-11cf-ab39-0020af71e433>
 [...]
}

template Matrix4x4 {
 <f6f23f45-7686-11cf-8f52-0040333594a3>
 array FLOAT matrix[16];
}

template FrameTransformMatrix {
 <f6f23f41-7686-11cf-8f52-0040333594a3>
 Matrix4x4 frameMatrix;
}

template Vector {
 <3d82ab5e-62da-11cf-ab39-0020af71e433>
 FLOAT x;
 FLOAT y;
 FLOAT z;
}

template MeshFace {
 <3d82ab5f-62da-11cf-ab39-0020af71e433>
 DWORD nFaceVertexIndices;
 array DWORD faceVertexIndices[nFaceVertexIndices];
}

template Mesh {
 <3d82ab44-62da-11cf-ab39-0020af71e433>
 DWORD nVertices;
 array Vector vertices[nVertices];
 DWORD nFaces;
 array MeshFace faces[nFaces];
 [...]
}

template MeshNormals {
 <f6f23f43-7686-11cf-8f52-0040333594a3>
 DWORD nNormals;
 array Vector normals[nNormals];
 DWORD nFaceNormals;
 array MeshFace faceNormals[nFaceNormals];
}

template MeshMaterialList {
 <f6f23f42-7686-11cf-8f52-0040333594a3>
 DWORD nMaterials;
 DWORD nFaceIndexes;
 array DWORD faceIndexes[nFaceIndexes];
 [Material <3d82ab4d-62da-11cf-ab39-0020af71e433>]
}

template Coords2d {
 <f6f23f44-7686-11cf-8f52-0040333594a3>
 FLOAT u;
 FLOAT v;
}

template MeshTextureCoords {
 <f6f23f40-7686-11cf-8f52-0040333594a3>
 DWORD nTextureCoords;
 array Coords2d textureCoords[nTextureCoords];
}"""


# DirectX retained-mode text format. Punctuation is load-bearing: a Vector is
# "x;y;z;", array entries are comma-separated, and the final entry closes with
# the array's own ";" as well as its own - hence the ";;" endings.
def fmt_vec(v):
    return "%.6f;%.6f;%.6f;" % v

def write_x(path, texture_name):
    L = []
    L.append("xof 0303txt 0032")
    L.append(TEMPLATES)
    L.append("Material OnyxKatarMat {")
    L.append(" 1.000000;1.000000;1.000000;1.000000;;")
    L.append(" 8.000000;")
    L.append(" 0.100000;0.100000;0.100000;;")
    L.append(" 0.000000;0.000000;0.000000;;")
    L.append(" TextureFilename {")
    L.append('  "%s";' % texture_name)
    L.append(" }")
    L.append("}")
    L.append("")
    L.append("Frame OnyxKatar {")
    L.append(" FrameTransformMatrix {")
    L.append("  1.000000,0.000000,0.000000,0.000000,")
    L.append("  0.000000,1.000000,0.000000,0.000000,")
    L.append("  0.000000,0.000000,1.000000,0.000000,")
    L.append("  0.000000,0.000000,0.000000,1.000000;;")
    L.append(" }")
    L.append("")
    L.append(" Mesh {")
    L.append("  %d;" % len(verts))
    for i, v in enumerate(verts):
        L.append("  %s%s" % (fmt_vec(v), ";" if i == len(verts) - 1 else ","))
    L.append("  %d;" % len(faces))
    for i, f in enumerate(faces):
        L.append("  3;%d,%d,%d;%s" % (f[0], f[1], f[2],
                                      ";" if i == len(faces) - 1 else ","))
    L.append("")
    L.append("  MeshNormals {")
    L.append("   %d;" % len(norms))
    for i, n in enumerate(norms):
        L.append("   %s%s" % (fmt_vec(n), ";" if i == len(norms) - 1 else ","))
    L.append("   %d;" % len(faces))
    for i in range(len(faces)):
        L.append("   3;%d,%d,%d;%s" % (i, i, i, ";" if i == len(faces) - 1 else ","))
    L.append("  }")
    L.append("")
    L.append("  MeshTextureCoords {")
    L.append("   %d;" % len(uvs))
    for i, t in enumerate(uvs):
        L.append("   %.6f;%.6f;%s" % (t[0], t[1], ";" if i == len(uvs) - 1 else ","))
    L.append("  }")
    L.append("")
    L.append("  MeshMaterialList {")
    L.append("   1;")
    L.append("   %d;" % len(faces))
    for i in range(len(faces)):
        L.append("   0%s" % (";;" if i == len(faces) - 1 else ","))
    L.append("   { OnyxKatarMat }")
    L.append("  }")
    L.append(" }")
    L.append("}")
    open(path, "w").write("\n".join(L) + "\n")

# ------------------------------------------------------------------ PNG output
def write_png(path, w, h, px):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw += bytes(px[y][x])
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    out += chunk(b"IEND", b"")
    open(path, "wb").write(out)

def clamp(v):
    return 0 if v < 0 else (255 if v > 255 else int(v))

# --------------------------------------------------------------- the skin
# Now that the mesh is ours, the texture stops being a uniform field and can
# put detail where detail belongs. Each region is painted to match exactly what
# the geometry mapped into it.
def build_skin(size=512, seed=8613):
    import random
    rnd = random.Random(seed)
    px = [[(24, 25, 30, 255) for _ in range(size)] for _ in range(size)]

    def grain(a=6):
        return (rnd.random() - 0.5) * a

    def region_px(name):
        u0, v0, u1, v1 = REGIONS[name]
        return (int(u0*size), int(v0*size), int(u1*size), int(v1*size))

    # blade: perimeter across x, length down y. Cutting edges sit at perimeter
    # fractions 0.00 and 0.50, midrib ridges at 0.25 and 0.75 - build_blade()
    # guarantees it.
    x0, y0, x1, y1 = region_px("blade")
    for y in range(y0, y1):
        fv = (y - y0) / float(y1 - y0)          # 0 at tip, 1 at base
        for x in range(x0, x1):
            fu = (x - x0) / float(x1 - x0)
            d_edge = min(abs(fu - 0.0), abs(fu - 0.5), abs(fu - 1.0))
            d_rib  = min(abs(fu - 0.25), abs(fu - 0.75))
            base = 38 + grain()
            if d_edge < 0.030:                   # the sharpened edge itself
                k = 1.0 - d_edge / 0.030
                base += 185 * (k ** 1.5) * (0.5 + 0.5 * (1.0 - fv))
            elif d_rib < 0.055:                  # midrib, a soft lift not a line
                base += 34 * (1.0 - d_rib / 0.055)
            base += 10 * (1.0 - fv)              # tip catches more light
            px[y][x] = (clamp(base * 0.95), clamp(base), clamp(base * 1.12), 255)

    # rails and collar: blackened iron, faint forge mottle, no detail to place
    for name in ("rail", "collar"):
        x0, y0, x1, y1 = region_px(name)
        for y in range(y0, y1):
            for x in range(x0, x1):
                b = 43 + grain(9) + 6 * math.sin((y - y0) * 0.17)
                px[y][x] = (clamp(b * 0.95), clamp(b), clamp(b * 1.1), 255)

    # grips: cord wrap. The bar's perimeter runs across x, so banding down y
    # reads as turns of cord along the bar.
    x0, y0, x1, y1 = region_px("grip")
    for y in range(y0, y1):
        for x in range(x0, x1):
            band = math.sin((x - x0) * 0.55)
            b = 47 + 13 * band + grain(7)
            px[y][x] = (clamp(b * 1.06), clamp(b * 0.94), clamp(b * 0.9), 255)
    return px

# ------------------------------------------------------------------- the icon
def build_icon():
    N, CX = 32, 15.5
    STEEL_CORE, STEEL_MID = (30, 32, 38), (52, 56, 65)
    STEEL_EDGE, STEEL_TIP = (142, 150, 164), (186, 194, 208)
    IRON, IRON_LIT = (20, 20, 25), (58, 60, 69)
    GRIP, GRIP_LIT = (29, 25, 26), (72, 65, 65)
    ic = [[(0, 0, 0, 0) for _ in range(N)] for _ in range(N)]
    def put(x, y, c):
        if 0 <= x < N and 0 <= y < N:
            ic[y][x] = c if len(c) == 4 else (c[0], c[1], c[2], 255)
    for y in range(2, 20):
        t = (y - 2) / 17.0
        hw = 0.5 + 3.2 * (t ** 0.75)
        xa, xb = int(round(CX - hw)), int(round(CX + hw))
        for x in range(xa, xb + 1):
            put(x, y, STEEL_EDGE if x in (xa, xb) else
                      (STEEL_MID if x in (15, 16) else STEEL_CORE))
    for x in (15, 16):
        put(x, 2, STEEL_TIP); put(x, 3, STEEL_TIP)
    for y in range(20, 22):
        for x in range(11, 21):
            put(x, y, IRON_LIT if y == 20 else IRON)
    for y in range(22, 32):
        for x in (11, 12, 19, 20):
            put(x, y, IRON_LIT if x in (11, 19) else IRON)
    for y in range(24, 27):
        for x in range(12, 20):
            put(x, y, GRIP_LIT if y == 24 else GRIP)
    return N, ic

# ------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="build and validate, write nothing")
    a = ap.parse_args()
    nv, nf, lo, hi = check()
    print("mesh: %d verts, %d tris, length %.3f m (%.0f mm)"
          % (nv, nf, hi - lo, (hi - lo) * 1000))
    if a.check:
        print("check only - nothing written")
        return 0
    xdir = os.path.join(MOD, "models_X", "weapons", "1handed")
    tdir = os.path.join(MOD, "textures", "weapons", "1handed")
    os.makedirs(xdir, exist_ok=True)
    os.makedirs(tdir, exist_ok=True)
    write_x(os.path.join(xdir, "OnyxKatar.x"), "OnyxKatar.png")
    write_png(os.path.join(tdir, "OnyxKatar.png"), 512, 512, build_skin())
    n, ic = build_icon()
    write_png(os.path.join(MOD, "textures", "Item_OnyxKatar.png"), n, n, ic)
    print("wrote models_X/weapons/1handed/OnyxKatar.x")
    print("wrote textures/weapons/1handed/OnyxKatar.png")
    print("wrote textures/Item_OnyxKatar.png")
    return 0

if __name__ == "__main__":
    sys.exit(main())
