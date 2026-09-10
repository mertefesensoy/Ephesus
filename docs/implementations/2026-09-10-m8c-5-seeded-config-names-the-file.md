# A deduplicated condition must not lose what distinguishes its occurrences

**Date:** 2026-09-10 · **Milestone:** M8c.5 · **Branch:**
`fix/m8c-5-seeded-config-names-the-file` from `origin/main` `c60cb81`

---

## 1. Problem / motivation

Finding 2 of [the M8 exit run](../demo/m8-onehour-aftershock.md), confirmed still
live by [the M8b rehearsal](../demo/m8b-rehearsal-m8b-rehearsal.md)'s Finding C.

`DIAGNOSIS.md` reported:

```
`home/seeded-config` — authority.json was missing and has been created with the
shipped default — review it at C:\Users\senso\ephrun (×2, first seen …)
```

`agora/log.jsonl` seq 1 recorded:

```json
{"kind":"degradation","source":"home","cause":"home/seeded-config",
 "detail":"gate-policy.json was missing and has been created with the shipped default …",
 "count":1,"seq":1}
```

**Two different files, one cause key, one surviving message.** The ring dedupes
on `cause`, so the count reached 2 while only the *last* file's name was
rendered, and the book of record kept only the *first*. **A reader of either
artifact alone learns one of the two files and cannot tell there was another.**

**Why it is not cosmetic.** The file the report drops is `gate-policy.json` — the
one the README describes as *"the company-wide autonomy ceiling and which classes
are held for a human"*, and the file SRS §6.1's last clause depends on entirely.
Of the two seeded files, the report discarded the one whose freshly-defaulted
state a runner most needs to know about.

---

## 2. What changed

| File | What |
|---|---|
| `src/main/home.ts` | `seededConfigConditions` — **new**, pure: one condition per file, keyed by the file, with the rule and the incident behind it. |
| `src/main/index.ts` | Calls it instead of looping with a constant cause. |
| `test/main/home.test.ts` | Six cases, including a control that shows the old shape collapsing. |

---

## 3. Implementation approach

**The key carries the subject.** `home/seeded-config` becomes
`home/seeded-config:gate-policy.json` and `home/seeded-config:authority.json` —
two conditions, two counts, two messages, in both the report and the log.

**The rule this obeys already existed everywhere else.** Reading every
`reportDegradation` in `index.ts` against it, the per-subject conditions all
carry their subject already:

```
settings/restore:<path>          restart/orphan-block:<taskId>
secrets/missing-grant:<agentId>  budgets/state:<agentId>
agents/tool-grants:<agentId>     restart/draftless-gate:<gateId>
```

**`home/seeded-config` was the only loop breaking it.** So this is a defect
against a convention the codebase already holds, rather than a new rule — which
is why the fix is one call rather than a mechanism.

> **A condition reported once per subject carries the subject in its cause, or
> the dedupe throws away exactly what distinguishes the occurrences.**

**It moved out of `index.ts` to be testable at all.** The loop lived in boot
wiring, which no test reaches and which the `boot` coverage row exists to measure
— ENGINEERING-STANDARDS §6.7's *"prefer extracting logic out of `index.ts` to
trusting it there"*. `home.ts` owns `seeded`, so the function sits beside the
thing it describes.

---

## 4. Mathematical / statistical details

No formula. The one property, stated because it is what the test asserts and what
the defect violated:

> For a set of subjects `S` reported under a cause function `c`, the ring's
> dedupe preserves one message per distinct `c(s)`. Information about `s` is
> retained **iff `c` is injective over `S`.**

`c(s) = "home/seeded-config"` is constant — the least injective function there is
— so `|S| − 1` messages were discarded, and *which* one survived depended on
iteration order in the report and on write order in the log. Those two orders
disagreed, which is why one artifact said `authority.json` and the other said
`gate-policy.json`. `c(s) = "home/seeded-config:" + s` is injective because file
names within a directory are unique.

The count is not lost either: each condition now carries its own, where
previously a single `×2` named neither file.

---

## 5. Design decisions

**One condition per file, rather than one message naming both.** The acceptance
allowed either. Per-file keeps each condition's own `count` and `since`, matches
the six existing per-subject causes, and — the deciding reason — degrades
correctly if a third file is ever seeded: a concatenated message grows without
bound and eventually truncates, which is the same defect one size larger.

**The `home/` prefix is preserved deliberately.** `PROBES` matches an area's
`sources` against the part before the slash, so a key that stopped starting with
`home/` would move the condition off the row that reports it — a fix that hid the
thing it was fixing. Asserted, and mutant M5 dies on it.

**No general mechanism was added.** A ring that detected "same cause, different
detail" and warned would catch this class automatically — and would fire on every
legitimate condition whose detail carries a changing count or error string. The
rule is a convention with six examples and now a seventh; a mechanism nobody
could trust would be worse than the convention. What *is* mechanical is the test:
the causes are asserted as a **set**, so two files collapsing to one key fails.

---

## 6. Verification

Full gate, this branch:

```
typecheck   green (node, preload, web, web-test)
lint        All matched files use Prettier code style!
invariants  ok — reachability 188/198 src modules reached, 10 by recorded decision, 6 type-only
tests       Test Files 235 passed (235) · Tests 4558 passed | 8 skipped (4566)
coverage    floors ok (17 subsystems on win32; 20 untested modules, all recorded)
```

**Mutation round, with a control.**

```
test files: home · diagnosis (shared)
baseline: GREEN
  M1 the cause goes back to a constant            KILLED
  M2 only the first seeded file is reported       KILLED
  M3 the detail stops naming the file             KILLED
  M4 the detail stops naming the home             KILLED
  M5 the cause loses its `home/` source           KILLED
  M6 an empty list reports one condition anyway   KILLED
  CONTROL a no-op reword of the function comment  SURVIVED — CERTIFIED

mutants: 6 real, 1 control · killed: 6 of 6 real · ROUND OK
```

**Adversarial refutation pass.**

| Attempt | Result |
|---|---|
| Do two seeded files still collapse to one? | No — two distinct causes, asserted as a set size. |
| Does the fix move the condition off its `DIAGNOSIS.md` row? | No — the `home/` source is preserved and asserted. |
| Is any OTHER per-subject condition still using a constant cause? | No — every `reportDegradation` loop in `index.ts` was read; the six others already carry their subject. |
| Does a home that seeded nothing report anything? | No — asserted, and M6 dies. |
| Is the control case meaningful, or a tautology? | It runs the old shape and shows it collapsing to one key — the predicate can fail, and does. |
| Does the test pin the file NAMES, or just the count? | The names, in order, and the detail text of each. |
| Could the detail lose the home path? | M4 removes it and dies — the path is what tells a runner where to go and read the file. |

---

## 7. Related docs

- [`docs/demo/m8-onehour-aftershock.md`](../demo/m8-onehour-aftershock.md) — Finding 2
- [`docs/demo/m8b-rehearsal-m8b-rehearsal.md`](../demo/m8b-rehearsal-m8b-rehearsal.md) — Finding C, confirming it still live
- [`docs/ENGINEERING-STANDARDS.md`](../ENGINEERING-STANDARDS.md) §6.7 — why it left `index.ts`
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8c.5, and M8c.6, the same class in a label
