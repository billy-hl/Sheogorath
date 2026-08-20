#!/usr/bin/env python3
"""Minimal JVM class-file disassembler, for reading Project Zomboid's jar.

The B42 server's behaviour is repeatedly only knowable from
`gamefiles/java/projectzomboid.jar`, and the bundled jre64 ships no javap, so
this parses the constant pool and each method's Code attribute by hand.

    pzdis.py <Class.class>            list every method and its descriptor
    pzdis.py <Class.class> <method>   disassemble every method of that name

Usage that actually answers questions - unzip the jar once, then sweep a class
for the methods that mention something:

    unzip -q projectzomboid.jar -d /tmp/pz
    f=/tmp/pz/zombie/iso/areas/SafeHouse.class
    for m in $(pzdis.py $f | tail -n +2 | awk '{print $1}' | sort -u); do
        pzdis.py $f "$m" | grep -q setOpenTimer && echo "$m"
    done

Run it on the host that has the jar; it needs nothing but a Python 3.

CAVEAT WORTH THE SAME SUSPICION AS ANY OTHER STATIC READ: what the bytecode says
a method does has already, twice, not matched what the live server does. Use this
to find the call sites and rule levers out, then verify the ones that survive in
game.
"""
import struct
import sys

CP_UTF8, CP_INT, CP_FLOAT, CP_LONG, CP_DOUBLE = 1, 3, 4, 5, 6
CP_CLASS, CP_STRING, CP_FIELD, CP_METHOD, CP_IMETHOD = 7, 8, 9, 10, 11
CP_NAT, CP_MH, CP_MT, CP_DYN, CP_INDY = 12, 15, 16, 17, 18
CP_MODULE, CP_PACKAGE = 19, 20


class Reader:
    def __init__(self, b):
        self.b, self.p = b, 0

    def u1(self):
        v = self.b[self.p]
        self.p += 1
        return v

    def u2(self):
        v = struct.unpack_from(">H", self.b, self.p)[0]
        self.p += 2
        return v

    def u4(self):
        v = struct.unpack_from(">I", self.b, self.p)[0]
        self.p += 4
        return v

    def take(self, n):
        v = self.b[self.p:self.p + n]
        self.p += n
        return v


def parse_pool(r):
    count = r.u2()
    pool = [None] * count
    i = 1
    while i < count:
        tag = r.u1()
        if tag == CP_UTF8:
            pool[i] = ("utf8", r.take(r.u2()).decode("utf-8", "replace"))
        elif tag in (CP_INT, CP_FLOAT):
            pool[i] = ("num", r.u4())
        elif tag in (CP_LONG, CP_DOUBLE):
            pool[i] = ("num", (r.u4() << 32) | r.u4())
        elif tag in (CP_CLASS, CP_STRING, CP_MT, CP_MODULE, CP_PACKAGE):
            pool[i] = ("ref1", tag, r.u2())
        elif tag in (CP_FIELD, CP_METHOD, CP_IMETHOD, CP_NAT, CP_DYN, CP_INDY):
            pool[i] = ("ref2", tag, r.u2(), r.u2())
        elif tag == CP_MH:
            pool[i] = ("mh", r.u1(), r.u2())
        else:
            raise ValueError("unknown constant pool tag %d at %d" % (tag, i))
        # Longs and doubles occupy two slots. Skipping the phantom slot is the
        # classic way to parse the whole pool one entry off.
        i += 2 if tag in (CP_LONG, CP_DOUBLE) else 1
    return pool


def resolve(pool, i):
    e = pool[i]
    if e is None:
        return "?"
    k = e[0]
    if k == "utf8":
        return e[1]
    if k == "num":
        return str(e[1])
    if k == "ref1":
        return resolve(pool, e[2])
    if k == "ref2":
        a, b = resolve(pool, e[2]), resolve(pool, e[3])
        return a + "." + b if e[1] != CP_NAT else a + ":" + b
    return k


