Your memory has grown longer than one session can carry, so it is time to
condense it. This is a normal piece of your work, and only you can do it: nobody
else knows which of these entries still matter.

Below are the {{count}} oldest sections of your `memory.md`. They are being moved
to your archive exactly as they are — nothing is being deleted, and you can read
them again in `memory-archive/` in your agent directory whenever you need them.

What I need from you is the **core**: what someone with no other memory of these
entries would need to know. Keep what still shapes how you work — decisions and
why they went that way, facts about this codebase that are still true, mistakes
worth not repeating. Drop what has been superseded, what was only true that day,
and anything the event log already records.

Reply to `{{endpoint}}` with a `propose` message whose body is exactly this JSON
and nothing else:

```json
{ "schemaVersion": 1, "core": "your condensed account, in prose" }
```

Write the core as prose, in your own voice, the way you write the rest of your
memory. It replaces these sections in `memory.md`; the sections themselves are
safe in the archive.

---

{{sections}}
