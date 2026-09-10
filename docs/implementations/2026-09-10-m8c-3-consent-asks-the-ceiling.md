# Findings 3 and 5 compound, and that is the lesson

**Date:** 2026-09-10 · **Milestone:** M8c.3 · **Branch:**
`fix/m8c-3-consent-asks-the-ceiling` from `origin/main` `c60cb81`

---

## 1. Problem / motivation

The filing's own words: *"No ceiling could be set **and** the cold start replayed
two weeks of history. Neither alone is alarming; together they turned 'walk away
for an hour' into 40,453,419 tokens ($11.22)"* — roughly a hundred times the exit
script's own guidance, with the harness projecting 72.3% of the five-hour window
consumed. It reported all of that accurately and continuously; it simply had no
ceiling to enforce and no way for a CLI runner to give it one.

M8c.1 gave the ceiling a surface. M8c.2 stopped the backlog replay. **Neither
makes a run bounded**, because the shipped default is still `unbudgeted`
(ADR-0029) and both real runs went out on it: $11.22 on 2026-09-09 and $17.77 at
the M8b rehearsal, neither bounded by anything.

The package was filed as *"the Architect's call on policy, not a mechanical
fix"*, offering **a default ceiling** or **a first-run confirmation naming
projected spend**.

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/consent.ts` | `budgetAnswerMissing` — the pure rule; the disclosure sentence; `consentGrantPayloadSchema`; **`CONSENT_TERMS_VERSION` 1 → 2.** |
| `src/main/consent.ts` | `grant(acceptUnbudgeted)` refuses an unanswered ceiling before anything is written. |
| `src/shared/control.ts` | `consent:grant --unbudgeted true`, with a schema that reads an answer and refuses a presence. |
| `src/main/control.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/ipc.ts` | The answer travels from both surfaces to the gate. |
| `src/renderer/src/ConsentGate.tsx` | The button says which answer it is giving. |
| `test/main/consent-gate.test.ts`, `test/renderer/consent-gate.test.tsx`, `test/shared/control.test.ts`, `test/main/control-verbs.test.ts` | Seventeen cases, three of them written because the mutation round found the gaps. |

---

## 3. Implementation approach

**Neither of the two filed options — the Architect's call was a third.** Not a
default ceiling, and not a confirmation that names a number and starts anyway.
**The ceiling becomes a question the grant must answer.**

`unbudgeted` stays the shipped default and ADR-0029 stands untouched. What it
stops being is something a company can *start* on by omission:

```
$ node scripts/ephctl.cjs consent:grant
consent was NOT granted: there is no daily token ceiling, and starting without
answering that is the step that gets skipped and then regretted — two real runs
went out unbudgeted and cost $11.22 and $17.77. Set one:
`ephctl budget:set --daily 300000`, or WATCH → settings → Daily budget. To run
without a ceiling on purpose, say so: `ephctl consent:grant --unbudgeted true`.
```

The Architect may still run unbudgeted, and often should — it is the right answer
for a company doing one small thing. **It just has to be an answer.**

**The terms move to v2, and that is the mechanism doing its job.** ADR-0032 gave
consent a `terms` version precisely so that a changed question is re-asked rather
than silently inherited. v1's disclosure said *"spending is unbudgeted until you
set one in WATCH → settings"* and asked nothing; a grant made against that is not
an answer to what v2 asks. Without the bump, the one machine that has already
consented is the one machine this package does not reach.

**A company already running is never re-interrogated.** The check is skipped when
`mayStartWork` is already true, so a second click, a second window, or a grant
racing boot still behaves idempotently — the property `grant()` has always had.

**`--unbudgeted` takes a value.** `ephctl` refuses a flag with no value, and that
refusal is worth more than the keystroke: `--profile --target repo:x` is a
missing value, not two bare flags. Typing `true` is also an affirmative act,
which is the point of this particular flag.

---

## 4. Mathematical / statistical details

No formula. The one number that matters is what `maxDailyTokens` actually means,
because it is easy to read as a company total and it is not:

> Set, `maxDailyTokens` is **both** the figure a hire with no budget of its own
> receives **and** the most any hire may have (`gates.ts`). So a ceiling of
> 300,000 across a five-hire crew bounds the company at **1.5M tokens a day**,
> not 300,000.

Against the measured runs — 40.45M tokens in ~80 minutes across five agents
(2026-09-09), and $17.77 in an hour across five (the rehearsal) — a 300,000
ceiling is roughly **27× under** what the first run actually spent. That is the
figure `EXIT-M8.md` §2 and the refusal above both name, and it is generous rather
than tight, which is the right direction for a number people will copy.

The two costs are quoted as dollars rather than tokens because the two runs
priced differently per token (different models, different mixes), and the dollar
figure is the one the Architect actually pays.

---

## 5. Design decisions

**Ask, rather than default — the Architect's call.** A shipped default ceiling
would bound every run by construction, and it would also mean a company can stop
at a figure nobody chose, quietly, in the middle of an hour somebody was relying
on. Superseding ADR-0029 to get that would trade one silent behaviour for
another. Asking keeps the Architect's intent in the loop exactly once, at the
moment they are already reading a disclosure about spend.

**A confirmation that names projected spend and starts anyway was rejected**
because it changes nothing mechanically: the step that is skipped stays
skippable, which is the whole finding.

**The banner's button says which answer it is giving** — `START UNBUDGETED`
against a company with no ceiling, `START THE COMPANY` against one that has
one. A neutral verb over two different acts is how a person clicks past a
decision without noticing they made it.

**The renderer answers honestly rather than always saying yes.** It sends
`unbudgeted: true` only when the disclosure it is showing has no ceiling. Always
sending `true` would pass the gate for the wrong reason on the day a ceiling is
dropped — mutant M8, which dies.

**What is deliberately NOT done.** No default ceiling; ADR-0029 is untouched and
needs no superseding ADR. And `boot()` still starts a company whose consent is on
file and current, ceiling or not — the question is asked when consent is *given*,
not re-asked every morning, because a company that re-interrogated its own
standing grant would be a company that cannot be left alone, which is what this
milestone is for.

---

## 6. Verification

Full gate, this branch:

```
typecheck   green (node, preload, web, web-test)
lint        All matched files use Prettier code style!
invariants  ok — reachability 188/198 src modules reached, 10 by recorded decision, 6 type-only
tests       Test Files 235 passed (235) · Tests 4536 passed | 8 skipped (4544)
coverage    floors ok (17 subsystems on win32; 20 untested modules, all recorded)
```

**Mutation round, with a control.**

```
test files: consent-gate (main) · consent-gate (renderer) · control (shared) · control-verbs
baseline: GREEN
  M1  an unanswered ceiling is allowed through            KILLED
  M2  the answer is assumed rather than required          KILLED
  M3  a bounded company is interrogated too               KILLED
  M4  an already-consented company is re-interrogated     KILLED
  M5  the refusal names no way out                        KILLED
  M6  the terms did not move                              KILLED
  M7  the screen still reports the absence as a fact      KILLED
  M8  the banner answers 'unbudgeted' whatever the ceiling KILLED
  M9  the CLI flag is ignored                             KILLED
  M10 any truthy string reads as the answer               KILLED
  CONTROL a no-op comment reword in consent.ts            SURVIVED — CERTIFIED

