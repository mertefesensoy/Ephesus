# Survival race audit — 2026-09-05

M8.6 correctly connected Artemis, the crew factory and manual respawn to the
standing breaker decision. This follow-up found failures in the asynchronous
intervals surrounding those checks.

## Corrections

- A stopped backoff could wake after `resume()` and start an obsolete attempt.
  A generation now invalidates cancelled waits and their eventual spawn results.
  An old completion cannot clear a newer wait or schedule another attempt.
- The ladder cleared its pending promise before asynchronous spawn completed.
  An exit during setup could therefore overlap another spawn, and `drained()`
  could return too early. Pending now covers the attempt; its exit is folded
  into exactly one subsequent retry after completion.
- A capacity hold arriving during backoff was ignored. The wake now checks the
  hold, refunds the unperformed attempt and remembers the exit for release.
- A manual respawn winning the backoff race could provoke redundant automatic
  attempts. A running lifecycle observation now cancels that queued attempt.
- Changing a crew declaration to `offer` now cancels its existing ladder.
- `AgentManager.respawn` admitted simultaneous callers before a process existed.
  Only an `exited` card can enter respawn; the synchronous transition to
  `starting` reserves it before setup awaits anything.
- A breaker stop arriving during hook installation could be bypassed. The
  manager checks again after installation, before starting the process, and
  unwinds installed hooks on refusal. Failed setup preserves the previous exit
  code and memory offer and refreshes its blocking reason.
- `clearStop` reset the rung but retained rung 2's delivery pause and budget
  constraint. Clearing now releases both constraints as well.

Decisions remain in `src/main/respawn.ts`, `src/main/agents.ts` and
`src/main/watch/breaker.ts`; `src/main/index.ts` and coverage floors are unchanged.
Production entry paths remain the card observers and factory construction in
`index.ts`, Artemis's `RespawnLadder`, and the shared `AgentManager.respawn`
method used by the ladders and IPC.

## Regression evidence

The new cancellation, hold, overlapping ladder attempt, late breaker stop and
overlapping manager respawn tests failed before their fixes. The strengthened
clear-stop test also failed before releasing the two constraints. Controlled
promises verify ordering without sleeps. Additional tests cover old waits versus
new waits, drain completion, manual recovery and declaration changes.

The Artemis integration test drives a real `Breaker` through all three rungs,
then crashes Artemis, forgets session state and releases a capacity hold. It
asserts that no new process starts, the standing decision remains and the
orchestrator seat is reported empty.

Verification commands:

```text
npm run typecheck
npm run lint
node scripts/check-invariants.cjs
npm run test:coverage -- --coverage.reportsDirectory=coverage/survival-audit
node scripts/check-coverage.cjs --summary coverage/survival-audit/coverage-summary.json
```

The separate report directory avoids a Windows lock on the existing `coverage`
directory. It does not change coverage inclusion, thresholds or the gate.

Final Windows run: **3,626 passed, 8 skipped across 190 files**. Typecheck, lint,
invariants and all 17 subsystem coverage gates passed. No coverage floor was
edited. Artemis measured 97.62% lines / 91.30% branches; engines measured 95.68%
lines / 87.14% branches. These are observations, not manually raised floors.

## Remaining boundaries

The restart-persistence and missing-clear-surface findings below were subsequently
closed by [durable breaker stops and explicit recovery](2026-09-05-durable-breaker-stops.md).
They describe the state at this initial audit, before that follow-up.

This is not a guarantee against all future failures. Breaker stops are still
in-memory: M8.8's restart persistence remains unimplemented. `clearStop` is a
tested mechanism, but currently has no production UI/IPC caller; the refusal's
instruction to clear a stop is not yet an end-to-end recovery flow. This audit
does not add that product surface or a persistence format.

Cancelling a ladder invalidates queued work and suppresses retries from an old
in-flight attempt; it cannot undo a process already started by its callback.
Shutdown and deactivation still own process termination. Verification uses real
filesystem integration and controlled spawners, and does not claim a shipped-app
profile activation demo or coverage on operating systems other than Windows.
