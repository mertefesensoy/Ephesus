# The outbound draft survives the restart that restores its gate

**Date:** 2026-09-06
**Found by:** the M8.8 coverage audit, working toward a releasable MVP
**Requirement:** SRS NFR-5 (amended) · FR-9.3 · ADR-0030 (new), extending ADR-0027
**Branch:** `fix/mail-lost-when-a-woken-agent-dies`

---

## 1. Problem / Motivation

M8.8 made the company's coordination state survive a restart. The audit asked
the obvious follow-up — *is it actually total?* — and applied ADR-0027's own
test to every remaining in-memory map in `src/main/`:

> persist a decision about an identity; do not persist an observation about a
> process, and do not persist state a live subsystem re-derives from a durable
> source.

Exactly one map fails it: `FrontOffice.held`, which maps `gateId → FiledDraft`.

`gates.json` restores an `outbound` gate. The draft that gate holds was never
written anywhere. So after a restart:

1. The outbound gate is back in the approvals queue — M8.8 working correctly.
2. Its packaging renders normally, because the words were baked into the gate's
   prose at `submit` time. Nothing on screen looks wrong.
3. The Architect approves it. `onVerdict` finds no draft and returns `false`.
4. [index.ts](../../src/main/index.ts) did `void frontOffice?.onVerdict(...)` —
   **the `false` reached nobody.**

The gate settled as approved, `log.jsonl` recorded a verdict, and the comment
never left the machine.

Proved by execution before any fix was written: one office posts the comment; a
second office over the same (nonexistent) record posts nothing and reports
nothing.

**M8.8 did not cause this, but it made it reachable.** Before the restore the
approvals queue came back empty, so the gate could not be approved at all and
the failure had nowhere to happen. And it lands on the single path where the
company speaks in public under the Architect's name — the act FR-9.3 exists to
gate.

## 2. What changed

| File | Change |
|---|---|
| `src/shared/outbound.ts` | `DRAFTS_REL`, `filedDraftSchema` (with the `awaiting` field and its refine), `DRAFT_RECORD_TRIM`, `draftsRecordSchema`, `EMPTY_DRAFTS` |
| `src/main/frontoffice.ts` | `persist?` option, private `persist()`/`record()`, public `restore()`; `awaiting` on `FiledDraft`; the verdict now rewrites the filed row |
| `src/main/restore.ts` | `drafts` store, `restoreDrafts`/`gatesHoldingADraft` targets, the draftless-gate reconcile, two new counts |
| `src/main/index.ts` | Builds the fourth store, wires `persist`, adds the replay targets, and **reports** the refused verdict instead of discarding it |
| `docs/adr/ADR-0030-…md` | **New**, normative |
| `docs/srs/SRS.md` | NFR-5 amended |
| `test/main/frontoffice.test.ts` | The record, the restart, the trim, the impossible pair |
| `test/scenarios/s-blackout.test.ts` | A **real** `FrontOffice` in the scenario's lifetime, plus the two cases below |
| `test/main/restore.test.ts` | Rig extended for the fourth store |

## 3. Implementation approach

### 3.1 A fourth record, following ADR-0027 exactly

Its own `JsonStateStore`, schema beside the types it validates, written through
`writeRestartRecord` so a failed write is a reported degradation and never
unwinds the thing it was recording. The per-subsystem shape ADR-0027 argued for
is what let this be an addition rather than a redesign.

`persist()` is **private** and called after every mutation of `filed` or `held`,
never from the callers of those mutations — the same discipline the other three
records use, and precisely the discipline whose absence caused this bug.

### 3.2 `awaiting`, because `gateId` cannot answer two questions

A decided draft keeps its gate id as history. A restore that re-held every draft
carrying one would put comments the Architect already answered back into
`pending()` — which is what the standup reads. So the row records whether it is
still waiting, set false when the verdict lands.

The schema states how the two fields relate rather than leaving the impossible
pair representable:

```ts
.refine((filed) => !(filed.awaiting && filed.gateId === null),
        'a draft cannot await a gate it never got')
```

`JsonStateStore.save` validates before writing, so this refuses the write rather
than the next boot. (This was written *because* of a surviving mutant — §5.2.)

### 3.3 The trim never sheds a draft that can still be approved

`DRAFT_RECORD_TRIM` bounds the record oldest-first, because each row carries a
body of up to 20,000 characters and unbounded growth is the M8.10 defect class
arriving early. The trim skips any draft still waiting at a gate, whatever its
age. Shedding reviewed history is housekeeping; shedding a draft the Architect
can still answer is the defect this record exists to close.

