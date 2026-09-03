# M8.2 — The degradation channel

## Problem / motivation

"Fail loud, degrade visible" has been an invariant since M0 (ENGINEERING-
STANDARDS §4, BUILD-PROMPT §3.7): every degradation is a visible UI state and
silent fallback is "the one unforgivable failure mode in this codebase". The
implementation was a `console.warn` plus a fifty-entry in-memory array, shown in
one tooltip. Three things were wrong with it, and each is a different way for a
first-time user to be left with no idea why something failed:

- **It never reached the book of record.** No entry in `log.jsonl` meant a night
  could not be reconstructed, the standup could not mention it, and no forensic
  question about a slow run had an answer.
- **It vanished at restart.** Every morning looked healthy regardless of what the
  company was missing, which is the opposite of the invariant.
- **It was keyed by nothing.** The array held OCCURRENCES, and the pacing check
  reports about once a second, so within a minute it had evicted everything the
  Architect actually needed to see.

The M8 plan puts this package before the rest for that reason: every other M8
package reports its setup failures through this channel, so until it works, a
failure anywhere else is invisible.

## What changed

| File | Change |
|---|---|
| `src/shared/degradation.ts` | **New.** The model: a closed source vocabulary, the `<source>/<slug>` cause type, the log-row schema, the append ladder, and the one line the Architect reads. |
| `src/main/degradations.ts` | **New.** `DegradationLog`: one entry per cause, the ladder, `clear`, and the boot replay. |
| `src/shared/log.ts` | The `degradation` log kind. |
| `src/main/eventlog.ts`, `src/main/agora.ts` | `tailOf` / `tailLog` — the NEWEST entries, which is what a replay needs and what `read`'s forward cursor cannot give. |
| `src/main/index.ts` | The channel replaces the array; all 61 call sites carry a cause; boot replays the tail and flushes rows reported before the Agora existed; the pacing check clears its condition when the company returns to full speed. |
| `src/main/shutdown.ts` | The quit sequence reports causes rather than bare sources. |
| `src/shared/ipc.ts` | `AgoraHealth.runtime` carries cause, count, since and freshness. |
| `src/renderer/src/App.tsx` | Uses the shared line formatter. |
| `test/main/degradations.test.ts` | 22 cases. |
| `test/renderer/degradation-line.test.ts` | 4 cases over the IPC shape the renderer really receives. |
| `test/main/agora.test.ts` | 2 cases for the tail passthrough the boot replay calls. |
| `test/main/eventlog.test.ts` | The documented-kind list gains the twenty-sixth. |
| `docs/sdd/SDD.md` | §4.3 gains the kind and its semantics; §1.1 gains the module. |

## Implementation approach

### A degradation is a state, not an event

That is why it gets its own log kind rather than joining `error` (Architect
decision, 2026-09-03). "Delivery threw" happened once. "Recall is on the grep
rung because there is no index" is a condition the company is *running under*,
and the questions asked of it are different: when did it start, is it still
true, how often, did it ever clear. Only the second kind can be cleared or
replayed, and a bucket holding both answers neither well.

### Dedupe by cause, which is what makes the flood harmless

Every report carries a cause — a short, stable slug naming the condition,
chosen at the call site because only the call site knows which of a subsystem's
problems this is. The pacing line reads `company pacing slow: 5h window at 82%`
and the percentage changes on every tick, so keying on the message would have
defeated the dedupe entirely while looking like it worked; that is the trap the
package plan names, and the test that would have caught a text key asserts an
unrelated entry SURVIVES a five-hundred-report flood.

The ring holds one entry per cause, so three thousand pacing reports are one
entry with a count of three thousand. The cap is therefore on how many distinct
things are wrong, which stays small for real reasons — a noisy condition can no
longer push a quiet one out at all.

The source is derived from the cause rather than passed beside it, so the two
cannot disagree, and `DegradationCause` is a template type over the closed
source list, so a typo is a compile error rather than a second entry for the
same subsystem. Assigning the 61 causes was the bulk of the work and the point
of it: `library` alone had four distinct conditions that a source-keyed dedupe
would have collapsed into whichever spoke last, and per-agent conditions carry
the agent, because two agents stuck is two problems rather than one reported
twice.

