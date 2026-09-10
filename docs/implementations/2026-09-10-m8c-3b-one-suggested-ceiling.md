# One suggested ceiling, and a refusal that reads once

**Date:** 2026-09-10 · **Milestone:** M8c.3b (a defect in M8c.3's own deliverable)
· **Branch:** `fix/m8c-3b-refusal-reads-once` from `origin/main` `afe30f1`

---

## 1. Problem / motivation

Found by **running the M8c rehearsal**, five minutes in, before any agent had
been hired. `EXIT-M8.md` §2 sends the runner to `consent:grant` and the refusal
came back:

```text
consent was NOT granted: consent was NOT granted: there is no daily token
ceiling, … Set one: `ephctl budget:set --daily 300000`, …
```

Two defects in one line, both mine, both landed the same morning:

1. **It reads twice.** `ControlServer` prefixes `consent was NOT granted:` at
   `control.ts:535`, and M8c.3's `grant()` had added the same prefix to the
   reason it returns. A refusal that stutters is a refusal a reader stops
   reading — the exact failure mode *a refusal must teach the rule* warns about,
   introduced by the package that was fixing it.

2. **It named 300,000, which M8c.1b had just corrected to 5,000,000.** Not a
   stale number: a number that lived in **five places**, one of which moved.
   §2 was rewritten with the measurements behind it (the 2026-09-09 crew spent
   4.9M, 9.4M, 10.2M, 16.0M and 0 tokens per hire) and the four surfaces a reader
   actually *meets* — the consent screen, the refusal, `budget:set`'s usage line,
   and the README — kept the old one.

The second is the more serious. **The run script and the product disagreed about
the one number the run turns on**, and a runner following §2 would set 5,000,000
while every surface in the app told them 300,000 — a figure that stops every
agent in that crew within minutes and fails clauses 1b and 2 for a reason that
has nothing to do with the company.

---

## 2. The fix, which is not four edits

`maxDailyTokensSchema`'s own comment, written for the *bound* in an earlier
milestone, already states the rule:

> The daily token ceiling's bounds, defined ONCE and used by both the file schema
> and the wire schema. **Written twice they agreed by coincidence**, and a later
> widening of one would have let a figure the policy file rejects reach the
> writer.

The suggestion needed the same treatment and had not been given it.
`SUGGESTED_DAILY_TOKENS = 5_000_000` now sits beside the bound, carrying the
measurement that justifies it, and the three code surfaces interpolate it. The
README is prose and cannot interpolate, so it is pinned by a test instead.

**Where the figure came from:** it is measured, not chosen. 5,000,000 per hire
bounds the 16.0M outlier the 2026-09-09 run actually produced while leaving room
for the work the clauses ask about; five hires at that ceiling cap an hour at
25M against the 40.45M it cost unbounded.

---

## 3. What changed

| File | What |
|---|---|
| `src/shared/gates.ts` | **new** `SUGGESTED_DAILY_TOKENS`, beside the bound whose comment already records this lesson. |
| `src/shared/consent.ts` | Both strings interpolate it; `budgetAnswerMissing` and the screen now say **PER HIRE**; the screen drops its package id. |
| `src/shared/control.ts` | `budget:set`'s usage line interpolates it. |
| `src/main/consent.ts` | `grant()` returns the reason **unprefixed** — the control surface adds its own. |
| `README.md` | `--daily 5000000`, and says *per hire*. |
| `test/main/consent-gate.test.ts` | The drift guard: three surfaces, one figure; PER HIRE on both that suggest one; no package id on the consent screen; and the refusal does not prefix itself. |
| `test/docs/exit-m8-script.test.ts` | The README's figure must equal the constant. |

**One deliberate non-change.** `SettingsPanel`'s ceiling field starts empty with
`placeholder="tokens"`. It names no figure, so it cannot disagree with one, and a
placeholder that looks like a value is its own defect. The window user is told
the number on the consent screen, which is the screen they meet first.

---

## 4. Mathematical / statistical details

No formula. One arithmetic claim, stated so it can be audited:

> Per-agent spend on 2026-09-09 was **4.9M, 9.4M, 10.2M, 16.0M and 0** tokens,
> summing to **40.45M** for the hour. `maxDailyTokens` is **per hire** — it is
> both the default a hire with no declared budget receives and the most any hire
> may have (ADR-0029) — so a ceiling of *c* bounds a crew of *n* at *n·c*.
> At c = 5,000,000 and n = 5 the hour is capped at **25M**, below what it cost
> unbounded, and above the largest single agent's 16.0M. At c = 300,000 the
> largest agent is stopped at **1.9% of its observed work**.

The factor between the two figures is **16.7×**, and §2's superseded phrase — *"a
few hundred thousand tokens is generous"* — is wrong by about that much.

---

## 5. Design decisions

**The constant lives in `gates.ts`, not `consent.ts`.** The budget vocabulary is
already there and `consent.ts` already depends on the gate policy's shape;
putting it in `consent.ts` would have made `control.ts` import the consent module
for a number that is not about consent.

**The refusal is unprefixed at the source, not de-duplicated at the sink.** The
alternative — having `ControlServer` strip a prefix it finds — makes the string a
protocol between two modules and would have hidden a *third* prefix rather than
preventing it. The banner renders the reason behind a warning glyph and needs no
prefix at all, which is the evidence that the prefix belongs to the CLI and not
to the answer.

**The package id came off the consent screen.** That screen is read by the person
granting spend authority on their own subscription. An internal milestone label
tells them nothing and spends a line of their trust; it belongs in the test name
and the commit, where it already is.

---

## 6. Verification

Full gate, this branch:

```text
typecheck   green (node, preload, web, web-test)
lint        All matched files use Prettier code style!
invariants  ok — reachability 189/199 src modules reached, 10 by recorded decision, 6 type-only
tests       Test Files 236 passed (236) · Tests 4607 passed | 8 skipped (4615)
coverage    floors ok (17 subsystems on win32; 20 untested modules, all recorded)
```

**On `npm run test:coverage`'s exit code.** It exits 1 on this machine with
`EPERM: rmdir 'coverage\.tmp'` — the v8 provider's teardown racing OneDrive's
file handle. The same suite under `npm test` reports the same 236 files and 4607
tests and exits **0**, and `check-coverage.cjs` reads a complete report. The
failure is environmental and pre-existing; it is recorded rather than worked
around, because lowering a gate to make a run look clean is the thing this
milestone exists to not do.

**Mutation round, with a control.**

```text
test files: consent-gate (main) · consent-gate (renderer) · control (shared)
            · control-verbs · exit-m8-script
baseline: GREEN
  M1 the consent screen hardcodes the figure again        KILLED
  M2 the usage line hardcodes a different one             KILLED
  M3 the refusal prefixes itself again, and reads twice   KILLED
  M4 the one source moves, product and script disagree    KILLED
  M5 the screen stops saying whose ceiling it is          KILLED
  M6 the refusal stops saying whose ceiling it is         KILLED
  M7 the package id returns to the consent screen         KILLED
  CONTROL a no-op reword in the constant's own comment    SURVIVED — CERTIFIED

mutants: 7 real, 1 control · killed: 7 of 7 real · ROUND OK
```

**7 of 7 on the first round is not a strong result and should not be read as
one.** Every mutant here is a string identity, and the tests were written against
those exact strings minutes earlier. The round proves the guard is wired; it
proves nothing about coverage of a defect nobody thought of. Which is the point
of the next section.

**Adversarial refutation pass.**

| Attempt | Result |
|---|---|
| Is there a surface the round did not cover? | **Yes — the README**, still on 300,000. Found here, not by the mutants. |
| Is `SettingsPanel` a sixth? | No — it names no figure. Confirmed by reading the markup, not by grep. |
| Does the CLI still say the refusal headline at all? | Yes, once, from `control.ts:535` — asserted in `control-verbs.test.ts`. |
| Does the banner lose the fact that it refused? | No — it renders the warning glyph and stays up with the disclosure and the button. |
| Could the constant drift from `EXIT-M8` §2? | No — `exit-m8-script.test.ts` pins §2 to `--daily 5000000` and M4 moves the constant and dies. |
| Is the figure defensible, or just larger? | Measured: it bounds the 16.0M outlier and caps five hires under the 40.45M the unbounded hour cost. |
| Does anything still read 300,000 as a suggestion? | No. The two remaining mentions are in `EXIT-M8` §2 and this doc, both arguing why it is wrong. |

**What this cannot claim.** That the refusal is now *right* — only that it reads
once and names a figure the rest of the tree agrees with. Whether 5,000,000 is
the correct ceiling is a question the next real run answers.

---

## 7. Related docs

- [`docs/implementations/2026-09-10-m8c-3-consent-asks-the-ceiling.md`](./2026-09-10-m8c-3-consent-asks-the-ceiling.md) — the package this corrects
- [`docs/implementations/2026-09-10-m8c-1-budget-verb.md`](./2026-09-10-m8c-1-budget-verb.md) — `budget:set` and §2's figure
- [`docs/adr/ADR-0029-unbudgeted-is-the-default.md`](../adr/ADR-0029-unbudgeted-is-the-default.md) — per hire, and why the default stands
- [`docs/EXIT-M8.md`](../EXIT-M8.md) — §2, the section that carried the corrected figure first