An ordering bug was fixed alongside it: `persist()` ran *before* `held.set(...)`,
so the trim consulted a `held` that did not yet contain the draft just filed.

### 3.4 Two guarantees, at both ends

**At boot**, `restoreCompany` reconciles restored gates against restored drafts
and raises `restart/draftless-gate:<id>` for any open `outbound` gate holding
none. It does not settle it — the same rule ADR-0027 §4 applies to an orphan
block: auto-denying drops the agent's work on the harness's authority, and
auto-approving publishes a comment nobody can read (NFR-9).

**At the verdict**, `index.ts` reports the same cause when `onVerdict` answers
`false`. An approval the harness cannot honour is now a visible condition rather
than a comment that quietly never went out (invariant §7).

## 4. Design decisions

Recorded in full in [ADR-0030](../adr/ADR-0030-the-outbound-draft-survives-with-its-gate.md).
The two rejected options worth repeating here:

- **Rebuild the draft from the gate.** The words *are* on the gate — as rendered
  prose from four prompt templates. Recovering `repo`/`target`/`ref`/`body` means
  parsing back out of text the harness wrote. Publishing under the company's name
  from a paraphrase of a paraphrase is not a recovery path.
- **Put the structured draft on the gate record.** One file instead of two, and
  the gate is already durable. Rejected because it puts a subsystem's payload
  inside another subsystem's record; every future gate kind with state would want
  the same, and `gates.json` becomes the `session.json` ADR-0027 rejected.

## 5. Verification

### 5.1 Gates

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
```

205 files, **3935 passing**, 8 skipped. Invariants ok, reachability 175/183.
Coverage floors ok — `boot` and `harbor` now measure *above* their floors.

The two scenario cases are the load-bearing ones, and they run against a real
`FrontOffice` wired to the real `GateManager` over a real temp home across two
lifetimes:

- *an outbound gate open at the blackout can still be POSTED after the restart*
- *a gate whose draft did NOT come back is reported, not silently approved*

### 5.2 Mutation — 11/11 killed, and one survivor changed the design

The first pass was 8/9. The survivor was **"a verdict does not update the
record"**, and reading it rather than patching the test found a second, deeper
defect: `restore()` re-held every draft with a non-null `gateId`, so a decided
draft came back as pending regardless of whether `persist()` ran. That is what
produced `awaiting` (§3.2).

The second pass was 10/11. That survivor — *"a hold with no gate still claims to
be awaiting one"* — was **equivalent**: with `gateId === null` nothing ever reads
`awaiting`, because both `held.set` and `restore` are already guarded on the gate
id. Two fields that cannot disagree, so the relationship went into the schema
where a bad pair is refused at the boundary, and the mutant became killable.

## 6. What the audit checked and did NOT find

Recorded so the same ground is not re-walked:

- **Every gate-keyed in-memory payload.** `FrontOffice.held` is the only one
  outside `GateManager` itself, so this closes the class rather than one case.
- **ADR-0027's three deliberate omissions still hold** in today's code: the
  incident `raised` set is a recorded decision; capacity parks are re-derived
  each tick from the transcript tail and iterate live agents, of which a restart
  has none; breaker rungs 1–2 are process observations, and rung-3 stops have
  been durable since M8.6.
- **`hermes.paused`** is driven only by the capacity watch, so losing it at a
  restart is correct, not a gap.
- **Save failures are reported and cleared** (`writeRestartRecord`), not
  swallowed. The `restart` degradation source is in the closed list, so the
  `as DegradationCause` cast in the replay is honest.
- **A doc-precision point, not a defect.** ADR-0027 says "`--resume` is now the
  load-bearing follow-on. Until it lands…". `--resume` *has* landed for respawn
  within one app lifetime; what has not is **persisting session ids**
  (`LiveAgent.sessionIds` and `CostLedger.liveSession` are both memory), so it
  still cannot serve a restart. The ADR's conclusion holds; a future reader could
  mistake the follow-on for done.

## 7. Related docs

- [ADR-0030](../adr/ADR-0030-the-outbound-draft-survives-with-its-gate.md) — the decision
- [ADR-0027](../adr/ADR-0027-what-survives-a-restart.md) — the rule this applies
- `docs/srs/SRS.md` — NFR-5 (amended), FR-9.3
- `docs/implementations/2026-09-05-m8-8-restart-survivable.md` — the package audited
