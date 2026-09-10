# `WORKING` must cite a row that proves completion

**Date:** 2026-09-10 · **Milestone:** M8c.4 · **Branch:**
`fix/m8c-4-working-cites-completion` from `origin/main` `c60cb81`

---

## 1. Problem / motivation

Finding 7 of [the M8 exit run](../demo/m8-onehour-aftershock.md), and **the
sharpest form of the defect M8.13 was built to prevent.**

At 06:12:41Z, with eight ledger refusals already in the log and zero tasks
succeeded, `DIAGNOSIS.md` said:

```
| incidents | WORKING | profile/incident-raised at seq 85 |
| the crew  | WORKING | spawn at seq 40                   |
```

Seq 85 is real and was quoted honestly. **But `incident-raised` proves only that
an incident was raised** — not that it was routed, triaged, actioned, or even
recorded as a task. Five rows later the ledger refused it, and seven siblings
after that.

M8.13's own rule is *"a log row that PROVES the area did its job"*, and it was
written to stop `working` meaning "nobody asked". It succeeded at that and
introduced the sharper version: **an entry row was accepted as proof of
completion.** The result is not a vacuous pass from silence; it is a false pass
with eight recorded failures in the same file, on the one area the run existed to
exercise. It stayed wrong for the whole run — `incident-triaged` was 0 at the
final check.

*"The same reasoning weakens `the crew | WORKING | spawn at seq 40`: a spawn
proves a process started, not that any agent did work."*

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/diagnosis.ts` | `proves` is completion-only; a new `entered` list carries the entry rows; a fifth verdict, `entered`, renders as `STARTED, UNFINISHED`; `provenWhere` lets a probe test a field; three probes corrected. |
| `test/shared/diagnosis.test.ts` | Eleven cases, including the acceptance's planted entered-but-failing pipeline and a control. |

---

## 3. Implementation approach

**Three states, not two.** `proves` names completion rows; `entered` names entry
rows; an area with an entry row and no completion row reads `entered`.

Reporting that as `not-exercised` would have been a smaller lie in the same
direction — its sentence is *"nothing has happened either way"*, and something
visibly did. So the row says what actually happened:

```
| incidents | STARTED, UNFINISHED | started at seq 85 (profile/incident-raised) and
                                    nothing since proves it finished —
                                    profile:incident-triaged is what would |
