# M8.6 — crew isolation and survival

## Problem / motivation

Three items from the 2026-09-02 MVP register, landing together because they are
one loop: what an agent is allowed to touch, what stops it, and what brings it
back. Separating them creates the leak the other fixes.

### B10 — every hire ran in the Architect's own checkout

`AgentManager` has supported worktree isolation since M4 (UC-01 alternate 2a,
FR-1.5). Nothing ever asked for it. The profile spawn path built its
`SpawnRequest` in `activationPlan` with `cwd: target.path` and no `worktree`
field at all, and neither shipped bundle had anywhere to declare one. So
activating `skeleton-crew` on a repository hired four agents that ran git
operations and file edits **concurrently in the Architect's working copy** —
the one item in the register that can destroy uncommitted work.

The second half was worse than the gap. When isolation *was* requested and could
not be provided, `isolate()` logged the failure and let the spawn continue:

> A worktree that cannot be made is reported and the spawn continues where it
> was going to — visible, and never a reason not to hire.
>
> — `agents.ts`, before this change

That reasoning is inverted. The fallback **is** the harm: an agent that asked to
be kept out of somebody's working copy and was silently put into it is exactly
the outcome isolation exists to prevent, and it is the silent degradation
BUILD-PROMPT §3 forbids — the Architect learns of it from a log line, after the
writes.

### B11 — the breaker erased the stop it had just performed

`index.ts` called `breaker.forget(agentId)` on **every** exit, including the exit
rung 3 had just caused. Measured over one 24.9M-token day: **21 climbs to rung 1
and exactly one completed rung-3 stop.** An exhausted budget stopped the agent,
the stop erased the record of itself, the agent came back at rung 0, and the same
runaway climbed the ladder again.

Keeping the rung alone would have fixed nothing, and this is the part worth
recording: spans are session state and go with the process, so the next sweep
sees nothing firing and `nextRung(3, false)` returns 0 in a single step. The
thing that has to survive an exit is the **decision**, not the counter.

### B12 — nothing brought a crew agent back

FR-5.4's backoff ladder was written for Artemis and lived inside `artemis.ts`.
The book of record for that same day holds **46 `respawn-scheduled` rows, every
one of them the orchestrator**, while three crew agents logged terminal exits
four, five and five times and were never brought back by anything.

`AgentManager.offerRespawn` had been computing a `RespawnOffer` on every exit
since M3 — resumable, memory sections, returned tasks — and putting it on the
card. `grep -rn respawnOffer src/renderer src/preload` returned **nothing**. SDD
§10's "respawn offer on the agent card" had never been rendered, and there was no
IPC to accept one.

## What changed