mutants: 10 real, 1 control · killed: 10 of 10 real · ROUND OK
```

**The first round killed only 7 of 10**, and all three survivors were real:

- **M6** — nothing asserted the terms bump meant anything. A grant recorded under
  v1 could have carried straight through, and the one machine that has already
  consented is exactly the machine this package must reach.
- **M9** — nothing asserted the CLI flag reached `grant()`. The verb parsed it
  and the handler could have discarded it.
- **M10** — nothing asserted `--unbudgeted no` is refused. Reading the flag's
  *presence* rather than its *value* would turn an explicit "no" into permission
  to spend without a ceiling.

Three tests later all three die. **Seven of ten is not a score to report; it is a
list of things nobody had tested.**

**Adversarial refutation pass.**

| Attempt | Result |
|---|---|
| Does an unanswered ceiling start the company? | No — refused, and nothing is hired, scheduled or **written down**. A consent recorded for a refused start would come back next boot as an answer nobody gave. |
| Does a company with a ceiling get interrogated? | No — mutant M3 makes it happen and dies. |
| Is a running company re-interrogated on a second grant? | No — the check is skipped once `mayStartWork` is true, so idempotence survives. |
| Does a v1 grant inherit the v2 question? | No — `stale-terms`, and it meets the question. |
| Can `--unbudgeted no` read as yes? | No — only `true` and `'true'` are the answer; six other spellings are refused by name. |
| Does the banner always answer "unbudgeted"? | No — it answers what it is showing, asserted in both directions. |
| Does the refusal teach the rule? | Yes — the cost of not answering, both ways out by exact command, and where in the window. |
| Could the Architect be locked out of starting at all? | No — `--unbudgeted true` is always available, and so is `budget:set`. |

---

## 7. Related docs

- [`docs/adr/ADR-0029-unbudgeted-is-the-default.md`](../adr/ADR-0029-unbudgeted-is-the-default.md) — untouched: the default stays, what changes is that starting on it is a choice
- [`docs/adr/ADR-0032-the-company-asks-before-it-starts.md`](../adr/ADR-0032-the-company-asks-before-it-starts.md) — the gate this extends, and the `terms` mechanism it uses
- [`docs/implementations/2026-09-10-m8c-1-budget-verb.md`](./2026-09-10-m8c-1-budget-verb.md) — the surface this refusal points at
- [`docs/implementations/2026-09-10-m8c-2-cold-start.md`](./2026-09-10-m8c-2-cold-start.md) — the other half of the compounding
- [`docs/demo/m8-onehour-aftershock.md`](../demo/m8-onehour-aftershock.md) §11 — the $11.22 and the 72.3% projection
