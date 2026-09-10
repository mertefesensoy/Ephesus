# The first ingest must not replay history as news

**Date:** 2026-09-10 · **Milestone:** M8c.2 · **Branch:**
`fix/m8c-2-cold-start` from `origin/main` `c60cb81`

---

## 1. Problem / motivation

Finding 5 of [the M8 exit run](../demo/m8-onehour-aftershock.md).

Activation completed at 09:06:36. By ~09:08 — **before the runner had broken
anything** — the Harbor's first ingest had pulled ten CI runs and the crew had
raised **eight incidents**:

| seq | conclusion | run created |
|---|---|---|
| 60 | success | 2026-08-24T03:45:38Z |
| 61 | success | 2026-08-24T03:25:55Z |
| 62–69 | **failure** ×8 | 2026-08-23T23:50 → 2026-08-24T03:05 |

Every one of those failures was **sixteen days old and already fixed**, and the
decisive detail is that the proof was *in the same payload*: seq 60 and 61 are
the two newest runs on that branch and both are `success`. The ingest had, in
one batch, both the failures and the evidence they had been superseded, and
raised eight incidents anyway.

Repeat ingests correctly did **not** re-raise — dedupe works. Only the cold
start is wrong.

**Why it matters beyond noise.** SRS §6.1 asks whether *"the crew has detected
the failure"*. A backlog replay is not detection; it is a cold start mistaking
history for news. It also contaminated the run's own measurement — the real
incident had to be picked out from eight pre-existing ones and the crew was
already saturated when it arrived — and it compounded with Finding 3 into
**40,453,419 tokens ($11.22)** on work finished on 2026-08-24, with no reachable
ceiling to stop it.

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/harbor.ts` | `branchOf` — the head branch, named for the consumer — and `ciRunStillStands`, the pure rule. |
| `src/main/incidents.ts` | `IncidentBinding.watchingSince`; the rule applied in `raise`, after the dedupe; the `incident-superseded` row. |
| `src/main/index.ts` | Supplies `watchingSince` from the instance's own `activatedAt`. |
| `src/shared/incident-view.ts` | Says in a comment why the board needs no case for the new event — and why the explicit `continue` that was written here was removed. |
| `test/main/incidents.test.ts` | Nine cases, built on the 2026-09-09 batch itself. |
| `test/shared/incident-view.test.ts` | Two pinning that a correct non-raise puts nothing on the board. |

---

## 3. Implementation approach

**The rule, in one sentence:** a run from *before* this instance started watching
raises only if it is still the newest run on its branch; a run from *after* the
activation raises on its own merits.

| Situation | Before | Now |
|---|---|---|
| eight stale failures, two newer greens (the 2026-09-09 batch) | 8 incidents | **0** |
| a repository red *right now*, three failures deep | 3 | **1** — the newest, which still stands |
| two branches red | one per run | **one per branch** |
| a failure after the activation, with a later green | 1 | **1** — it happened on our watch |
| a run `gh` returned with no `headBranch` | raised | **raised** — no branch, no suppression |
| a binding with no `watchingSince` | raised | **raised** — additive, so nothing changes for a caller that has not been told |

**"Overtaken" is any later run, not only a later success**, and that is the
choice worth arguing. A newer run on the same branch means somebody pushed
again, so the failure is about a tree that no longer exists — and if the newer
run failed too, *it* is the one that still stands and raises. Nothing is lost to
an in-flight successor either: if it fails, the next ingest sees a failure newer
than the activation and raises it then.

**`watchingSince` is the instance's `activatedAt`, not a clock read now.** After
a restart the instance has been watching since its original activation
(ADR-0027 restores the record intact), so a fresh `Date.now()` would recategorise
a real downtime's failures as history and drop them.

**The branch lives in `labels`, and that is why `branchOf` exists.** `parseRuns`
puts `headBranch` there. A reader looking for the branch would search for
`branch` and find nothing — the *"absence in one vocabulary is not absence"*
mistake this repository made three times in one day. Naming it once gives the
consumer something to call it, and makes it mutation-checkable.

**The suppression is a row in the book of record**, beside `incident-unclaimed`,
naming the run, its branch, the incident key that was not raised, and the reason.
Invariant §7: a give-up is visible or it did not happen honestly.

---

## 4. Mathematical / statistical details

The ordering that decides "later", stated exactly because the whole rule rests
on it:

> For two CI runs `a`, `b` on the same repository and the same branch, `b` is
> **later** than `a` iff `b.at > a.at`, or `b.at = a.at` and `b.ref > a.ref`.
>
> A failure `f` in batch `B` **still stands** iff no `b ∈ B \ {f}` on the same
> repository and branch is later than `f`. A run whose branch is unknown always
> still stands.
>
> `f` **raises** iff `f.at > watchingSince`, or `f` still stands.

`at` is GitHub's `createdAt`, carried verbatim and never re-derived from a local
clock, so the string comparison is a comparison of the same ISO-8601 format
throughout. `ref` is the run's database id, which increases — the tiebreak
exists because two runs can be created in the same second, and without it
neither overtakes the other and **both** raise, which is the eight rows again
one CI cycle narrower. Mutant M7 removes the tiebreak and dies.

`watchingSince` absent is treated as "everything is new" rather than "nothing
is" — the additive direction, so a caller not yet told about this rule keeps the
behaviour it had rather than silently gaining a filter.

---

## 5. Design decisions

**Both rules, not either — the Architect's call.** The record offered
*"raise only for runs newer than the activation"* or *"suppress a failure a later
success has superseded"*, and noted they behave differently on a repository that
is red at activation. Newer-than-activation alone goes **silent** on a repository
that is already broken: nothing raises until somebody pushes again, which reads
as a healthy company watching a broken repo. Superseded-alone still replays every
failure of a two-week red patch with no green since. Together they bound the cold
start absolutely *and* notice a repository that is broken right now, exactly once.

**Dedupe runs before the cold-start rule, and the order is load-bearing.** A run
raised on one ingest can be overtaken by the next; reporting it superseded then
would file a "nothing happened" row against an incident the company already has.
Mutant M10 reverses the order and dies.

**The board gets no case for the new event, and the explicit `continue` was
deleted.** `incident-superseded` names an incident the board never saw *raised*,
so the existing fall-through drops it — the line changed no behaviour, which is
the shape of a check that cannot fail. The property is asserted by a test
instead, which is what makes it survive a future change to the row's shape.
*(Found by the mutation round: removing the line killed nothing.)*

**A post-activation failure with a later green still raises.** It happened on our
watch, and the crew is told. Suppressing it would make the rule about spend
rather than about history, and SRS §6.1's first clause is detection. The residual
is a real one and is stated: a failure and its fix inside one poll window costs a
triage.

---

## 6. Verification

Full gate, this branch:

```
typecheck   green (node, preload, web, web-test)
lint        All matched files use Prettier code style!
invariants  ok — reachability 188/198 src modules reached, 10 by recorded decision, 6 type-only
tests       Test Files 235 passed (235) · Tests 4524 passed | 8 skipped (4532)
coverage    floors ok (17 subsystems on win32; 20 untested modules, all recorded)
```

**Mutation round, with a control.**

```
test files: incidents · harbor · incident-surface-wiring · incident-view
baseline: GREEN
  M1  nothing historical is ever suppressed          KILLED
  M2  the whole batch is treated as historical       KILLED
  M3  an overtaken run still stands                  KILLED
  M4  only a later SUCCESS overtakes                 KILLED
  M5  the branch is ignored                          KILLED
  M6  a run with no branch is suppressed             KILLED
  M7  the ref tiebreak is dropped                    KILLED
  M8  the suppression is silent                      KILLED
  M9  the branch is read from the wrong place        KILLED
  M10 the dedupe runs AFTER the cold-start rule      KILLED
  CONTROL a no-op comment reword in harbor.ts        SURVIVED — CERTIFIED