```

That last clause is the actionable half: the reader is told the row to grep for.

**The corrected probes, and two of them were not in the finding.** Reading the
table against the log's own vocabulary during this package found two more:

| area | was | is |
|---|---|---|
| `incidents` | `incident-raised`, `incident-triaged` | **`incident-triaged`**; raised is entry |
| `the crew` | `spawn`, `exit` | **`hook`** — an engine event a live agent emitted; spawn and exit are entry |
| `orchestrator` | `orchestrator:spawned`, `spawn` | **`task`, `orchestrator:retro`** — FR-5.2 gives the ledger one scribe and the harness never writes `tasks.json` itself, so a task row is her doing the job |
| `watching a repository` | `remote` | **`remote` with an `inbound` field** — see below |
| `spend` | `cost` | **`budget`** — see below |

**`watching a repository` read `working` because a script had run.** Since M8.14,
`kind: "remote"` carries the Harbor's ingest *and* one row per `ephctl` act. The
bare kind therefore matched a `consent:grant`. The exit run's own runner made
exactly this mistake and wrote down the fix — *"the correct probe is
`"inbound":"ci-run"`"* — and the report was making it too. `provenWhere` exists
for this: a predicate on the matched row, used where the kind alone is ambiguous.

**`spend` proved on `cost`, which is not a log kind and never has been.** It is
absent from `LOG_KINDS`, so that probe could not match anything ever written: a
row that could only ever read `not-exercised`. It is `budget`, which is the kind
the exit run's own §11 read the spend figures from. **A check that cannot pass is
the same defect as a check that cannot fail**, wearing the other face.

---

## 4. Mathematical / statistical details

No formula. The rule is a three-way classification over the book of record, and
it is worth stating exactly because the whole finding is that a two-way one was
lossy:

> For an area with completion set `P`, entry set `E`, and the log `L` read
> newest-first:
>
> - **`broken`/`waiting`** if a live condition names one of its sources;
> - else **`working`** if `∃ r ∈ L` matching `P` (and satisfying `provenWhere`);
> - else **`entered`** if `∃ r ∈ L` matching `E`;
> - else **`not-exercised`**.

The order is load-bearing in both directions. Completion before entry, or a
finished pipeline that also has an entry row would report as unfinished for ever.
Entry before nothing, or the 2026-09-09 state reports as *"nothing has happened
either way"*.

`provenBy` scans **newest-first** and returns the first match, so the cited seq
is the most recent evidence rather than the oldest — which matters for an area
that has completed many times.

---

## 5. Design decisions

**A fifth verdict, rather than folding the state into an existing one.** Three
options were weighed. `working` is the defect. `not-exercised` says something
false about an area that started. `broken` would be worse: a pipeline in flight
is not a fault, and a report that cried broken on every incident between raising
and triaging would train a reader to skip the column — which is the failure mode
`waitingWhen` already exists to prevent for `unbudgeted`. So the state is named
for what it is. `Verdict` has no consumers outside this module, so the cost is
the `MARK` row and the summary block.

**`STARTED, UNFINISHED` is reported BEFORE the unexercised count**, because it is
the sharper news: something is in flight or stuck, where `not-exercised` is
merely unasked.

**The self-explaining section names the 2026-09-09 failure.** `DIAGNOSIS.md`
already tells its reader that `NOT EXERCISED` is not a pass; the new state needs
the same, and the most convincing form of it is the incident that produced it.

**What is deliberately NOT done.** The finding's stronger expected sentence was
`incidents | BROKEN | 8 raised, 0 triaged, 8 task-opens refused by the ledger
(seq 90–105)`. Counting rows and attributing refusals is the incident **board's**
job (`incident-view.ts` folds exactly that), and duplicating it here would make
two readings of one record that can disagree — which is the defect that produced
the consent row's own contradiction at M8.13. This report stays a reading of the
degradation channel and the log, adding no state of its own.

---

## 6. Verification

Full gate, this branch:

```
typecheck   green (node, preload, web, web-test)
lint        All matched files use Prettier code style!
invariants  ok — reachability 188/198 src modules reached, 10 by recorded decision, 6 type-only
tests       Test Files 235 passed (235) · Tests 4547 passed | 8 skipped (4555)
coverage    floors ok (17 subsystems on win32; 20 untested modules, all recorded)
```

**Mutation round, with a control.**

```
test files: diagnosis (shared) · diagnosis-writer
baseline: GREEN
  M1  an entry row proves incidents again              KILLED
  M2  a spawn proves the crew again                    KILLED
  M3  the entered verdict is reported as working       KILLED
  M4  an entered area falls through to not-exercised   KILLED
  M5  the entered row does not say what would prove it KILLED
  M6  a control act proves the Harbor again            KILLED
  M7  the where-predicate is ignored by provenBy       KILLED
  M8  spend goes back to a kind the log does not have  KILLED
  M9  the short answer stops naming unfinished areas   KILLED
  M10 the orchestrator is proven by her own spawn      KILLED
  CONTROL a no-op reword of the Probe comment          SURVIVED — CERTIFIED

mutants: 10 real, 1 control · killed: 10 of 10 real · ROUND OK
```

**M10 survived the first round** — the orchestrator's row was corrected and
nothing tested it, so the correction could have been reverted silently. Two cases
later it dies. That is three packages in a row where a round's survivor was a
missing test rather than an equivalent mutant.

**Adversarial refutation pass.**

| Attempt | Result |
|---|---|
| Does the exact 2026-09-09 state still read `WORKING`? | No — `incidents` and `the crew` both read `STARTED, UNFINISHED` on a log holding `incident-raised` and `spawn`. |
| Does a finished pipeline still read `working`? | Yes — asserted with the completion row present, so the fix is not "never say working". |
| Does a fresh company look mid-flight? | No — an area with neither row still reads `NOT EXERCISED`, asserted as the round's own control case. |
| Can a script make the Harbor look alive? | No — `remote:control` leaves it `not-exercised`; only a row carrying `inbound` proves it. |
| Could the `provenWhere` predicate be ignored? | No — M7 removes the check and dies. |
| Is any probe still naming a kind the log cannot emit? | Not among the twelve — `cost` was the one, and it is now `budget`. Checked against `LOG_KINDS` by hand. |
| Does the reader learn what to look for next? | Yes — the `because` names the completion row by its log spelling. |
| Does the new state hide a genuine break? | No — a live condition on the area's sources still wins, before either row is consulted. |

---

## 7. Related docs

- [`docs/demo/m8-onehour-aftershock.md`](../demo/m8-onehour-aftershock.md) — Finding 7, and §4a's narrowing of it
- [`docs/implementations/2026-09-08-m8-13-diagnosis.md`](./2026-09-08-m8-13-diagnosis.md) — the D1 rule this corrects
- [`docs/implementations/2026-09-10-m8c-2-cold-start.md`](./2026-09-10-m8c-2-cold-start.md) — the `kind: "remote"` ambiguity, from the other side
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8c.4 and its acceptance