### A bounded ladder into an append-only file

`earnsLogLine` appends the first occurrence, then each power of ten, then the
clear. A condition lasting an hour at one report a second costs five lines
instead of 3,600, and those five say what a reader wants to know: it started,
it is still going, it is really still going, it stopped and for how long.
Nothing is ever rewritten to achieve that — append-only (invariant §5) is
untouched, there are simply fewer and more informative appends, which matters
because the log is read from byte zero by every consumer and is already M8.10's
subject. The exact count is always live in the UI, which reads the ring.

### A restart shows what was true when we stopped

At boot the log's tail is replayed and every replayed entry is marked
`carried`, never live: it was true when the company stopped and nothing has
re-checked it. A `cleared` row removes its cause, so a problem fixed before the
last quit does not come back from the dead; the first live report of the same
cause replaces the carried entry, which is how the Architect learns it is still
true; and a live entry is never overwritten by a replayed one, because a report
this session observed is newer than anything the file can say.

The replay reads `tailOf`, a new reader. `read` pages FORWARD from a cursor,
which is right for a consumer catching up and wrong for one asking what is true
now — asking `read` for the newest degradations hands back the oldest, which is
register item B3 and exactly the mistake M8.3 exists to fix at its callers. A
test asserts the difference on a 600-entry log rather than trusting the comment.

### Reporting cannot be the thing that fails

`report` never throws and the append is best-effort: a channel that can fail
while reporting a failure is worse than no channel, so a full disk still leaves
the condition in the ring and on screen. Rows reported before the Agora exists —
boot reports through this channel from its first line, and the book of record
opens a few lines later — wait in a buffer and are flushed in order the moment
it does, because the first-run window is precisely when a setup failure happens.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
npx vitest run test/main/degradations.test.ts test/renderer/degradation-line.test.ts
```

**Production call path** (ENGINEERING-STANDARDS §6.7): `src/main/index.ts`
constructs `DegradationLog` at module scope; `reportDegradation` delegates to it
at 61 sites; boot calls `degradations.replay(agora.tailLog(...))` immediately
after `agora.reconcile()`; the `agora:health` handler serves `degradations.list()`
to `App.tsx`, which renders each entry with `degradationLine`.

**Eight mutations, each killed by a named test and reverted:**

| Mutation | Killed by |
|---|---|
| dedupe by text instead of cause | the flood case, the count case, the distinct-causes case |
| every repeat appends (no ladder) | "appends on a bounded ladder" |
| replay marks entries live | "replays as CARRIED, never as live" |
| replay overwrites a live entry | "never overwrites something this session already observed" |
| a cleared condition returns at boot | "does not replay a condition that had already cleared" |
| the carried marker dropped from the line | the renderer's carried cases |
| the count dropped from the line | the renderer's count cases |
| the tail reads the head | "takes the NEWEST entries — the head is what B3 got wrong" |

## What the coverage ratchet caught, and why it was right

Adding `degradations.ts` to the `agora` subsystem at 93% pulled the row below
its floor, and the M8.0 gate refused the package. That verdict was correct: the
rule is "do not add undertested code to a well-tested subsystem", and moving the
module to a quieter row would have been gaming the map the map exists to
prevent. The gap was real and worth finding — the flood case used a limit LARGER
than the number of causes it created, so the eviction path had never run at all.
Three cases now cover what happens when more things are wrong than the list can
hold, including that a repeat does not renew an entry (age is when a condition
started, not when it last spoke), and the module reaches full line coverage. A
floor lowered by hand instead would have hidden that hole.

## Related docs

- `docs/sdd/SDD.md` §4.3 (the kind) and §1.1 (the module)
- `docs/ENGINEERING-STANDARDS.md` §4 — fail loud, degrade visible
- `docs/PROGRESS.md` — the M8 plan and this package's evidence
