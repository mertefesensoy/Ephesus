# A ceiling must be reachable without a mouse

**Date:** 2026-09-10 · **Milestone:** M8c.1 · **Branch:**
`fix/m8c-1-budget-verb` from `origin/main` `314fbc7`

---

## 1. Problem / motivation

Finding 3 of [the M8 exit run](../demo/m8-onehour-aftershock.md), confirmed still
live by [the M8b rehearsal](../demo/m8b-rehearsal-m8b-rehearsal.md)'s Finding C.

`EXIT-M8.md` §2 is titled *"Set a ceiling before you walk away"*, calls itself
*"the step that is skipped and then regretted"*, instructs **WATCH → settings →
Daily budget**, and closes: *"A run whose spend nobody bounded cannot say whether
the budget controls work."*

There was no budget verb in the control surface at all:

```
$ node scripts/ephctl.cjs budget:set --daily 300000
no such verb: "budget:set".
```

Not offered — and, unlike `watch:approve`, `odeon:verdict`, `secrets:set` and
`gym:set-mode`, **not in the deliberately-refused list either.** It was simply
absent, and M8.14's recorded scope mentions budget in neither column.

**That is a contradiction inside the run.** ADR-0033 and the 2026-09-08 Architect
decision exist so the exit can be performed with no mouse; §2 then required a
window-only action and marked it mandatory. Both cannot hold, and what actually
happened is that both runs went out on the shipped `unbudgeted` default — the
first spending **40,453,419 tokens ($11.22)** against a script whose own guidance
is *"a few hundred thousand tokens is generous"*.

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/control.ts` | The `budget:set` verb, its argument schema, and **`budgetSetVerdict`** — the pure rule that decides whether a move is a tightening. |
| `src/main/control.ts` | The handler: reads the policy view, refuses on the deny-all fallback, applies the verdict, patches only the ceiling. |
| `docs/EXIT-M8.md` | §2 names the verb, says it may only lower, and keeps the window path for a runner who has one. |
| `README.md` | The `ephctl` paragraph lists it, with the tighten-only rule in one sentence. |
| `test/shared/control.test.ts` | Six cases on the rule and the verb table. |
| `test/main/control-verbs.test.ts` | Four on the handler, including the two it must never do. |
| `test/docs/exit-m8-script.test.ts` | Four pinning §2's CLI line — **added because the mutation round found nothing guarding it.** |

---

## 3. Implementation approach

**The rule is pure and lives beside the verb table.** `budgetSetVerdict(current,
requested)` is the whole decision, in `src/shared/control.ts`, next to
`REFUSED_VERBS` — so the thing that decides what a script may do sits with the
list of what it may not, and a mutation to either is killable by the same file's
tests.

**Three cases, and the third is the one that makes it usable:**

| From | To | Verdict |
|---|---|---|
| `unbudgeted` (`null`) | anything | **allowed** — ADR-0029 ships no ceiling, so the first one is always a tightening |
| a ceiling | lower | **allowed**, and the message says what moved |
| a ceiling | the same | **allowed**, reported as `unchanged` |
| a ceiling | higher | **refused**, by name, with the reason and where to go |

Equal is allowed deliberately. A setup script that cannot read the current value
first would otherwise be unable to assert a ceiling idempotently, and refusing a
no-op would make the verb unusable for exactly the runner it exists for.

**The handler patches the ceiling and carries the autonomy through untouched.**
`saveGateCeilings` writes *both* company-wide ceilings, so a handler that
rebuilt the object rather than spreading `ceilingsOf(view)` would move a safety
dial nobody asked it to. That is mutant M7, and it dies.

**It refuses to write while the policy file is unreadable.** `GatePolicyView`
carries a `warning` that is non-null exactly when the harness is running on
`denyAllPolicy`. Saving a ceiling then would persist that fallback's `manual`
autonomy as though somebody had chosen it — a degradation written back as a
setting, which is invariant §7's exact failure. That is mutant M8.

---

## 4. Mathematical / statistical details

The only arithmetic is the ordering that defines a tightening, and it is stated
in full because a ceiling is a safety control:

> Let `c ∈ ℕ⁺ ∪ {∅}` be the ceiling in force, where `∅` is `unbudgeted`, and
> `r ∈ ℕ⁺` the requested figure. A script may write `r` iff **`c = ∅` or
> `r ≤ c`.**

`∅` is treated as the top of the order rather than as zero — the direction that
matters, since ADR-0029 makes `unbudgeted` the shipped default and reading it as
`0` would refuse every first ceiling. Mutant M3 makes exactly that mistake and
dies. `r` is bounded by `maxDailyTokensSchema` (`int().positive().max(1e9)`),
which is the *same* schema the policy file and the settings panel use — a second
set of bounds here would agree by coincidence and drift by edit, which is the
defect that schema's own comment records.

**One direction only, and the consequence is worth stating.** The ratchet has no
CLI path back up: there is no `--daily 0`, no way to send `null`, and a raise is
refused. A script can therefore tighten the company to a figure only a person
can loosen. That is the intended asymmetry — safety is the direction a script
may move in — and the WATCH tab is the way back.

---

## 5. Design decisions

**A verb, not a refusal.** The acceptance allowed either. A refusal would have
left §2 marking a window-only step mandatory for a runner with no mouse, so the
script would have needed changing anyway — and it would have refused something
that authorises nothing. ADR-0033's rule is *"a script may run the company; only
a human may authorise what the company is not otherwise allowed to do."* **A
ceiling does not allow anything; it caps.** Lowering one is therefore squarely a
script's to make.

**Tighten-only, rather than a plain setter — the Architect's call.** A plain
setter would let a script raise a ceiling a person set, which is the same shape
as widening the autonomy ceiling. The asymmetry is the house pattern everywhere
else in the tree: profile autonomy composes stricter-wins, `gate-policy.json`
*"can only ever loosen, never tighten"* is the thing the threat model worries
about, and this verb sits on the other side of that line by construction.

**No verb for the autonomy ceiling, and §2 now says so.** Raising it is the
one thing §6.1's last clause is measuring; lowering it would also change what is
being measured. Left out on purpose rather than by omission.

**What is deliberately NOT done, and where it belongs.** §2 sits *after* §1's
activation, so the ceiling is set once the crew is already hired — and the exit
run's Finding 5 shows the first ingest raising eight incidents within two
minutes of activation, before §2 would have run at all. Bounding *that* is the
cold start (M8c.2) and the policy question of a default ceiling (M8c.3), which
is where the ordering belongs. Recorded here so it is not mistaken for an
oversight.

---

## 6. Verification

Full gate, this branch:

```
typecheck   green (node, preload, web, web-test)
lint        All matched files use Prettier code style!
invariants  ok — reachability 187/197 src modules reached, 10 by recorded decision, 6 type-only
tests       Test Files 234 passed (234) · Tests 4500 passed | 8 skipped (4508)
coverage    floors ok (17 subsystems on win32; 20 untested modules, all recorded)
```

**Mutation round, with a control.**

```
test files: control (shared) · control-verbs · exit-m8-script
baseline: GREEN
  M1  a raise is allowed                                  KILLED
  M2  an equal ceiling is refused as a raise              KILLED
  M3  unbudgeted is treated as a ceiling of zero          KILLED
  M4  the refusal stops teaching the rule                 KILLED
  M5  the verb is not a write, so the act is unrecorded   KILLED
  M6  the bounds are the verb's own, not the policy file's KILLED
  M7  the handler drops the autonomy ceiling              KILLED
  M8  the handler writes into the deny-all fallback       KILLED
  M9  a refused save is reported as done                  KILLED
  M10 EXIT-M8 §2 stops naming the verb                    KILLED
  CONTROL a no-op reword in the verdict's comment         SURVIVED — CERTIFIED

