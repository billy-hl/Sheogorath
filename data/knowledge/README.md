# Knowledge notes

Markdown files here are read into Sheogorath's context when they match what
someone asked. This directory is for things that don't belong in a player-facing
channel — a question asked weekly that nobody wants pinned, a workaround for a
known crash, the answer to "why can't I loot this safehouse".

**The rules and the connection details do not belong here.** He reads those
straight out of `#rules` and `#server-info`. A copy in this directory would go
stale the first time one is edited and not the other, and the stale copy is the
one he'd quote.

## Format

One file per subject. The first `# heading` is the title, and matches count for
more than the body does, so make it the words someone would actually type. An
optional `tags:` line adds more words to match on.

```markdown
# Why can't I loot this safehouse?

tags: safehouse, loot, raid, containers, locked

Safehouse containers only open for other members while the safehouse OWNER is
online — not just any member. If the owner is offline, everything inside stays
shut, and that is working as intended rather than a bug.
```

## Placement

- Files here are read for every guild.
- Files in a subdirectory named after a guild (`wabbajack/`, `zomboid/`) or its
  ID are read only for that guild.

## Unfinished files are skipped

A file containing `TODO`, `FIXME` or `<fill in>` is ignored entirely, and a line
is logged saying so. A half-written template is not a fact — handed to him, it
becomes a confident answer built around the word TODO. Finish the file or delete
it.

`README.md` is never read. This page is for you, not for him.
