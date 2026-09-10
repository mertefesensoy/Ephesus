# Labels and docs that are true in the reader's vocabulary

**Date:** 2026-09-10 · **Milestone:** M8c.6 · **Branch:**
`fix/m8c-6-armed-says-which` from `origin/main` `c60cb81`

---

## 1. Problem / motivation

Findings 4 and 1 of [the M8 exit run](../demo/m8-onehour-aftershock.md), and
**Finding 4 caught a second runner** at the M8b rehearsal.

`profile:activate` and `profile:instances` both reported:

```
armed  skeleton-crew@repo:aftershock/dependency-sweep, skeleton-crew@repo:aftershock/health-sweep
```

No `ci` trigger. And `EXIT-M8.md` §5.1 says, unambiguously:

> `event: "incident-unclaimed"` means the incident reached nobody — **the
> instance has no `ci` trigger bound** … That is a setup defect, and **the run
> cannot proceed past it.**

**The documented reading of that output is therefore: stop, the run is invalid.**

It was bound. `profiles/skeleton-crew/triggers/ci-failure.json` declares it, and
it was proved bound minutes later when the ingest raised eight incidents through
it. `armed` means *"has a clock running"*, so it can only ever list
`kind: "schedule"` triggers — **an event trigger has no clock to arm and is
structurally invisible on that line however correctly it is bound.** The word is
accurate to the implementation and misleading to a stranger, and the stranger is
exactly who the script is for. The 2026-09-09 runner *"nearly aborted a valid
run on it"*; the rehearsal met it again.

**Finding 1, the same shape in prose.** `EXIT-M8.md` §1 sends the runner to
README → *Setting it up*, which said only *"**1. The toolchain.** Node 20
(`.nvmrc`)"*. The correct floor — Node 20.19+ or 22.12+ — was in *Quick start*,
which the exit script does not name. The 2026-09-08 decision log records this as
*"Also fixed"*. **The fix reached Quick start only.**

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/control.ts` | `triggerLines` — **new**, pure: two lines, both always printed, naming schedules and event triggers separately and marking a declared schedule the scheduler is not holding. |
| `src/main/control.ts` | `profile:activate` and `profile:instances` both use it. |
| `docs/EXIT-M8.md` | §5.1 shows the new output and says **which line is the setup defect**. |
| `README.md` | *Setting it up* states the floor, in the toolchain step itself. |
| `test/shared/control.test.ts` | Six cases on the renderer, including a control reproducing the old output. |
| `test/docs/exit-m8-script.test.ts` | Six pinning both documentation halves. |
| `test/main/control-verbs.test.ts`, `test/main/control-server.test.ts` | Fixtures gain the `triggers` a real plan always carries; assertions cover both lines. |

---

## 3. Implementation approach

**Two lines, both always printed:**

```
armed (schedules)  dependency-sweep, health-sweep
event triggers     ci → agent.…-ci-babysitter (ci-failure)
```

**The empty case is the point.** An event line reading `(none)` is what a
missing trigger actually looks like — and the *absence* of a line is what a
runner read as a missing trigger. So neither line is ever omitted, and mutant M2
(omit it when empty) dies.

**The plan is the source, and `armed` is the check.** Schedules come from
`plan.triggers`, because that is where both kinds live; `armed` is consulted only
to mark one the scheduler is not actually holding:

```
armed (schedules)  dependency-sweep — NOT ARMED
```

That state is the *real* version of what §5.1 worries about, and it was
previously indistinguishable from a trigger that was never declared.

**Two vocabularies for one id, met in one place.** The scheduler holds
`<instance>/<trigger>`; the plan holds `<trigger>`. `triggerLines` matches on the
suffix, deliberately inside the renderer rather than in a caller that would have
to know both — which is the exact shape of the `when === 'ci'` defect that cost
the incident path its whole production life (`profile-activation.ts` §295 says
so in as many words: *"a display string is not a contract"*).

---

## 4. Mathematical / statistical details

No formula. The one thing worth stating precisely is the partition, because the
defect was that it was invisible:

> For a plan's trigger set `T`, `schedules = { t ∈ T : t.everyMs ≠ null }` and
> `events = { t ∈ T : t.everyMs = null ∧ t.event ≠ null }`. These are disjoint,
> and `armed ⊆ schedules` **by construction** — the scheduler only ever holds a
> clock, so `armed ∩ events = ∅` is not a coincidence to preserve but a fact of
> what a clock is.

The old rendering printed `armed` alone, which is the *image* of that projection.
Any `t ∈ events` was therefore unrepresentable in the output regardless of its
value — the label was not merely unhelpful, it was **incapable** of carrying the
answer the reader was told to look for. That is what makes this a different class
from a badly-worded message.

---

## 5. Design decisions

**Both lines, rather than one merged list.** A single `triggers` line naming all
of them would have fixed the invisibility and lost the distinction that matters
operationally: a schedule fires on a clock this process owns, an event trigger
fires when the world does something. A runner debugging silence needs to know
which they are looking at.

**`NOT ARMED` rather than omitting an unarmed schedule.** Omission is how this
defect started. A declared schedule with no clock is a fact worth saying out
loud, and it is exactly the state a restored-but-not-reactivated instance is in
(ADR-0027: *"schedule trigger(s) stay disarmed until it is reactivated"*).

**§5.1 keeps its warning and gains the reading.** The `incident-unclaimed` row is
still a real setup defect; what changed is that the runner is told which line to
check *before* the hour, and that an empty `event triggers` line is the thing to
stop on. Deleting the warning would have removed a true statement to fix a
misleading one.

**Both README sections are pinned, not just the one that was wrong.** The
2026-09-08 record shows a fix reaching one of two sections; asserting only the
newly-fixed one would leave the same failure available in the other direction.

---

## 6. Verification

Full gate, this branch:

```
typecheck   green (node, preload, web, web-test)
lint        All matched files use Prettier code style!
invariants  ok — reachability 188/198 src modules reached, 10 by recorded decision, 6 type-only
readme      landed list is current for M8 (16 packages)
tests       Test Files 235 passed (235) · Tests 4564 passed | 8 skipped (4572)
coverage    floors ok (17 subsystems on win32; 20 untested modules, all recorded)
```

**Mutation round, with a control.**

```
test files: control (shared) · control-verbs · control-server · exit-m8-script
baseline: GREEN
  M1 event triggers are not listed at all              KILLED
  M2 the event line is omitted when empty              KILLED
  M3 schedules and events are not told apart           KILLED
  M4 a declared-but-unarmed schedule reads as armed    KILLED
  M5 the instance-qualified id no longer matches       KILLED
  M6 the event line drops the agent it wakes           KILLED
  M7 EXIT-M8 §5.1 stops naming the two lines           KILLED
  M8 the README setup section drops the Node floor     KILLED
  CONTROL a no-op reword in triggerLines' comment      SURVIVED — CERTIFIED

