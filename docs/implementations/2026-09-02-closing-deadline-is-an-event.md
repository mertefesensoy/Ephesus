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

## The three siblings: a different failure, left unchanged

The M6 doc lists `s-livelock`, `s-stoploop` and `s-wake` beside `s-closing`. They
are **a different failure**, and no code was changed for them — but the first
version of this section reached that conclusion through arithmetic that did not
hold, which is corrected below.

Those three carry no deadline, no `setTimeout` and no timing constant — they are
loop-shaped tests that pay a real round-trip per iteration (S-LIVELOCK's ping-pong
to the hop cap, S-STOPLOOP's continuations to the block cap). They exceeded
vitest's old 5 s default because they are *slow*, not because they race, and
`39aad30` raised `testTimeout` to 30 s.

Being listed together made them look like one family. They are two: a timeout
that a bigger budget fixes, and a race that no budget can. That distinction holds,
and it is the useful half of this section.

### Correction: "nothing there" was too strong, and the numbers behind it were wrong

This section first justified leaving the three alone with "4.65 s, 10.89 s and
3.84 s against that 30 s ceiling". **Both the figures and the comparison were
wrong**, and it took four people five passes to land the right one — each error
caught by someone other than whoever made it.

- Those were **file totals**. `testTimeout` applies **per test**. A run of
  `closing.test.ts` with its scheduler disarmed produced three separate 30 s
  timeouts inside one file, with no file-level timeout — the ceiling never sees a
  file total at all.
- The per-test figures were then measured **isolated**, which flatters the margin
  badly, because CI runs the whole suite in parallel.

Slowest single test, `--reporter=verbose`, same machine:

```text
isolated, warm repeat   ~3.1 s
isolated, cold shell    ~11 s
FULL SUITE, default parallelism, machine quiet, n=12:
  10.2  10.3  10.3  10.9  11.0  11.6
  11.6  11.9  12.3  12.4  13.4  17.3   s  <- the condition that matters
```

A body of 10.2–13.4 s and **one excursion at 17.3 s**, not reproduced in the
seven runs that followed it. Headroom is 1.7× against the excursion, 2.2× against
the body.

At n=5 the worst had risen with every increase in sample size (13.4 s at n=2,
17.3 s at n=5) and that looked like a tail. Seven more samples did not extend it,
so it is one excursion, not a tail — which is only knowable by sampling past the
point where the answer looked settled.

**The metric has to be restricted to these two files.** "Slowest test in the
suite" has a ~10.3 s floor that is nothing to do with load: `tmpdir.test.ts`'s
`still throws when nothing is going to release the directory` waits out the whole
`TEMP_REMOVE_BUDGET_MS` by construction and measures 10.25–10.39 s whatever else
is running. Any ~10.3 s sample taken unrestricted is that test. Ours were
restricted and verified against the raw logs — the 17.3 s is
`honours the hard block cap`, and the 10.3 s low is `signals the breaker at rung
1`, coincidentally sitting on that floor without being it.

S-LIVELOCK's worst is 9.0–11.0 s — the same band — so the earlier claim that it
was "in much better shape" was also an artifact of isolated measurement, and is
withdrawn.

The conclusion survives: the suite is green under real parallelism across twelve
full runs, nothing within 12 s of the ceiling, so nothing is changed for the three. But
the ceiling is **reachable** — three concurrent scenario suites hit it 3/3 — so
this is a live margin rather than an unreachable one. `vitest.config.mts` now
records the distribution and the condition instead of a single figure, because a
figure invites the next person to compare it against whatever they happen to
measure. That is exactly how five wrong answers happened.

## Related docs

- `docs/adr/ADR-0015-gymnasium-self-improvement.md` — GYM-003, closing time
- `docs/implementations/2026-08-29-m6-floor-face-and-herald.md` §250 — where the
  four were first recorded together
- `docs/implementations/2026-09-01-flaky-temp-dir-teardown.md` — the 30 s
  `testTimeout` and the other Windows child-process trap
