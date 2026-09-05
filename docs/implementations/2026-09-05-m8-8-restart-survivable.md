# M8.8 — a restart is survivable

## Problem

The company's coordination state was in-memory maps with no boot replay, so a
restart silently un-hired it. Two consequences were worse than "state is lost".

**A gate opened at 3am blocked its task forever.** The gate was in memory; the
BLOCK is durable — `tasks.json` carries `task.gates`, and `src/shared/tasks.ts`
refuses `done` while that array is non-empty. After a restart the approvals
queue was empty and the block was not, so the task could never close and there
was no way back but hand-editing the book of record.

**Nothing said the watch had stopped.** The Harbor stopped watching, every armed
trigger was gone, and profile autonomy stopped composing into gates — with no
degradation raised anywhere. The company looked healthy and was not.

## What the register got right, and what it did not

The 2026-09-02 register listed five things as lost. **Two needed durability.
Three did not, and building stores for them would have added state the tree
already answers better.** Each refutation is a decision already recorded in the
code, found by reading it rather than by trusting the list.

| Register item | Verdict |
|---|---|
| Activations | **Lost.** Now durable. |
| Open gates + verdicts | **Lost.** Now durable. |
| Trigger last-fired | **Lost.** Now durable. |
| Incident correlation | **Not lost — deliberate.** |
| Capacity parks | **Not lost — derived.** |
| Breaker rungs 1–2 | **Not lost — an observation about a dead process.** |

- **Incident correlation** is in memory *by a recorded decision* (`incidents.ts`,
  the `raised` set): a restart SHOULD re-raise a still-failing incident, because
  nobody can be sure the earlier triage request survived in an inbox, and a
  duplicate incident is a cheap failure while a dropped one is the subsystem not
  working. Persisting it would have quietly reversed that decision.
- **Capacity parks** are derived, not held. `CapacityWatch` re-reads the tail of
  each transcript every tick and re-parks from the same refusal record — that is
  exactly what its `handled` set exists to deduplicate — and it iterates LIVE
  agents, of which a restart has none. *Known bounded loss, recorded not fixed:*
  the retry `attempts` rung resets, so the first retry after a restart comes
  sooner than the ladder intended; the next refusal re-parks one rung higher, so
  it self-corrects.
- **Breaker rungs 1–2** are computed from a process's own turn spans. A rehired
  agent is a new process that has not looped, has not errored and has no hop
  escalations, so restoring a rung onto it would assert a condition that is not
  true of it. Rung-3 **stops** are different in kind — a standing decision about
  an agent *identity* — which is precisely why M8.6 persisted those and only
  those. The register recorded "breaker rungs" as lost wholesale; that is half
  right, and the half matters.

**The decisions below are recorded normatively in [ADR-0027](../adr/ADR-0027-what-survives-a-restart.md);
this doc records how they were implemented and what it cost to prove.**

## Architect decisions (2026-09-05)

Both were put with their alternatives and their costs before any code was written.

1. **Per-subsystem stores plus one replay module** — not a single `session.json`
   snapshot (which would tie fast-changing state to slow-changing state
   permanently, and lose everything to one corrupt file), and not a rebuild from
   `log.jsonl` (a good milestone, but rotation is M8.10 and unbuilt, an overnight
   log already parses in 306 ms on the main loop, and some state is not in the
   log at all).
2. **Restore the activation; do NOT auto-respawn the crew.** Without engine
   session recovery a respawned agent is amnesiac: it re-reads its mailbox and
   redoes in-flight work, which is the double-processing SRS §6 criterion 6
   forbids. `--resume` is owed, stated below, not quietly skipped.

## What changed

| File | Change |
|---|---|
| `src/main/state-store.ts` | **New.** `JsonStateStore<T>`: one durable-record mechanism, generalising the M8.6 breaker-stop store. |
| `src/main/restore.ts` | **New.** The boot replay — owns the order and the reporting; `activationsRecord` owns the one cast. |
| `src/shared/restart.ts` | **New.** The trigger-clock record, and the three refutations above written where the next reader will look. |
| `src/shared/profile-activation.ts` | Plan schemas (`activationPlanSchema` and four composites) + `activationsRecordSchema`. |
| `src/shared/gates.ts` | `gatesRecordSchema`, `SETTLED_GATE_LIMIT`, and the pure `reconcileGates`. |
| `src/shared/degradation.ts` | New `restart` degradation source. |
| `src/main/profiles.ts` | `ProfileInstance.crew`, `restore()`, `persist` seam; `activate` takes over a `down` instance. |
| `src/main/watch/gates.ts` | `persist` seam, `restore()`, bounded settled list. |
| `src/main/scheduler.ts` | One last-fired clock (was two), `restore()`, `persist` seam. |
| `src/main/index.ts` | The three stores, the three `persist` wirings, and the replay call. |
| `scripts/coverage-floors.json` | The three new modules assigned to `boot`. |
| `test/scenarios/s-blackout.test.ts` | Restarts holding an activation, a gate and a trigger clock. |

