# The fake spawner was throwing away the reason

**Date:** 2026-09-01 · **Branch:** `fix/spawner-swallows-child-failure`

## Problem / Motivation

`test/fakes/process-spawner.ts` stands in for `PtyManager` under the Node test
runner. It discarded every signal a failing child produced:

```ts
child.stderr?.resume()                              // stderr → nowhere
child.on('error', () => this.children.delete(id))   // could not start → silence
```

`stderr` is where a dying process says why. `error` is the event Node emits when
a process **could not be spawned at all** — and swallowing it meant no record, no
exit, and a manager left believing an agent existed that never had.

The cost was measured. On 2026-09-01 a quoting bug in the engine version probe
sent every spawn down the FR-1.6 install branch, and seven tests across
`agent-worktree` and `s-crash` failed as:

```text
worktree: timed out waiting for the agent to start
expected 'installing' to be 'running'
```

Nothing anywhere named the probe. The cause was found only by editing this file
by hand to print what it was discarding, which produced the answer in one line.
Test infrastructure that hides why a test failed costs more than the test is
worth.

## What changed

| File | Change |
|---|---|
| `test/fakes/process-spawner.ts` | Captures `stderr`; records spawn failures; reaps a spawn that never started; adds `stderrOf`, `failureOf`, `diagnose`. |
| `test/fakes/process-spawner.test.ts` | **New.** Pins the concealment shut. |
| `test/main/agent-worktree.test.ts` | `until` reports `diagnose()` on timeout. |
| `test/scenarios/s-crash.test.ts` | Same. |

### The timeout now names the cause

A child that cannot start:

```text
worktree: timed out waiting for the agent to start
agent.mason: cwd=…\worktrees\agent.mason | argv=definitely-not-a-real-binary … |
  SPAWN FAILED: spawn definitely-not-a-real-binary ENOENT | stdout=(empty) | stderr=(empty)
```

A child that starts, complains, and dies:

```text
agent.mason: cwd=…\worktrees\agent.mason | argv=…node.exe -e … | exit=3 signal=none |
  stdout=(empty) | stderr="engine: config missing at /etc/nope"
```

Both were verified by deliberately breaking the fake adapter's argv, not asserted
from the shape of the code.

## Design decisions

**Reap a spawn that never started.** The old code deleted the child and returned,
leaving a phantom. Reaping is the faithful direction rather than a liberty:
production fails *louder*, not quieter — `pty.spawn` throws synchronously out of
`PtyManager.spawnAgent`, so a failed spawn there is an exception the manager must
handle. `child_process` only emits an async `error`, and silence was the least
faithful of the available answers.

**Keep stdout and stderr separate, even though a PTY merges them.** `PtyManager`
hands the Architect one stream, so in production nothing a child prints is
invisible — which is the fidelity argument for capturing stderr at all. But
`stdoutOf` is asserted against in both scenario files, and folding stderr into it
would let a stray diagnostic line satisfy an assertion about what the agent
*said*. `diagnose()` reports both.

**`diagnose()` never throws and never blocks.** It is called from the unhappy
path, where an exception of its own would bury the failure it exists to explain.

**A module-level `live` rig rather than threading a diagnosis through `until`.**
`until` is called ten times in one file and eleven in the other; passing a
diagnosis to each would bury the change in mechanical edits. Safe because vitest
runs the tests within one file sequentially, and `startRig` reassigns it per
test. Documented at both declarations.

## Verification

```bash
npx vitest run test/fakes/process-spawner.test.ts test/main/agent-worktree.test.ts test/scenarios/s-crash.test.ts
```

16 passed.

### Mutation checks

| Mutation | Result |
|---|---|
| Restore `stderr.resume()` | **2 red** |
| Restore `on('error', () => children.delete(id))` | **5 red** |
| Remove the `reaped` guard | **SURVIVED — see below** |

**Two of these found flaws in the tests themselves, not the code.**

Mutation 1 initially turned only **1** red. The `diagnose()` stderr assertion was
`toContain('config missing')`, and the child was `node -e 'console.error("config
missing")'` — so the string is also in the **argv**, which `diagnose` prints. The
assertion passed on the echoed command line with stderr capture ripped out. It
now asserts against the `stderr="…"` field specifically, and mutation 1 turns 2
red.

Mutation 3 **survived**, and the test that claimed to cover it has been removed
rather than kept. The `reaped` guard defends a documented Node behaviour — `exit`
may or may not follow `error` — but on Windows/node 20 an ENOENT spawn fires
`error` and no `exit`, so the guard is not exercised here and no test on this
platform can catch its removal. The guard stays (it is correct where the
behaviour does occur) and the surviving single-element assertion would catch a
double report on a platform that sends both; the limitation is stated in the test
file rather than implied. A test that reads as pinning something it is
structurally unable to pin is worse than no test.

## Known-unfixed

- `PtyManager` itself has no equivalent diagnosis. It does not need one — a PTY
  streams everything to the Architect's terminal by construction — but the
  asymmetry is worth knowing when reading the two side by side.

## Related docs

- `docs/TEST-STRATEGY.md` §2–3 — real fs, real processes, S-CRASH
- `docs/adr/ADR-0009-engine-adapters.md` — `SpawnPlan` and the spawner seam
- `docs/implementations/2026-09-01-version-probe-shell-quoting.md` — the bug this
  silence concealed
