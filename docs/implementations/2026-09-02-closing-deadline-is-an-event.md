# Closing time's deadline is an event, not a duration

**Date:** 2026-09-02 · **Branch:** `fix/closing-deadline-deterministic-clock`

## Problem / Motivation

`S-CLOSING > proceeds at the deadline with the silent agent in the report and
the log` failed intermittently for days. It was recorded as a parallel-load flake
in `docs/implementations/2026-08-29-m6-floor-face-and-herald.md:250`, and measured
at 3/3 failures on a loaded machine against 202/202 passing on a drained one.

The test asked for a 500 ms wall-clock deadline and then did an agent's **real**
work inside that window:

```ts
const eph = await company(500)
const done = eph.closing.begin()
await eph.runTurn('agent.mason', packUp('agent.mason'))  // spawns a real engine
await eph.hermes.sweep()
const report = await done
```

`runTurn` spawns a fake-engine child process that reads its inbox, appends
`memory.md` and writes an outbox message; `sweep()` then routes the ack. On a
busy machine that exceeds 500 ms, the deadline fires first, and the report comes
back with nobody acked:

```text
AssertionError: expected [] to deeply equal [ 'agent.mason' ]
```

**The test was never really about 500 ms.** It is about what the report says when
one agent answers and one does not — an *ordering*, not a duration. On a wall
clock the ack and the deadline were in a race, so the assertion actually being
made was "500 ms is enough on this machine".

## Reproducing it on demand

Waiting for a loaded machine is a poor way to confirm a race. Shrinking the
deadline forces it deterministically:

```ts
const eph = await company(1)   // was company(500)
```

That fails 100% of the time with the identical assertion, which both proves the
mechanism and settles the design question: **a bigger constant only moves the
threshold.** Raising 500 to 5000 would have hidden this until the next busy
machine.

## What changed

| File | Change |
|---|---|
| `src/main/closing.ts` | `ClosingTimeOptions.schedule?(fire, afterMs): () => void` — arms the deadline, returns its disarm. Defaults to `setTimeout`/`clearTimeout`, `unref` preserved. `ActiveClosing.timer` → `disarm`. |
| `test/scenarios/company.ts` | `manualClosingDeadline` option; `Company.tripClosingDeadline()` fires the armed deadline and returns false when none is armed. |
| `test/scenarios/s-closing.test.ts` | Lets mason's ack land, then trips the deadline. |
| `test/scenarios/s-blackout.test.ts` | Its `Company` literal gains the new member, returning false — nothing there begins a closing. |

The scenario now reads as the ordering it always meant:

```ts
await eph.runTurn('agent.mason', packUp('agent.mason'))
await eph.hermes.sweep()
expect(eph.tripClosingDeadline()).toBe(true)   // now, and only now, time runs out
```

## Design decisions

**Inject the scheduler, not just the clock.** `ClosingTime` already accepted
`now?()`, but the deadline was a bare `setTimeout`, so injecting the clock did
nothing for it. `now` governs what the log and message ids *say*; `schedule`
governs when the deadline *fires*, and only the second one was racing.

**`tripClosingDeadline()` returns false when nothing is armed** rather than
throwing or silently succeeding. A scenario that tripped a deadline which never
existed would be asserting against nothing, and would pass for the wrong reason.

**The default preserves `timer.unref()`.** A pending closing must never be the
reason the process stays alive. Dropping that in the refactor would have been an
invisible production regression behind a green suite.

**The scenario is manual; the unit test stays on the wall clock.** Making
everything deterministic would leave the real `setTimeout` path unexercised. It
is not: `test/main/closing.test.ts` still drives the default scheduler at
`deadlineMs: 150`–`200`, and can do so safely because nothing races it there —
no child processes, no git, just `noteReply` calls. The race only ever existed
where real work shared the window.

## Verification

```bash
npx vitest run test/main/closing.test.ts test/scenarios/s-closing.test.ts test/scenarios/s-blackout.test.ts
```

19 passed.

**The strongest evidence:** with the fix in place, the scenario passes at
`company(1)` — the value that previously failed every time. The duration no
longer matters, because the deadline is no longer a duration.

### Mutation checks

| Mutation | Result |
|---|---|
| Default scheduler never arms | **3 red** in `closing.test.ts` — the wall-clock path is still pinned |
| Remove the `tripClosingDeadline()` call from the scenario | **1 red** (hangs to the 30 s ceiling) — the trip is load-bearing |

The first exists to answer a specific objection: that driving the clock in the
scenario leaves the production timer untested. It does not, and this is the check
that proves it rather than asserting it.

## The three siblings: nothing to do, and why

The M6 doc lists `s-livelock`, `s-stoploop` and `s-wake` beside `s-closing`. They
were **a different failure**, and they are already fixed.

Those three carry no deadline, no `setTimeout` and no timing constant — they are
loop-shaped tests that pay a real round-trip per iteration (S-LIVELOCK's ping-pong
to the hop cap, S-STOPLOOP's continuations to the block cap). They exceeded
vitest's old 5 s default because they are *slow*, not because they race, and
`39aad30` raised `testTimeout` to 30 s. Measured now, in isolation: 4.65 s, 10.89 s
and 3.84 s of test time against that 30 s ceiling.

Being listed together made them look like one family. They are two: a timeout
that a bigger budget fixes, and a race that no budget can. Nothing was changed for
the three, because nothing is broken in them.

## Related docs

- `docs/adr/ADR-0015-gymnasium-self-improvement.md` — GYM-003, closing time
- `docs/implementations/2026-08-29-m6-floor-face-and-herald.md` §250 — where the
  four were first recorded together
- `docs/implementations/2026-09-01-flaky-temp-dir-teardown.md` — the 30 s
  `testTimeout` and the other Windows child-process trap
