# ADR-0027 — What survives a restart, and what deliberately does not

**Status:** accepted · **Date:** 2026-09-05 · **Extends:** ADR-0012, ADR-0004 ·
**Depends on:** ADR-0011 (the rung-3 stop it draws its line against)

## Context

Through M8.7 the company's coordination state was in-memory maps with no boot
replay. A restart silently un-hired the company, and two consequences were worse
than "state is lost".

**A gate opened at 3am blocked its task forever.** The gate lived in a `Map`;
the BLOCK is durable. `tasks.json` carries `task.gates` and `refuseDone`
(SDD §4.2) will not let a task reach `done` while that array is non-empty. After
a restart the approvals queue was empty and the block was not, so the task could
never close and there was no way back but hand-editing the book of record.

**Nothing said the watch had stopped.** The Harbor stopped watching, every armed
trigger was gone, and profile autonomy stopped composing into gates
([ADR-0012](ADR-0012-mission-profiles.md)'s stated consequence, FR-11.1) — with
no degradation raised anywhere. The company looked healthy and was not, which is
this codebase's recurring defect in its most expensive form.

[NFR-5](../srs/SRS.md) already said "on restart, restore exactly". It named the
roster, the ledger and memory — all of which are committed files and did
restore. It did not name the coordination state, and the coordination state was
the half that did not.

The 2026-09-02 MVP register listed **five** things as lost. Investigating each
against the code found that **three of them were not lost at all**, and that
persisting two of those would have silently reversed decisions already recorded
in the tree. That finding shaped this record as much as the fix did.

## Decision

### 1. Three records, per subsystem, plus one replay module

The state that genuinely had no durable home gets one small app-local JSON file
each under the harness home (SDD §2), following the M8.6 breaker-stop precedent:
a `schemaVersion`, an atomic temp+rename write (invariant §3), validation on the
way in, and a damaged record that is never silently read as an absent one.

| File | Holds | Written on |
|---|---|---|
| `activations.json` | live mission instances | activate, deactivate, restore |
| `gates.json` | open gates **and** settled verdicts | open, settle, restore |
| `triggers.json` | trigger id → last-fired epoch ms | fire, disarm |

App-local, outside the Agora, for the same reason breaker stops are: this is
harness state, no agent reads it, and committing a gate-open record to git on
every gate would churn the book of record.

One module (`restore.ts`) owns what no individual store can: **the order they
come back in, and what happens when one cannot be read.** It never throws — boot
runs before the window exists, and a throw there is a dead app rather than a
degraded one (FR-5.4) — and every loss becomes a `restart/*` degradation naming
its consequence (invariant §7, M8.2).

### 2. The activation is restored; the crew is NOT respawned

A restored instance comes back with its crew **down**. Everything that does not
need a live process is restored: `planFor` answers again, so tool grants
([ADR-0026](ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md))
and composed autonomy work for a rehired agent; `watchedRepos` sees the
instance, so the Harbor resumes ingesting.

The agents themselves are not. Without engine session recovery a respawned agent
is amnesiac: it re-reads its mailbox and redoes in-flight work, which is exactly
the double-processing SRS §6 criterion 6 forbids. **The feature meant to prevent
loss would have introduced the fault it exists to prevent.**

Two behaviours follow, and both are load-bearing:

- **A restored instance arms no triggers.** A schedule trigger wakes
  `trigger.agentId`; arming one for an agent that does not exist is a wake into
  the void, once per interval, forever.
- **`activate` takes over a `down` instance** instead of refusing it as a
  duplicate (FR-9.4). Without this the restore would block the very
  reactivation that brings the crew back — replacing one stuck state with a
  worse one.

### 3. The plan is restored verbatim, never re-derived

`ActivationPlan` records what the Architect actually approved. Re-deriving it at
boot would let a bundle edited between activation and restart silently change
autonomy or grants. "Restore exactly" is a claim about the approved plan, not
about the current contents of `profiles/`.

### 4. A gate reconcile REPORTS; it never releases

The restored gates are compared against the durable blocks in `tasks.json`. A
block whose gate is in neither the open set nor the settled set is an **orphan**,
reported by task id. It is not cleared: auto-releasing a block whose gate cannot
be reconstructed would approve an action no human ever saw, and NFR-9 is
deny-by-default.

Settled verdicts are restored as well as open gates. `decide` answers "was
already approved" out of that set, which is what stops a repeated verdict being
processed twice; a restart that dropped it turned every answered gate back into
"no open gate" — a different answer to the same question.

### 5. Three things are deliberately NOT persisted

This is the half of the decision most likely to be re-opened by someone reading
the register, so the reasons are recorded here rather than left in the code.

- **Incident correlation.** `incidents.ts` holds its `raised` set in memory *by
  a recorded decision*: a restart SHOULD re-raise a still-failing incident,
  because nobody can be sure the earlier triage request survived in an inbox,
  and a duplicate incident is a cheap failure while a dropped one is the
  subsystem not working. Persisting it would reverse that decision silently.
- **Capacity parks.** They are derived, not held. `CapacityWatch` re-reads the
  tail of each transcript every tick and re-parks from the same refusal record —
  that is what its `handled` set exists to deduplicate — and it iterates *live*
  agents, of which a restart has none until the Architect rehires.
- **Breaker rungs 1–2.** A rung is computed from a process's own turn spans. A
  rehired agent is a **new process** that has not looped, has not errored and
  has no hop escalations, so restoring a rung onto it would assert a condition
  that is not true of it. Rung-3 **stops** are different in kind — a standing
  decision about an agent *identity*, not an observation about a process — which
  is exactly why [ADR-0011](ADR-0011-watch-breaker-budgets.md)'s stop was made
  durable at M8.6 and the ladder was not.

**The line this draws, and the one to apply to the next candidate:** persist a
*decision* about an identity; do not persist an *observation* about a process,
and do not persist state that a live subsystem re-derives from a durable source.

## Options considered

- **One `session.json` snapshot.** Buys a single atomic write, and therefore the
  guarantee that half a company can never be restored — genuinely the failure
  NFR-5 is about, and the strongest argument against the choice made here.
  Rejected on write coupling: it permanently ties fast-changing state (the
  trigger clock) to slow-changing state (activations), so every fired trigger
  rewrites the activation record, and one corrupt file costs everything at once.
  The consistency property is recovered instead by giving the *order* an owner
  (`restore.ts`) rather than giving the *bytes* one.
- **Rebuild from `log.jsonl`.** NFR-13 already claims every autonomous action is
  reconstructible from the log alone, so this would have proven the invariant
  rather than worked around it. Rejected for this milestone on three grounds:
  log rotation is M8.10 and unbuilt, with a synthetic overnight already at
  28.4 MB and 306 ms per parse on the main loop; some state is not in the log at
  all; and folding events forward must cope with a torn final write. It remains
  a good milestone on its own and is not foreclosed by this record.
- **Auto-respawn the restored crew.** The better demo, and what "restore
  exactly" reads like on first pass. Rejected until `--resume` exists, per
  Decision 2.
- **Persist all five register items.** Rejected per Decision 5: two would have
  reversed recorded decisions, and the third would have asserted a dead
  process's condition onto a new one.

## Consequences

- The harness home gains three files. Each is small, app-local, and absent on a
  first run — absence is an ordinary first run and says nothing, which is why it
  must never be confused with a damaged record.
- **`--resume` (engine session recovery) is now the load-bearing follow-on.**
  Until it lands, "restore exactly" is true of everything *except the agents
  themselves*, and the Architect rehires by reactivating. When it lands, this
  becomes auto-respawn without changing the restore.
- **An orphan block has no automatic remedy.** Orphans are impossible for gates
  opened after this record, so the remaining case is historical; an explicit
  Architect-only release is owed rather than built.
- **A capacity park's retry `attempts` rung resets across a restart**, so the
  first retry comes sooner than the ladder intended. Bounded and
  self-correcting: the next refusal re-parks one rung higher.
- `settled` verdicts are bounded at 1000, newest kept — gate ids are
  time-prefixed, so "newest" is a lexicographic sort. It is the only part of any
  record that would otherwise grow without limit, and an unbounded file is the
  M8.10 defect class arriving early.
- A subsystem that later needs restart durability has a mechanism to reuse
  (`JsonStateStore`) and a test to answer first: *is this held, or derived?*

## Prior art

`FileBreakerStopStore` (M8.6) is the precedent this generalises, and it is
deliberately **not** migrated onto `JsonStateStore`: its `load` throws by design,
because a breaker stop that cannot be read must block every start rather than
degrade. That is a safety contract the general class does not offer, and the
duplication is a decision rather than an oversight.

The boot replay itself follows M8.2's degradation replay, which established that
a restart may report a *carried* condition rather than pretending the morning is
healthy.