mutants: 10 real, 1 control · killed: 10 of 10 real · ROUND OK
```

**M10 SURVIVED on the first round, and that was a finding rather than a
control.** Nothing asserted that §2 names the verb — the CLI line could be
dropped and every test stayed green, which is M8c.10's own defect one section
along: a sentence nobody re-reads deciding the outcome of an hour. Four
assertions were added, and the mutant now dies.

**Adversarial refutation pass.**

| Attempt | Result |
|---|---|
| Can a script raise a ceiling by removing it first? | No — the schema has no `null`, no `0`, and no `--unbudgeted`. There is no CLI path back up at all. |
| Can it raise one by setting the same value twice? | No — `unchanged` writes the same figure. |
| Does a refused raise still write? | No — asserted with a recording stub that must stay empty. |
| Does setting a ceiling move the autonomy ceiling? | No — `ceilingsOf(view)` carries it through, and M7 dies. |
| Does it write into the deny-all fallback? | No — refused, naming the file, and M8 dies. |
| Is a failed save reported as success? | No — M9 dies. |
| Are the bounds the policy file's, or a second copy? | The file's — `maxDailyTokensSchema`, and M6 dies. |
| Does the act reach the book of record? | Yes — `writes: true`, pinned by the verb-table test that lists every write. |
| Does the refusal teach the rule, to `watch:approve`'s standard? | Yes — it names the act, the two figures, the reason, where to go instead, and the general rule. Asserted clause by clause. |
| Can a careless script tighten the company to uselessness? | **Yes, and by design.** One token a day is a legal tightening only a person can undo. Stated in §4 rather than guarded against: safety is the direction a script may move in. |

---

## 7. Related docs

- [`docs/adr/ADR-0033-a-script-may-run-the-company.md`](../adr/ADR-0033-a-script-may-run-the-company.md) — the rule this verb sits inside
- [`docs/adr/ADR-0029-unbudgeted-is-the-default.md`](../adr/ADR-0029-unbudgeted-is-the-default.md) — why `null` is the top of the order, not the bottom
- [`docs/EXIT-M8.md`](../EXIT-M8.md) §2 — the step this makes performable
- [`docs/demo/m8-onehour-aftershock.md`](../demo/m8-onehour-aftershock.md) — Finding 3, and §11's cost against the ceiling nobody could set
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8c.1, and M8c.3, which owns the policy half