| File | What |
|---|---|
| `src/shared/isolation.ts` | **New.** The pure isolation composition: modes, ranks, the built-in default, the Architect's activation choice, and a `because` sentence for every outcome |
| `src/shared/respawn.ts` | **New.** The ladder's arithmetic (`nextLadderStep`, `ladderRecovered`, `exhaustedReason`), `RespawnPolicy`/`DEFAULT_RESPAWN` moved out of `artemis.ts`, the new `CREW_RESPAWN`, and the `ExitPolicy` a hire declares |
| `src/main/respawn.ts` | **New.** `RespawnLadder` (one agent's attempts, backoff, stability, capacity hold, standing-decision veto), `CrewSurvival` (one ladder per declared hire), `respawnBlockReason` and `createCrewSurvival` |
| `src/main/artemis.ts` | Rewired onto the shared ladder; keeps the orchestrator's own policy (clear the roster seat, report the degradation, the respawn-notice flag) and its historic log-event names. Gains `respawnBlocked` |
| `src/main/agents.ts` | `isolate()` returns a refusal reason instead of falling back; `spawn` refuses and releases the id; `respawn` refuses rather than landing in the checkout; the new `respawnBlocked` guard; the offer carries `blockedBecause` |
| `src/main/watch/breaker.ts` | The `BreakerStop` register: recorded at rung 3 before the stop is performed, `forgetSession` vs `forgetAgent`, `stopOf`/`stopped`/`clearStop` |
| `src/main/profiles.ts` | Passes the activation's isolation choice through; new `onHired`/`onReleased` seams, ordered so neither races a kill |
| `src/shared/profile-activation.ts` | Composes isolation per hire, derives `spawn.worktree` from it in one expression, carries `onExit` |
| `src/shared/org.ts`, `src/shared/profile.ts` | `isolation` and `onExit` on the hire template and the profile document — additive, optional, no `schemaVersion` bump |
| `src/shared/agents.ts` | `RespawnOffer.blockedBecause` |
| `src/shared/log.ts`, `src/shared/degradation.ts` | The `respawn` log kind and its row renderer; the `respawn` degradation source |
| `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts` | `agents.respawn(id)` end to end |
| `src/renderer/src/AgentDock.tsx` | `respawnNote` and the exported presentational `DockCards`: the offer's first appearance in the UI |
| `src/renderer/src/ProfilesPanel.tsx` | Two new disclosure sections — *It would work in* and *When one of them dies* |
| `src/main/index.ts` | Wiring only: the guard on three paths collapsed onto one shared sentence, `CrewSurvival` built through its factory, `crew.stop()` before the unwind |
| `profiles/*/profile.json` | Both bundles declare `isolation` and `onExit`, with a version bump each |
| `scripts/coverage-floors.json` | The three new modules assigned to subsystems; the map is total by design |

## Implementation approach

### Isolation composes, in the shape autonomy already uses

The Architect chose a three-layer composition mirroring `composeAutonomyTable`,
so nobody has to learn a second mental model for "what did the bundle ask for,
what did I say, and what will actually happen":

```
hire template  →  profile document  →  built-in default
                                    ↓
                    the Architect's activation choice
                                    ↓
                    clamp: can this target hold a worktree?
                                    ↓
                                effective
```

Three decisions inside that are load-bearing:

- **The built-in default is `worktree`.** A bundle that declares nothing gets
  isolation, not the Architect's checkout — because "declares nothing" describes
  both shipped bundles for their entire production life. A bare `agents.spawn`
  (UC-01, where the human typed the directory and confirmed one agent) keeps the
  schema's optional-false default; there is no surprise to protect against when
  a person named the directory.
- **The clamp is last, and it can only loosen.** An `app` target is a directory,
  not a repository; composing to `worktree` there would produce a spawn `git`
  must reject. It is said in words instead.
- **Whether the worktree can actually be made is NOT pre-checked.** The create is
  the truth. A screen that says "ok" and a `git worktree add` that then fails are
  two code paths that can disagree, which is the M8.5 lesson; the refusal below
  carries git's own account instead.

`PlannedHire.spawn.worktree` is derived from `PlannedHire.isolation.effective` in
one expression, and a test asserts that equality for every planned hire under
every choice. The screen reads `isolation.because`; the harness reads the flag;
both come from one object.

### The refusal (Architect decision, 2026-09-04)

`isolate()` now returns `string | null` — the reason, or nothing. `spawn` throws
naming the hire and git's reason, and **releases the claimed agent id first**, so
the Architect can fix the repository and activate again without a phantom agent
holding the name. `respawn` does the same and leaves the card `exited`: a respawn
that cannot restore the isolation the agent had is not a respawn into the
Architect's checkout, it is a respawn that did not happen. Profile activation is
already all-or-nothing, so one refused hire refuses the instance.

### The stop is a decision about the agent, not about the process

`Breaker` keeps a `BreakerStop` per agent, **recorded before the stop is
performed** — the process is about to exit, `onChange` will call
`forgetSession`, and a record written after that race would be a record nobody
can see. One verb became two:

- `forgetSession` — what an exit calls. Drops spans and rung; keeps the stop.
- `forgetAgent` — decommissioning. Drops everything.
- `clearStop` — the Architect's, and it also returns the agent to rung 0, since a
  lifted stop that left it at rung 3 would not be lifted.

The record is serializable and single-owner on purpose: M8.8 has to make it
survive a restart, and a shape that already round-trips through JSON is the
difference between wiring a file up and redesigning the register.

### One ladder, three callers, one refusal sentence

`RespawnLadder` is Artemis's ladder extracted, not a second one. Artemis's own
653-line suite was the regression net for the extraction and passed unchanged at
every step. What stayed in `artemis.ts` is orchestrator *policy* — clearing the
roster seat, reporting the degradation, the respawn-notice flag — and the
historic log-event names, which are load-bearing: they are what the book of
record holds for every past run.

`CrewSurvival` holds one ladder per hire that declared `onExit: "respawn"`, and
nothing at all for the others. The rung-3 stop is asked through `blocked`, **once
before scheduling and again after the wait** — a two-minute backoff is long
enough for the breaker to stop the agent in the meantime.

`respawnBlockReason` is one function because there are three callers: the crew's
ladder, Artemis's ladder, and `AgentManager.respawn`, which is the path a human
accepting an offer goes through. Three copies would eventually be three different
sentences.

### The orchestrator is not exempt

Wiring `respawnBlocked` for Artemis was not in the package as written; it came out
of the coverage pass, which surfaced a `respawn-blocked` log branch that could
never fire. If the breaker stops her at rung 3 and her ladder immediately undoes
it, rung 3 is a pause rather than a rung — B11's cycle with a laurel wreath.
FR-14.5 already treats a rung-3 stop on her work as consequential enough to
revert the company's mode.

### Boot stayed out of it

The first draft put the `CrewSurvival` construction — the log mapping, the
degradation causes, the "still down" reading — inline in `index.ts`, and the
coverage gate failed `boot` on the dilution alone. That is the correct signal, so
the fix was M8.1's own precedent rather than a lowered floor: the decisions moved
into `createCrewSurvival` in `respawn.ts`, where tests reach them, and `index.ts`
kept only the wiring. `boot` returned above its floor without the floor moving.

## Mathematical / statistical details

The ladder is two pure functions over a policy `(backoffMs[], stabilityMs)`.

**`nextLadderStep(attempts, policy)`** — with `attempts` the number already
spent, the step is `backoffMs[attempts]` when that index exists (reported as
attempt `attempts + 1`), and `exhausted` otherwise. Total for every
`attempts ≥ 0`; the ladder length is `backoffMs.length`, so ending is structural
rather than a counter someone remembered to check.

**`ladderRecovered(upForMs, policy)`** — `upForMs ≥ stabilityMs`. Separate from
the step function because recovery is a claim about the past and the ladder is a
decision about the future; conflating them is how a crash loop resets its own
counter (a process that starts and dies immediately would reset on every start).

The two shipped policies:

| | `backoffMs` | `stabilityMs` | rungs |
|---|---|---|---|
| `DEFAULT_RESPAWN` (orchestrator) | 1s, 2s, 5s, 15s, 30s | 60s | 5 |
| `CREW_RESPAWN` | 5s, 30s, 120s | 300s | 3 |

The crew's is shorter and slower deliberately. A company with no orchestrator
cannot route anything, so Artemis is worth five quick attempts. One crew agent
down is a degraded company rather than a stopped one, and the likeliest cause of
a crew agent dying five times in ninety seconds is a broken brief or a missing
binary — neither of which a sixth attempt fixes, and both of which spend the
Architect's tokens on the way.

**Isolation** is an ordering, not arithmetic: `rank(target) = 0 < rank(worktree) = 1`,
used only to describe an outcome as a tightening or a relaxation. It never picks a
winner — the Architect's explicit choice wins in both directions, which is the
point of asking.

## Design decisions

| Decision | Alternatives rejected |
|---|---|
| Three-layer isolation with a per-activation override | **Hire template only** — simplest, but changing it for one run means editing a versioned bundle, and there is no disclosure of an override because there are no overrides. **Implied by capability** — makes the capability list a security boundary it was never designed to be, so a new capability string silently changes isolation. **A harness-wide switch** — cannot express "the improver is isolated, the read-only docs agent is not", which FR-9.5 requires |
| Refuse a spawn that cannot be isolated | **Keep the fallback, louder** — the disclosure arrives after the risk was taken; overnight, that means the morning. **Fall back read-only** — not enforceable: the harness cannot stop a CLI writing files, only decline to grant it, so it would be an assertion the code cannot keep |
| A rung-3 stop is sticky | **Just stop calling `forget`** — insufficient and misleading: spans go with the process, so `nextRung(3, false)` returns 0 on the next sweep and the change would look right while doing nothing. **Persist to disk now** — M8.8's scope; the shape here leaves that door open |
| Offer *and* a declared auto policy | **Offer only** — exactly SDD §10, but a crash at 03:00 means a dead crew until morning, which is the thing this milestone is named after. **Automatic for all crew** — no way to say "this one should not come back", and a broken brief becomes a crash loop spending budget on the ladder; the bundle stops being where you read what may happen |
| Default `onExit` is `offer` | `respawn` as the default would change documented behaviour for every bundle silently. The two shipped bundles opt in explicitly, and took a version bump for it |
| `respawn` as its own log kind | Folding it into `spawn` or `orchestrator` would make "did the company survive the night" unanswerable from the log — the exact query that established B12 ("46 rows, all Artemis, zero crew") |
| Extract Artemis's ladder rather than write a second | A second copy would duplicate the parts that are actually hard — the pending-promise handoff, the hold, the stability reset. Artemis's existing suite is the regression net, and it passed unchanged |

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs
```

**Suite:** 3,650 passed / 8 skipped across 191 files under coverage.
**Invariants:** reachability 166/174 src modules reached, 8 unreachable by
recorded decision, 6 type-only.
**Coverage floors:** ok on win32, 17 subsystems, 23 untested modules all
recorded — **no floor lowered by hand**; `artemis` and `engines` rose.

New and extended suites: `test/shared/isolation.test.ts` (16),
`test/shared/respawn.test.ts` (9), `test/main/respawn.test.ts` (39),
plus additions to `agent-worktree` (real git, real child processes),
`breaker`, `agents`, `artemis`, `profile-activation`, `skeleton-crew`,
`agent-dock` and `profiles-panel`.

The two owed by PROGRESS that are asserted against the filesystem rather than a
flag: *concurrent hires never touch the target checkout* spawns two isolated
agents simultaneously against a real repository and asserts
`git status --porcelain` is empty and no `.fake-engine` directory appeared;
*a breaker-caused exit KEEPS its rung* drives a real agent to rung 3 and calls
the exact method `onChange` calls.

### Refutation pass — 28 mutations, 28 killed

Per the standing rule that a new gate is refuted before it closes, 28 mutations
were planted against the rules this package introduces, each run against the
suites that claim to catch it, each reverted.

**Two survived the first pass, and both were real:**

1. **`respawn-ignores-the-stop`** — deleting the guard inside
   `AgentManager.respawn` killed nothing. Both ladders ask `blocked` before
   scheduling, so the guard that covers the path with *no* ladder — the
   Architect pressing "bring it back" — had no test. That is the path SDD §10
   specifies and the one this package built the IPC for.
2. **`offer-hides-the-block`** — hard-coding `blockedBecause: null` killed
   nothing. The dock tests built the offer by hand; nothing asserted that
   `AgentManager` fills it from the predicate.

Both are the same shape as the recurring defect of this repository: a rule
enforced only where something else already enforces it is a check that cannot
fail. Four tests in `test/main/agents.test.ts` close them, and the second pass
killed 28/28.

### Not verified here

The demo half. This package is verified by execution against real git
repositories and real child processes, but no profile has been activated on a
real target repository in the shipped app under these rules — that remains M7's
open exit criterion, which M8 does not close.

## Related docs

- `docs/PROGRESS.md` — M8.6 package entry and evidence
- `docs/sdd/SDD.md` §1.1 (`respawn.ts`), §3 (who asks for `worktree: true`),
  §4.3 (the `respawn` kind), §9 (the sticky stop), §10 (three amended rows)
- `docs/srs/SRS.md` FR-1.5, FR-5.4, FR-9.5, UC-01 alternate 2a
- `docs/adr/ADR-0004` (single committer), `ADR-0011` (the ladder),
  `ADR-0012` (declarative bundles)
- `docs/DECISIONS-LOG.md` — the four Architect decisions of 2026-09-04