mutants: 10 real, 1 control · killed: 10 of 10 real · ROUND OK
```

**The first round scored 8 of 8 and found two gaps anyway.** M7 and M10 were
planted expecting to survive, and did — which meant nothing tested the
same-second tiebreak, and nothing tested what the board does with the new row.
Both became real mutants once the cases existed, and both now die. An expected
survival is a hypothesis, not a licence.

**Adversarial refutation pass.**

| Attempt | Result |
|---|---|
| Does the 2026-09-09 batch still raise anything? | No — zero, against eight. Asserted on that batch's own refs and timestamps. |
| Does a repository that is red at activation go silent? | No — exactly one incident, the newest failure. |
| Two red branches? | One each, not one per run. |
| Two runs created in the same second? | The higher `ref` wins. **Found by the round** — nothing tested it. |
| Can an incident already raised be reported superseded later? | No — dedupe runs first. **Found by the round.** |
| Does a suppressed run appear on the incident board? | No, asserted both alone and paired with a raised row of the same key. |
| Is a run with no branch silently dropped? | No — no branch, no suppression. The wrong direction for the clause §6.1 measures first. |
| Does a restart make a downtime's failures look historical? | No — `watchingSince` is the instance's own `activatedAt`, which the restore keeps. |
| Does an existing caller change behaviour? | No — `watchingSince` is optional and absent means everything is new. |
| Is the suppression silent? | No — a `profile` row naming the run, branch, key and reason. |

---

## 7. Related docs

- [`docs/demo/m8-onehour-aftershock.md`](../demo/m8-onehour-aftershock.md) — Finding 5, and §11's compounding with Finding 3
- [`docs/adr/ADR-0027-what-survives-a-restart.md`](../adr/ADR-0027-what-survives-a-restart.md) — why `activatedAt` survives, and why that is the right clock
- [`docs/srs/SRS.md`](../srs/SRS.md) §6.1 — clause 1, detection
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8c.2, and M8c.3, which owns the policy half