## Implementation approach

### Absent is not damaged

`JsonStateStore.load` never throws — boot runs before the window exists, and a
throw there is a dead app rather than a degraded one (FR-5.4). It returns three
outcomes, and the distinction between the last two is the whole point:

- absent → `{ ok: true, value: empty, seeded: false }` — an ordinary first run.
- parsed → `{ ok: true, value, seeded: true }`.
- damaged → `{ ok: false, because }` — state exists that can no longer be read.

Collapsing absent into damaged is how a restart that restored nothing looks
healthy. `save` validates *before* writing, because a store that can write what
it cannot load is a restart failure with a one-boot delay.

`FileBreakerStopStore` is deliberately NOT migrated onto this: its `load` throws
by design, because a breaker stop that cannot be read must block every start
rather than degrade. That is a safety contract this class does not offer, and
the duplication is a decision rather than an oversight.

### `crew`, and why it is a field

A restored instance comes back with `crew: 'down'`. Two things depend on it and
both are silent when wrong:

- An armed schedule trigger wakes `trigger.agentId`. Arming one for an agent
  that does not exist is a wake into the void once per interval, forever.
- `activate` refuses a duplicate instance (FR-9.4). Without `crew`, a restored
  instance would block the very reactivation that brings its crew back — the
  restore would have replaced one stuck state with a worse one. A `down`
  instance is taken over; a `live` one is still refused.

### The plan is restored verbatim

`ActivationPlan` is persisted as-is rather than re-derived: it records what the
Architect approved, and re-deriving would let a bundle edited between activation
and restart silently change autonomy or grants. "Restore exactly" (NFR-5) is a
claim about the approved plan, not about the current contents of `profiles/`.

### The gate reconcile reports and never releases

`reconcileGates` is pure and total. A durable block whose gate is in neither the
open nor the settled set is an **orphan**, reported by task id. Auto-clearing it
would approve an action no human ever saw (NFR-9), so it discloses only.

`settled` is restored as well as `open`, and that half is what stops
double-processing: `decide` answers "was already approved" from it, and a
restart that dropped it turned every answered gate back into "no open gate" — a
different answer to the same question. It is bounded at 1000, newest kept.

### One clock, not two that must agree

The scheduler's last-fired time began as a second copy beside
`Registered.lastFiredMs`. A mutation pass proved the pair unfalsifiable: `tick`
wrote both to the same value, so no test could tell which one `add` preferred.
Two fields that can never disagree are one field with a latent bug, so the
duplicate was removed rather than a contrived test written for it. **The
surviving mutant was the evidence, and the fix was in the production code.**

## Verification

Run at `2dfb0c6` + this branch, on win32:

```
typecheck    green (all four projects)
lint         green
invariants   ok — reachability 173/181 (was 170/178: all three new modules reachable)
attribution  ok — 343 commits, 199 on main's first-parent chain
tests        3777 passed / 8 skipped (3785) across 199 files  [baseline 3703/8 (3711), 194 files]
coverage     coverage floors ok (17 subsystems on win32; 22 untested modules, all recorded)
```

**IT WAS RUN, NOT ONLY TESTED.** `npm run dev` twice over the Architect's own
`~/.ephesus`. The first boot wrote `triggers.json` through the real store —
`schemaVersion: 1` and four real triggers (`standup`, `retro`,
`library.reflection`, `gym-metric-check`). The app was then killed and started
again, and the second boot restored them and said so in the book of record:

```json
{"kind":"profile","event":"restored",
 "detail":"restored the last-fired clock for 4 trigger(s)","ts":1788631839930,"seq":1224}
```

That is the whole path in the shipped app — boot, replay, restore, log entry —
and not a scenario rig. It does NOT close M7's exit, which needs a real profile
activated against a real target; it does close the question of whether this
package's boot wiring works outside a test.

**Reachability is the wiring proof.** 170/178 → 173/181 means all three new
modules are loadable from the three electron-vite entry points — this is not
another M6, where 1406 lines shipped that nothing could reach.

**68 new tests**, and the scenario is the one that matters: S-BLACKOUT now
restarts holding an activation, a gate and a trigger clock. Every case above it
restarts a company holding NOTHING (`liveAgents: () => []`, a fresh deny-all
`GateManager`), which is why this entire class of defect was invisible to a
green suite for the whole life of the project.

**35 mutations, every one killed or resolved**, each reverted:

- 9 over the activation restore (arming a restored trigger, restoring `crew` as
  live, displacing a live instance, dropping each persist, the rehire path).