# opcode -> (mnemonic, operand bytes, is_cp_index)
OPS = {
    0x00: ("nop", 0, 0), 0x01: ("aconst_null", 0, 0),
    0x02: ("iconst_m1", 0, 0), 0x03: ("iconst_0", 0, 0), 0x04: ("iconst_1", 0, 0),
    0x05: ("iconst_2", 0, 0), 0x06: ("iconst_3", 0, 0), 0x07: ("iconst_4", 0, 0),
    0x08: ("iconst_5", 0, 0), 0x09: ("lconst_0", 0, 0), 0x0a: ("lconst_1", 0, 0),
    0x0b: ("fconst_0", 0, 0), 0x0c: ("fconst_1", 0, 0), 0x0d: ("fconst_2", 0, 0),
    0x0e: ("dconst_0", 0, 0), 0x0f: ("dconst_1", 0, 0),
    0x10: ("bipush", 1, 0), 0x11: ("sipush", 2, 0),
    0x12: ("ldc", 1, 1), 0x13: ("ldc_w", 2, 1), 0x14: ("ldc2_w", 2, 1),
    0x15: ("iload", 1, 0), 0x16: ("lload", 1, 0), 0x17: ("fload", 1, 0),
    0x18: ("dload", 1, 0), 0x19: ("aload", 1, 0),
    0x36: ("istore", 1, 0), 0x37: ("lstore", 1, 0), 0x38: ("fstore", 1, 0),
    0x39: ("dstore", 1, 0), 0x3a: ("astore", 1, 0),
    0x84: ("iinc", 2, 0),
    0x99: ("ifeq", 2, 0), 0x9a: ("ifne", 2, 0), 0x9b: ("iflt", 2, 0),
    0x9c: ("ifge", 2, 0), 0x9d: ("ifgt", 2, 0), 0x9e: ("ifle", 2, 0),
    0x9f: ("if_icmpeq", 2, 0), 0xa0: ("if_icmpne", 2, 0), 0xa1: ("if_icmplt", 2, 0),
    0xa2: ("if_icmpge", 2, 0), 0xa3: ("if_icmpgt", 2, 0), 0xa4: ("if_icmple", 2, 0),
    0xa5: ("if_acmpeq", 2, 0), 0xa6: ("if_acmpne", 2, 0),
    0xa7: ("goto", 2, 0), 0xa8: ("jsr", 2, 0), 0xa9: ("ret", 1, 0),
    0xb2: ("getstatic", 2, 1), 0xb3: ("putstatic", 2, 1),
    0xb4: ("getfield", 2, 1), 0xb5: ("putfield", 2, 1),
    0xb6: ("invokevirtual", 2, 1), 0xb7: ("invokespecial", 2, 1),
    0xb8: ("invokestatic", 2, 1), 0xb9: ("invokeinterface", 4, 1),
    0xba: ("invokedynamic", 4, 1),
    0xbb: ("new", 2, 1), 0xbc: ("newarray", 1, 0), 0xbd: ("anewarray", 2, 1),
    0xc0: ("checkcast", 2, 1), 0xc1: ("instanceof", 2, 1),
    0xc5: ("multianewarray", 3, 1),
    0xc6: ("ifnull", 2, 0), 0xc7: ("ifnonnull", 2, 0),
    0xc8: ("goto_w", 4, 0), 0xc9: ("jsr_w", 4, 0),
}
# Everything not listed above is a zero-operand opcode; name the ones that
# actually carry meaning when reading control flow and leave the rest numeric.
SIMPLE = {
    0x1a: "iload_0", 0x1b: "iload_1", 0x1c: "iload_2", 0x1d: "iload_3",
    0x1e: "lload_0", 0x1f: "lload_1", 0x20: "lload_2", 0x21: "lload_3",
    0x22: "fload_0", 0x23: "fload_1", 0x24: "fload_2", 0x25: "fload_3",
    0x26: "dload_0", 0x27: "dload_1", 0x28: "dload_2", 0x29: "dload_3",
    0x2a: "aload_0", 0x2b: "aload_1", 0x2c: "aload_2", 0x2d: "aload_3",
    0x2e: "iaload", 0x32: "aaload", 0x34: "caload",
    0x3b: "istore_0", 0x3c: "istore_1", 0x3d: "istore_2", 0x3e: "istore_3",
    0x3f: "lstore_0", 0x40: "lstore_1", 0x41: "lstore_2", 0x42: "lstore_3",
    0x4b: "astore_0", 0x4c: "astore_1", 0x4d: "astore_2", 0x4e: "astore_3",
    0x53: "aastore", 0x57: "pop", 0x58: "pop2", 0x59: "dup", 0x5a: "dup_x1",
    0x60: "iadd", 0x64: "isub", 0x68: "imul", 0x6c: "idiv", 0x70: "irem",
    0x74: "ineg", 0x7e: "iand", 0x80: "ior", 0x82: "ixor",
    0x85: "i2l", 0x86: "i2f", 0x87: "i2d", 0x88: "l2i", 0x8b: "f2i", 0x91: "i2b",
    0x94: "lcmp", 0x95: "fcmpl", 0x96: "fcmpg",
    0xac: "ireturn", 0xad: "lreturn", 0xae: "freturn", 0xaf: "dreturn",
    0xb0: "areturn", 0xb1: "return",
    0xbe: "arraylength", 0xbf: "athrow", 0xc2: "monitorenter", 0xc3: "monitorexit",
}


