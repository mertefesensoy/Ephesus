# The wake watchdog asked a drawing for permission to deliver mail

## Problem / motivation

SRS §6.1's live run on 2026-09-01 stalled for twenty minutes and only a restart
cured it. The cause was a one-line predicate in the composition root:

```ts
// src/main/index.ts, before
isIdle: (agentId) => avatarDirector.get(agentId)?.phase === 'idle',
```

`Hermes.wakeCheck` skips any agent that predicate rejects
(`src/main/hermes.ts:1135`), so **the floor's animation state was the gate on
the company's mail.** That would be merely inelegant if the phase always came
back. It does not:

```ts
// src/shared/avatar.ts
case 'stop': {
  if (snapshot.phase !== 'working' && snapshot.phase !== 'thinking') return snapshot
```

`stop` is **inert unless the agent was mid-tool**. A turn that calls no tool goes
`prompt-submitted → alert` and stays at `alert` forever: never `idle`, never
nudged again, for the life of the process. For an orchestrator whose turn is
"read the mail, reply", that is the *common* path, not an edge case. `session-end`
does not clear it either, so an agent that exits mid-turn is stranded too.

### Why fixing only that would have been worse than leaving it

The nudge is delivered through `commandQueue.submit`, which consults the *same*
phase, and `wakeCheck` takes the mail out of the inbox **before** the nudge is
attempted (`hermes.ts:1142-1146`). So with the predicate fixed and a phase stuck
at `alert`:

- `submit` **holds** the text (`decideCommand` returns `hold` for `alert`), while
  `consumeInbox` has already archived the message to `inbox/.done/`. The mail is
  gone and the nudge never arrives — silent loss, worse than the stall.
- For `ghost`/`stopped`/`archived`, `submit` **throws**. `sweepAndWake` has a
  single `catch` around the whole of itself (`hermes.ts:611`), so the throw
  unwound the loop and skipped **every agent after the failing one**, every tick,
  for as long as the condition lasted. The victim is whoever sits later in
  `knownAgents()` order, silenced by somebody else's dead process.

That is why this is one change and not two.

## What changed

| File | Change |
|---|---|
| `src/main/watch/wake-clock.ts` | New `canDeliverWake(hasProcess, runningMs)` — the predicate, named and pure. |
| `src/main/index.ts` | `isIdle` composes it from `ptyManager.has` and `wakeClock.runningMs`; `nudge` uses the new `wake` path. |
| `src/main/commands.ts` | New `CommandQueue.wake()` — sends without consulting the avatar phase. |
| `src/main/hermes.ts` | A nudge that throws is recorded as `wake-undelivered` and the sweep continues to the next agent. |
| `test/main/pacing-wakes.test.ts` | The predicate's truth table, including that it recovers with no `stop` at all. |
| `test/main/commands.test.ts` | Four cases for `wake`, each one the live run actually hit. |
| `test/main/hermes.test.ts` | The seam: one agent's failed nudge does not silence the agents after it. |

## Implementation approach

### The predicate is two delivery-plane facts, and both are bounded

```ts
export function canDeliverWake(hasProcess: boolean, runningMs: number | null): boolean {
  return hasProcess && runningMs === null
}
```

Boundedness is the whole argument, not tidiness. `WakeClock.ended` closes on
`stop` **or** `session-end` with **no phase guard**, and `began` arms a cap timer
that force-closes an overrunning wake after `DEFAULT_WAKE_CAP_MS` even when every
subsequent hook is lost. So `runningMs` returning to `null` is *guaranteed*. The
avatar phase returning to `idle` never was — that is the entire difference
between the two, and it is why this is a fix rather than a different guess.

It is a **named function** rather than an expression at the call site for one
reason: the predicate it replaces was an inline one-liner in the composition
root, which is exactly how it went untested while silencing agents.
`test/scenarios/s-wake.test.ts` stubs `isIdle` outright and is structurally
unable to see a fault in it, so the suite was green throughout.

**The trade, stated plainly.** A missed `prompt-submitted` now means a nudge
arriving while the agent is mid-turn, where the engine queues it. That is
strictly better than silence forever, and `nudged` still holds it to one nudge
per pending episode.

### `wake` does not ask the floor, and `submit` still does

`submit` is the Architect's door: their words are a conversation, holding them is
a kindness, and the held text is shown back to them (FR-1.3). None of that
changes. `wake` is the router's door, and by the time it is called the delivery
plane has already established that the agent is between turns and the mail is
already out of the inbox. There is no second opinion the floor could offer that
is worth losing a message for.

Held text is deliberately **not** flushed alongside a wake: the Architect's
queued words are still theirs to send, and stapling them to a nudge would put
words in the harness's mouth.

### A failed nudge is now one agent's problem

The mail is already archived by the time the nudge is attempted, so a failure
here **is** a lost message. It is written to the log as `wake-undelivered` with
the reason, and reported through `onSweepError`, rather than swallowed — a
company that goes quiet must not do so with nothing in the book of record. The
deeper ordering fix (write the cursor before archiving) is a separate item and
deliberately not bundled here.

## Design decisions

- **Why not a watchdog that forces the phase back to `idle`?** It would keep a
  rendering state on the delivery path and add a second timer to reconcile with
  the one `WakeClock` already runs. The facts needed already exist and are
  already wired; adding a timer to repair a signal we should not be reading is
  the wrong direction.
- **Why not a `force` flag on `submit`?** A separate method cannot be passed
  accidentally from the IPC path, and the two callers genuinely want different
  behaviour rather than the same behaviour with a modifier.
- **Why keep `avatarDirector` on the floor at all?** It is right for what it was
  built for — drawing. The bug was reading it for something else.

## Verification

```bash
npx vitest run --no-file-parallelism test/main/pacing-wakes.test.ts test/main/commands.test.ts test/main/hermes.test.ts
```

Production call path, per the M6 standing lesson: `src/main/index.ts` composes
`canDeliverWake` into `Hermes`'s `isIdle` and `commandQueue.wake` into its
`nudge`; `src/main/hermes.ts:1135` is the consumer.

**Mutation-checked**, baseline confirmed green first:

| Mutation | Result |
|---|---|
| `wake()` routed back through `submit` (the original B2 bug) | **4 red** |
| Predicate ignores an open wake (`return hasProcess`) | **2 red** |
| Predicate ignores whether a process exists (`return runningMs === null`) | **1 red** |
| A failed nudge rethrows instead of continuing | **1 red** |

Each was applied by asserted string replacement, so a mutation that silently
failed to apply would have been caught rather than scored as survived.

## Related docs

- `docs/adr/ADR-0013-stop-hook-autonomy.md` — the wake watchdog this governs
- `docs/adr/ADR-0023-usage-aware-pacing.md` — `WakeClock` and its cap
- `docs/srs/SRS.md` — FR-1.3 (held text), FR-3.5 (the nudge), §6.1 (the run this unblocks)
- `docs/PROGRESS.md` — the M7 exit gap this closes
