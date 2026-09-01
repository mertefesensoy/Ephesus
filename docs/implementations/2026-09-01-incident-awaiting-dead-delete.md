# Remove a dead delete from the incident triage path

**Date:** 2026-09-01
**Branch:** `fix/incident-awaiting-dead-delete`
**Files touched:** 1 (one line removed, three comment lines added)

## Problem / Motivation

`IncidentEndpoint.onTriage` cleared the incident it had just triaged out of the
`awaiting` map with two statements:

```ts
this.awaiting.delete(incident.key)
for (const [key, value] of this.awaiting) {
  if (value.key === incident.key) this.awaiting.delete(key)
}
```

The first one deletes nothing, ever. `awaiting` is `Map<string, Incident>` keyed
by the **message id** the triage request went out under — `send()` does
`this.awaiting.set(msgId, incident)` and that is the only write. `incident.key`
is a different namespace entirely: `incidentKey()` builds `<repo>#<kind>:<ref>`
(`owner/app#ci-run:4021`), while `makeMessageId()` builds
`<iso-stamp>-inc<base36 ref>`. No value of one can ever be a value of the other,
so the lookup misses by construction and the loop underneath does the whole job.

This was found by mutation testing: deleting the first line leaves the entire
suite green, which is the definition of a line no behaviour depends on.

It is harmless at runtime, and that is exactly what makes it worth removing. A
reader arriving at this block reads the delete as the clearing step and the loop
as a mop-up for stragglers. The truth is the reverse. A future edit that
"simplifies away the redundant loop" would silently break single-escalation —
the property `does not act twice on one incident` exists to protect.

## What Changed

| File | Change |
|---|---|
| `src/main/incidents.ts` | Removed the no-op `this.awaiting.delete(incident.key)` from `onTriage`; added a three-line comment stating why the surviving loop clears by value rather than by key. |

## Implementation Approach

The smaller of the two available fixes. The alternative — re-keying `awaiting`
by `incident.key` so a direct delete works and the loop can go — was rejected;
see below.

The comment is the substantive half of this change. The bug being fixed is a
misreading risk, not a defect, so removing the line without saying why the
remaining loop looks roundabout would leave the next reader with the same
question and no answer.

Note that `raised` is add-only and is checked before `send()`, so within one
process lifetime there is at most one `awaiting` entry per incident key; the
loop is a scan that finds one entry, not a multi-entry sweep.

## Design Decisions

**Rejected: re-key `awaiting` by `incident.key` and drop the loop.** It would
make the deleted line the correct one, but `onTriage` resolves the incident by
`this.awaiting.get(message.in_reply_to)` first — an O(1) hit on the msgId key,
and the only path that is correct when two incidents somehow share a key claim.
Re-keying would demote that lookup to the value scan that is currently the
fallback, changing behaviour on the reply path to fix a line that does nothing.
Wrong trade for a cleanup.

**Rejected: leave it as defensive code.** It defends against nothing: not a
type the map can hold, not a state the code can reach. Dead code that reads as
live code is a maintenance liability, not a safety margin.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npx vitest run test/main/incidents.test.ts
```

All four green (19/19 tests).

Mutation check on the surviving loop — replace the `for` body with a comment and
re-run `test/main/incidents.test.ts`:

- `does not act twice on one incident` **fails** at `incidents.test.ts:339`, with
  the second `onTriage(report)` returning a severity-1 escalation instead of
  `null`. 1 failed | 18 passed.

That is the asymmetry this change is about: removing the deleted line keeps the
suite green, removing the loop turns it red. The loop was doing the work.

Note for anyone re-running this in a fresh worktree: `npm run typecheck` fails
on `test/renderer/emotes.test.ts` unless the gitignored tileset assets under
`src/renderer/src/assets/tileset/` are copied in from the main checkout. That is
an untracked-asset gap, unrelated to this change.

## Related Docs

- `docs/sdd/SDD.md` §7.3 — the escalation path this endpoint feeds.
- `fix/reserved-endpoint-routing` (commit 1aee1a9, not yet merged here) carries
  the other in-flight change to `onTriage` — a refuse/agree branch inserted above
  this block. Different lines; the two should merge cleanly.
