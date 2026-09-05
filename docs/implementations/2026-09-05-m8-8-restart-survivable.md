# M8.8 — a restart is survivable

**Status: PLAN, under execution.** Written before any code, per
ENGINEERING-STANDARDS. Evidence sections are marked `PENDING` and are filled as
each part lands; nothing here is a claim until its section says so.

## Problem

The company's coordination state is one set of in-memory maps with no boot
replay, so a restart silently un-hires it. Verified at `2dfb0c6`:

| State | Holder | Durable today |
|---|---|---|
| Activations | `ProfileActivations.live` | no |
| Open + settled gates | `GateManager.open` / `.settled` | no — but the block id is in `tasks.json` |
| Trigger last-fired | `Scheduler.triggers[].lastFiredMs` | no |
| Incident correlation | `IncidentEndpoint.raised` / `.awaiting` | no |
| Capacity parks | `CapacityWatch.parks` | no |
| Breaker rungs 1–2 | `Breaker.agents` | no |
| Breaker rung-3 stops | `~/.ephesus/breaker-stops.json` | **yes** (M8.6) |
| Roster and agent status | `registry.json` | **yes** |

The register recorded "breaker rungs" as lost wholesale. That is half right and
the correction matters: rung-3 **stops** already survive through
`FileBreakerStopStore`, and this package must not re-solve them. It is the
rung 1–2 ladder position that evaporates.

Two consequences are worse than "state is lost".

**A gate opened at 3am blocks its task forever.** The gate is in memory; the
BLOCK is durable — `tasks.json` carries `task.gates`, and `src/shared/tasks.ts`
refuses `done` while that array is non-empty. After a restart the queue is empty
and the block is not, so the task can never close and there is no way back but
hand-editing the book of record.

**Nothing says the watch stopped.** The Harbor stops watching, every armed
trigger is gone, and profile autonomy stops composing into gates — with no
degradation raised anywhere. The company looks healthy and is not, which is the
recurring defect of this codebase (a check that cannot fail) in its most
expensive form.

M8.7 raised the stakes: a restart must now also answer for engine config
directories, tool grants, and `planFor` for replayed agents.

## Architect decisions taken for this package (2026-09-05)

Both were put with their alternatives and their costs before any code:

1. **Per-subsystem stores plus one replay module** — not a single `session.json`
   snapshot, and not a rebuild from `log.jsonl`. Recorded in *Design decisions*.
2. **Restore the activation; do NOT auto-respawn the crew.** `--resume` is a
   follow-on and is stated as owed below, not quietly skipped.

## Implementation approach

### Five stores, one shape

Each store follows `FileBreakerStopStore` exactly — the M8.6 precedent — so
there is no new pattern to learn: a zod schema with `schemaVersion`, an atomic
`writeFileAtomic` (temp + rename, invariant), `ENOENT` means empty, and a
malformed record is never silently treated as absence.

| File under `~/.ephesus/` | Holds | Written on |
|---|---|---|
| `activations.json` | live `ProfileInstance[]` | activate, deactivate |
| `gates.json` | open gates and settled verdicts | open, settle |
| `triggers.json` | trigger id → `lastFiredMs` | fire |
| `parks.json` | capacity parks | park, resume, clear |
| `incidents.json` | raised ids and awaiting correlation | raise, settle |

App-local, outside the Agora, for the same reason breaker stops are: this is
harness state, no agent reads it, and committing a gate-open record to git on
every gate would churn the book of record.

None of these is a hot path. The scheduler writes on **fire**, not on tick, so
the per-file layout costs no more renames than the state actually changes.

### One replay module owns the order

New `src/main/restore.ts`. It never throws, returns a report of what was
restored and what was not, and the caller reports every failure through the
M8.2 degradation channel. The order is load-bearing:

1. **Triggers first.** `Scheduler.register` preserves an existing entry's
   `lastFiredMs` (`scheduler.ts:77`), so seeding last-fired *before* activations
   re-arm is what stops a restored trigger from firing immediately.
2. **Activations.** Re-registers each instance into `live`, which re-arms its
   triggers against the seeded clock and rebinds Harbor watching.
3. **Gates**, then reconciled against `tasks.json` (below).
4. **Parks**, then **incidents.**

### What M8.7 needs, and what it does not

- **Engine config directories need no persistence.** `engineConfigDir(root,
  engineId, agentId)` is pure, so boot recomputes the identical path. That is
  precisely why M8.7 collapsed it to one function, and this package must not add
  a second source of truth for it.
- **Tool grants ride the restored plan.** `toolsFor` reads `planFor(agentId)`,
  and `planFor` walks `this.live` — so putting the instance back in `live` makes
  grants and autonomy answer for replayed agents with no further wiring. A test
  must pin that, because it is the kind of thing that is true by accident.

### Gate reconciliation against `tasks.json`

Restoring `gates.json` is not enough; the durable half must agree with it. For
every task carrying `task.gates`:

- an id in neither the restored open set nor the settled set is an **orphan
  block** — the exact defect above. Reported by task id and gate id.
