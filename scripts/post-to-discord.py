#!/usr/bin/env python3
"""Post a text file to a Discord channel as the bot, splitting to fit.

Used by the daily chronicle scheduled task, which writes the story to a file and
then hands it here. Kept separate from the bot so a scheduled run does not need
the bot process at all.

The token is read from ~/Sheogorath/.env and never printed or passed on argv.

Usage:
  post-to-discord.py <channel_id> <file> [--dry-run]
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

LIMIT = 1900  # under Discord's 2000 so a split marker can never overflow
ENV = os.path.expanduser("~/Sheogorath/.env")


def token():
    with open(ENV) as fh:
        for line in fh:
            if line.startswith("DISCORD_TOKEN="):
                return line.split("=", 1)[1].strip()
    sys.exit(f"DISCORD_TOKEN not found in {ENV}")


def split(text, limit=LIMIT):
    """Split on blank lines, then newlines, then hard-wrap. Never mid-word."""
    chunks, cur = [], ""
    for para in text.split("\n\n"):
        candidate = f"{cur}\n\n{para}" if cur else para
        if len(candidate) <= limit:
            cur = candidate
            continue
        if cur:
            chunks.append(cur)
        while len(para) > limit:
            cut = para.rfind("\n", 0, limit)
            if cut <= 0:
                cut = para.rfind(" ", 0, limit)
            if cut <= 0:
                cut = limit
            chunks.append(para[:cut].rstrip())
            para = para[cut:].lstrip()
        cur = para
    if cur:
        chunks.append(cur)
    return [c for c in chunks if c.strip()]


def post(channel, content, tok):
    req = urllib.request.Request(
        f"https://discord.com/api/v10/channels/{channel}/messages",
        data=json.dumps({"content": content}).encode(),
        headers={
            "Authorization": f"Bot {tok}",
            "Content-Type": "application/json",
            # Discord 403s the default urllib agent.
            "User-Agent": "Sheogorath-Chronicle/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def main():
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry = "--dry-run" in sys.argv
    if len(args) != 2:
        sys.exit(__doc__)
    channel, path = args

    with open(path) as fh:
        text = fh.read().strip()
    if not text:
        sys.exit("refusing to post an empty message")

    parts = split(text)
    print(f"{len(text)} chars -> {len(parts)} message(s)")
    for i, p in enumerate(parts, 1):
        print(f"  [{i}] {len(p)} chars | starts: {p.splitlines()[0][:70]!r}")

    if dry:
        print("dry run — nothing posted")
        return

    for i, p in enumerate(parts, 1):
        try:
            msg = post(channel, p, token())
        except urllib.error.HTTPError as err:
            sys.exit(f"part {i} failed: HTTP {err.code} {err.read()[:200]!r}")
        print(f"  posted [{i}] id={msg['id']}")
        if i < len(parts):
            time.sleep(1)  # stay clear of the per-channel rate limit


if __name__ == "__main__":
    main()