- 10 over the gates (dropping either persist, dropping the settled half,
  re-announcing a restored gate, unbounding the list, keeping the oldest instead
  of the newest, and four over the reconcile).
- 10 over the replay and the scheduler (giving up on the first damaged record,
  swapping absent for damaged in both directions, writing an unloadable record,
  skipping the reconcile, persisting after the await instead of before).
- 3 over the collapsed clock.

Two of those found real weaknesses **in this package's own tests** rather than
in the code, which is the pass working in the direction that matters:

1. `expect(ids).toEqual([...ids].sort())` was asserting that the settled list is
   sorted — true whether the bound keeps the oldest or the newest, so it could
   not fail. Replaced with an assertion naming which five ids fell off.
2. The `add` precedence mutant survived because it was *equivalent*; the fix was
   to delete the duplicated field, not to write a test for an unobservable
   difference.

**The compile-time shape proof caught two real drifts while this was written** —
`crew` missing from `profileInstanceSchema`, and a smuggled field in a
refutation run. `test/**` is inside `tsconfig.node.json`, so a schema that drifts
from its interface fails the build, not a test run: the failure it prevents (a
plan written with a field the next boot silently drops) is invisible until a
restart that may be weeks away.

**The M8.0 seam rule fired once and was right.** The three new modules belonged
to no subsystem, and the suite refused them until they were assigned — the same
check that caught M8.7b twice.

### A defect this package shipped, found in self-review

The first draft of the boot wiring read the durable blocks like this:

```ts
try { return agora.tasks().tasks.map(…) } catch { return null }
```

**`Agora.tasks()` does not throw on a corrupt ledger.** It returns the empty one
and records the file in `fileWarnings()` — deliberately, so a bad file is never
destroyed by being treated as an error (`readSchemaFile`, `agora.ts`). So the
`catch` could never fire, the reconcile would read "no blocks" off an unreadable
`tasks.json`, and it would report **zero orphans**: silence in exactly the place
this milestone exists to remove.

It is the same "absent is not damaged" distinction the package builds into
`JsonStateStore` — not applied at the one seam that reads somebody else's store.
And the unit test passed the whole time, because the stub returned `null` and
**production never returns `null`**: a test asking a question production does not
ask ([[ask-the-question-where-production-asks-it]], the standing lesson).

The fix asks for the corruption by name, in `blockedTasksFrom` — extracted so it
is testable at all, since `index.ts` "holds no logic of its own". Six cases now
run it over a REAL Agora on a real disk, including a genuinely corrupt file, and
three mutations pin it — the first of which restores the original defective code
and is killed by three of those cases.

## Design decisions

**Assigned to `boot`, not a new `restart` subsystem.** A new row was written
first and reverted: `validateFloors` requires a floor for every subsystem on
every recorded platform, so the row could not land without a **linux** number
that cannot be measured on this machine. Inventing one would have been a figure
without its condition, which is the exact failure the floors file exists to
prevent. `boot` is also the honest home — its row measures how true "index.ts
holds no logic of its own" is, and moving logic out of `index.ts` into named,
tested modules is what M8.1 did with `shutdown.ts` and `ui-bridge.ts`.

**Floors deliberately not ratcheted.** `boot` now measures 20.75% lines against
a 17.03% floor because well-covered modules joined it. A raise needs three
corroborating runs of the same tree and is its own exercise.

## Owed, recorded not built

- **`--resume` / engine session recovery**, and the auto-respawn it unlocks.
  Until then a restored crew is `down` and the Architect rehires by reactivating.
- **An explicit Architect release for an orphan block** whose gate cannot be
  reconstructed. Orphans are impossible for gates opened after this package, so
  the remaining case is historical.
- **Capacity retry `attempts` resets across a restart** (see above); bounded and
  self-correcting.
- **Linux coverage floors** are unchanged and were not re-measured here.
- Reaping `~/.ephesus/engines/<engine>/<agent>/` stays with decommissioning.

## Related docs

- `docs/adr/ADR-0027-what-survives-a-restart.md` — **the normative record** for every decision here
- `docs/srs/SRS.md` — NFR-5 (amended by this package), NFR-9, NFR-13, §6 criterion 6
- `docs/sdd/SDD.md` §2, §4.8 (the record schemas), §7.9 (the boot replay), §10, §12
- `docs/TEST-STRATEGY.md` — S-BLACKOUT, amended to restart with the coordination state live
- `docs/adr/ADR-0012-mission-profiles.md` · `ADR-0011` (the breaker ladder)
- `docs/sdd/SDD.md` §4.1, §4.2, §4.3, §9
- `docs/implementations/2026-09-05-durable-breaker-stops.md` — the store precedent
- `docs/implementations/2026-09-03-m8-2-the-degradation-channel.md` — the channel every failure here reports through