- a restored open gate whose task no longer lists it is **stale** — dropped and
  reported.

Orphans become impossible for gates opened after this package lands, so the
remedy here is disclosure, not an automatic release: auto-clearing a block whose
gate cannot be reconstructed would be a deny-by-default hole (NFR-9). An
explicit Architect-only release action is recorded as owed.

### Restoring exactly, without pretending a bundle never changed

`ActivationPlan` is plain data and carries `profileVersion`, so the recorded plan
is restored **verbatim** — that is what NFR-5's "restore exactly" means, and
re-deriving would let a bundle edited between activation and restart silently
change autonomy or grants.

Drift is then disclosed rather than acted on: the recorded `profileVersion` is
compared against the bundle's current version on disk — a string compare, no git,
no async — and a difference is reported as "the bundle changed since activation;
reactivate to pick it up". Re-deriving the plan at boot would need a git call per
activation and would fail offline, for an answer the Architect has not asked for.

### Failure modes, per store

Following the breaker-stops rule (*missing on first use means empty; malformed,
unsupported or unreadable is latched and reported, never treated as absence*),
with the consequence spelled out per store because they differ:

| Store malformed | Behaviour | Risk disclosed |
|---|---|---|
| `gates.json` | no block is cleared; refuse to settle until repaired | safety-critical: we no longer know what is held, and deny-by-default says assume it is |
| `activations.json` | nothing restored; company returns un-hired and says so | the watch is off until reactivated |
| `triggers.json` | last-fired not seeded | a trigger may fire earlier than due — duplicated work |
| `parks.json` | parks not restored | a parked agent returns unparked and may re-hit the limit; self-correcting |
| `incidents.json` | correlation not restored | an incident may be raised twice |

## Design decisions

**Per-subsystem files over one `session.json`.** A single snapshot buys one
atomic write and therefore the guarantee that half a company can never be
restored — genuinely the failure NFR-5 is about. It was rejected on write
coupling: it permanently ties fast-changing state (parks, last-fired) to
slow-changing state (activations), so every park rewrites the activation record,
and one corrupt file costs everything at once. Per-subsystem files match the six
durable files the tree already has, and the consistency property is recovered by
giving the *order* an owner (`restore.ts`) rather than giving the *bytes* one.

**Not a rebuild from `log.jsonl`.** NFR-13 claims every autonomous action is
reconstructible from the log alone, so this would prove the invariant rather
than work around it — the strongest argument for it, and the reason it is
recorded here rather than dismissed. Rejected for M8.8 on three grounds: log
rotation is M8.10 and unbuilt, with a synthetic overnight already at 28.4 MB and
306 ms per parse on the main loop; some state is not in the log at all
(capacity's `handled`, the `activating` set); and folding events forward must
cope with a torn final write. It is a milestone, not a mechanism to smuggle into
this one.

**Restore without respawn.** Acceptance criterion 6 (SRS §6) requires that on
restart "no message is double-processed". Without `--resume` a respawned agent
is amnesiac: it re-reads its mailbox and redoes in-flight work, so auto-respawn
would introduce the exact fault the package exists to prevent. The floor shows
the crew down with the reason and offers a rehire. When `--resume` lands, this
becomes auto-respawn without changing the restore.

## Verification

`PENDING` — filled as each part lands. The bar for this package:

- **S-BLACKOUT must restart with an agent, a gate, an activation and an armed
  trigger LIVE.** Today it restarts with none of them (`liveAgents: () => []`, a
  fresh `GateManager` over `denyAllPolicy`), which is why this whole class was
  invisible to a green suite. Changing that fixture is the package's central
  test, not a supporting one.
- A restored activation answers `toolsFor` and `autonomyFor` for its agents —
  the M8.7 seam, asked where production asks it.
- A task blocked by a gate id present in no store is reported by task id.
- Each store's malformed case asserts the *behaviour* in the table above, not
  merely that a parse threw.
- Mutation pass over every new guard, each mutation killed by a named test and
  reverted.

## Owed, recorded not built

- **`--resume` / session-id recovery**, and the auto-respawn it unlocks.
- **An explicit Architect release for an orphan block** whose gate cannot be
  reconstructed.
- **Breaker rung 1–2 ladder position** is restored as data; whether a restored
  rung should decay with wall-clock time across a long downtime is a policy
  question this package does not answer.
- **Reaping `~/.ephesus/engines/<engine>/<agent>/`** stays with decommissioning
  (carried from M8.7).

## Related docs

- `docs/srs/SRS.md` — NFR-5, NFR-9, NFR-13, §6 criterion 6 (the blackout test)
- `docs/adr/ADR-0012-mission-profiles.md` — profiles as declarative bundles
- `docs/sdd/SDD.md` §4.1 (roster), §4.3 (log kinds), §9 (gates)
- `docs/implementations/2026-09-05-durable-breaker-stops.md` — the store precedent
- `docs/implementations/2026-09-03-m8-2-the-degradation-channel.md` — the channel every failure here reports through