mutants: 8 real, 1 control · killed: 8 of 8 real · ROUND OK
```

**M8 survived the first round, and the reason is worth keeping.** The test
asserted the section contained `'20.19'`. The mutant reverted the toolchain line
to *"Node 20 (`.nvmrc`)"* — and the assertion still passed, because the
*following* sentence quotes the lockfile's range `^20.19.0 || >=22.12.0`. **A
documentation guard that matches a substring anywhere in a section is a guard
against nothing in particular.** It now matches the toolchain step itself.

**Adversarial refutation pass.**

| Attempt | Result |
|---|---|
| Can an event trigger still be invisible? | No — its line is always printed, and `(none)` is what an absent one looks like. |
| Does the fix hide a schedule that is genuinely unarmed? | No — it says `NOT ARMED`, which the old output could not distinguish from "never declared". |
| Do the scheduler's ids and the plan's still fail to meet? | No — matched on the suffix, asserted with bare, qualified, and other-instance ids. |
| Does §5.1 still tell a runner to abort on a bound trigger? | No — it shows the new output and names the empty event line as the defect. |
| Does the README fix reach the section §1 actually sends you to? | Yes, and the section that was already right is pinned too. |
| Is the doc guard matching something incidental? | It was — found by M8, and now it matches the toolchain step. |
| Do the fixtures look like production? | They do now: a real plan always carries `triggers`, and the fixtures did not. That is why `triggerLines` threw on them rather than reporting nothing — the function is total over real input and the fixture was not real. |

---

## 7. Related docs

- [`docs/demo/m8-onehour-aftershock.md`](../demo/m8-onehour-aftershock.md) — Findings 4 and 1
- [`docs/demo/m8b-rehearsal-m8b-rehearsal.md`](../demo/m8b-rehearsal-m8b-rehearsal.md) — Finding C, the second runner
- [`docs/EXIT-M8.md`](../EXIT-M8.md) §5.1 — the trap, and what it says now
- [`docs/implementations/2026-09-10-m8c-5-seeded-config-names-the-file.md`](./2026-09-10-m8c-5-seeded-config-names-the-file.md) — the same class, in a dedupe key