def disasm(code, pool):
    out, i = [], 0
    while i < len(code):
        pc, op = i, code[i]
        i += 1
        if op == 0xc4:  # wide
            op2 = code[i]
            n = 4 if code[i] == 0x84 else 2
            out.append("%5d: wide %s" % (pc, OPS.get(op2, ("op%02x" % op2,))[0]))
            i += 1 + n
            continue
        if op in (0xaa, 0xab):  # tableswitch / lookupswitch
            i += (4 - (i % 4)) % 4
            default = struct.unpack_from(">i", code, i)[0]
            i += 4
            if op == 0xaa:
                lo, hi = struct.unpack_from(">ii", code, i)
                i += 8 + 4 * (hi - lo + 1)
                out.append("%5d: tableswitch %d..%d default->%d" % (pc, lo, hi, pc + default))
            else:
                n = struct.unpack_from(">i", code, i)[0]
                i += 4 + 8 * n
                out.append("%5d: lookupswitch %d pairs default->%d" % (pc, n, pc + default))
            continue
        if op in OPS:
            name, nb, is_cp = OPS[op]
            raw = code[i:i + nb]
            i += nb
            if is_cp:
                # ldc carries a one-byte pool index; every other CP-indexed
                # opcode carries two. Reading one as the other walks the rest of
                # the method off its rails, and only for methods that load a
                # constant -- so the symptom is that those methods appear to
                # reference nothing at all, which is exactly the answer a sweep
                # like the one in the docstring is asking for. Cost an hour.
                idx = raw[0] if nb == 1 else struct.unpack_from(">H", raw, 0)[0]
                out.append("%5d: %-16s #%d  // %s" % (pc, name, idx, resolve(pool, idx)))
            elif nb == 2 and name.startswith(("if", "goto", "jsr")):
                off = struct.unpack_from(">h", raw, 0)[0]
                out.append("%5d: %-16s -> %d" % (pc, name, pc + off))
            elif nb == 0:
                out.append("%5d: %s" % (pc, name))
            else:
                out.append("%5d: %-16s %s" % (pc, name, " ".join(str(b) for b in raw)))
        else:
            out.append("%5d: %s" % (pc, SIMPLE.get(op, "op_%02x" % op)))
    return out


def attributes(r, pool):
    attrs = {}
    for _ in range(r.u2()):
        name = resolve(pool, r.u2())
        attrs.setdefault(name, []).append(r.take(r.u4()))
    return attrs


def main():
    data = open(sys.argv[1], "rb").read()
    r = Reader(data)
    assert r.u4() == 0xCAFEBABE, "not a class file"
    r.u2(), r.u2()
    pool = parse_pool(r)
    r.u2()
    this_class = resolve(pool, r.u2())
    r.u2()
    for _ in range(r.u2()):  # interfaces
        r.u2()
    for _ in range(r.u2()):  # fields
        r.u2(), r.u2(), r.u2()
        attributes(r, pool)

    want = sys.argv[2] if len(sys.argv) > 2 else None
    print("class %s" % this_class)
    for _ in range(r.u2()):
        r.u2()
        name = resolve(pool, r.u2())
        desc = resolve(pool, r.u2())
        attrs = attributes(r, pool)
        if want is None:
            print("  %s %s" % (name, desc))
            continue
        if name != want:
            continue
        print("\n=== %s %s ===" % (name, desc))
        for blob in attrs.get("Code", []):
            cr = Reader(blob)
            cr.u2(), cr.u2()
            code = cr.take(cr.u4())
            for line in disasm(code, pool):
                print("  " + line)
            for _ in range(cr.u2()):  # exception table
                cr.u2(), cr.u2(), cr.u2(), cr.u2()


main()
