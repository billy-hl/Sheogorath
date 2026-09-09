#!/usr/bin/env python3
"""Structural sanity check for the Lua in pzmods/.

There is no Lua interpreter on either the dev Mac or Leviathan, and the game's
own Lua only reports a syntax error by refusing to load the file at boot -- which
on this server costs a restart to discover. This catches the class of mistake
that mechanical edits actually produce: an unbalanced block keyword, an unclosed
bracket, an unterminated string or long comment.

It is NOT a parser. It will not catch a bad expression, a nil call, or a typo in
an identifier -- only structure. A clean run means "worth publishing", never
"correct".

    lua-check.py <file.lua> [...]      exit 1 if anything is unbalanced
"""
import re
import sys

# Opens a block that `end` closes. `for` and `while` are deliberately absent:
# their own `do` is counted instead, so counting them too would double up.
OPENERS = {"function", "if", "do"}
KEYWORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def strip(src, path):
    """Blank out comments and string literals, keeping newlines for line numbers."""
    out = []
    i, n, line = 0, len(src), 1
    while i < n:
        c = src[i]

        # Long bracket [[ ]] / [==[ ]==], as a comment or as a string.
        m = re.match(r"--\[(=*)\[", src[i:]) or re.match(r"\[(=*)\[", src[i:])
        if m:
            close = "]" + m.group(1) + "]"
            end = src.find(close, i + m.end())
            if end == -1:
                raise SystemExit("%s:%d: unterminated long bracket" % (path, line))
            chunk = src[i:end + len(close)]
            line += chunk.count("\n")
            out.append("\n" * chunk.count("\n"))
            i = end + len(close)
            continue

        if src.startswith("--", i):
            end = src.find("\n", i)
            i = n if end == -1 else end
            continue

        if c in "\"'":
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "\n":
                    raise SystemExit("%s:%d: unterminated string" % (path, line))
                if src[j] == c:
                    break
                j += 1
            else:
                raise SystemExit("%s:%d: unterminated string" % (path, line))
            i = j + 1
            continue

        if c == "\n":
            line += 1
        out.append(c)
        i += 1
    return "".join(out)


def check(path):
    src = open(path, encoding="utf-8").read()
    code = strip(src, path)
    problems = []

    depth = {"end": 0, "repeat": 0}
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack = []

    for lineno, text in enumerate(code.split("\n"), 1):
        for word in KEYWORD.findall(text):
            if word in OPENERS:
                depth["end"] += 1
            elif word == "end":
                depth["end"] -= 1
                if depth["end"] < 0:
                    problems.append("%s:%d: 'end' with no matching block" % (path, lineno))
                    depth["end"] = 0
            elif word == "repeat":
                depth["repeat"] += 1
            elif word == "until":
                depth["repeat"] -= 1
                if depth["repeat"] < 0:
                    problems.append("%s:%d: 'until' with no 'repeat'" % (path, lineno))
                    depth["repeat"] = 0
        for ch in text:
            if ch in pairs:
                stack.append((ch, lineno))
            elif ch in ")]}":
                if not stack:
                    problems.append("%s:%d: stray '%s'" % (path, lineno, ch))
                elif pairs[stack[-1][0]] != ch:
                    open_ch, open_line = stack.pop()
                    problems.append("%s:%d: '%s' closes '%s' opened on line %d"
                                    % (path, lineno, ch, open_ch, open_line))
                else:
                    stack.pop()

    if depth["end"] > 0:
        problems.append("%s: %d block(s) never closed by 'end'" % (path, depth["end"]))
    if depth["repeat"] > 0:
        problems.append("%s: %d 'repeat' without 'until'" % (path, depth["repeat"]))
    for open_ch, open_line in stack:
        problems.append("%s:%d: '%s' never closed" % (path, open_line, open_ch))
    return problems


def main():
    failed = 0
    for path in sys.argv[1:]:
        problems = check(path)
        if problems:
            failed += 1
            for p in problems:
                print(p)
        else:
            print("ok   %s" % path)
    if failed:
        print("\n%d file(s) with structural problems" % failed)
    sys.exit(1 if failed else 0)


main()
