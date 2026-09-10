# GYM-008 — A mutation round is a tool, not a scratch script

**Status:** proposed · **Raised:** 2026-09-10 · **Gate:** Architect approval
(tooling + a Definition-of-Done clause; no invariant, ADR, gate policy, secret or
dependency is touched)

---

## Evidence

**The round has been the third leg of the verification bar for three milestones,
and it has never been checked in.** M8c alone ran **11 rounds** — one per package
plus M8c.3b — every one of them driven by a 122-line Python script written into a
session scratchpad and deleted with the session. `scripts/` contains no mutation
tooling of any kind.

That is not merely wasteful. It is the same class of defect the rounds exist to
find, one level up: **the instrument is unversioned, so its correctness is
re-argued from memory each time and its bugs recur.**

*What the missing tool has already cost, from the record:*

- **2026-09-09, `docs/DECISIONS-LOG.md`** — *three M8b rounds reported perfect
  scores they had not earned.* The cause was a harness that could not tell "the
  mutant was applied and the tests caught it" from "the mutant was never
  applied". The correction produced the seven requirements now in the Architect's
  own words, and those requirements live only in a prompt and in a deleted file.
- **This milestone, rebuilding it from those requirements:** two harness bugs
  before the first round could run (`subprocess.run() got multiple values for
  'shell'`; a `UnicodeEncodeError` on a cp1252 console, fixed with
  `sys.stdout.reconfigure(errors='replace')`), and a third found mid-milestone
  (`--reporter=basic` is not valid in vitest 4 — reported correctly as **INVALID**
  rather than scored as a kill, which is requirement 3 doing its job).
- **M8c.3b, this morning:** the spec's `find` anchor is not verified to match
  **exactly once**. An anchor matching zero times makes the mutant a no-op and
  the round reports a survival it did not earn — the *precise* failure the
  control was introduced to catch, still reachable through a different door. I
  wrote that assertion by hand, in the calling script, for one round. It is not
  in the harness.
- **M8c.7:** a survivor (`M6`) that no test *could* kill, because it replaced the
  tail of a two-line concatenation while the asserted phrase sat on the line
  before. **A round's survivors must be triaged, not counted**, and nothing in
  the tooling says so — it is remembered, or it is not.

**45 entries in `docs/DECISIONS-LOG.md` mention a mutation or a mutant.** The
practice is load-bearing and undocumented as a tool.

---

## Proposal

Promote the harness to `scripts/mutate.cjs`, with the round spec as a checked-in
file per package, and make the seven requirements executable rather than
remembered.

**Files**

| File | What |
|---|---|
| `scripts/mutate.cjs` | **new.** The runner. Node, not Python — the repo already requires Node and nothing else in `scripts/` is Python. |
| `test/scripts/mutate.test.ts` | **new.** The harness's own tests, including the ones below that no scratch script ever had. |
| `docs/TEST-STRATEGY.md` §? | The round's definition, the seven requirements, and what a survivor obliges you to do. |
| `docs/ENGINEERING-STANDARDS.md` §5 | One sentence in the Definition of Done: a gate-shaped or rule-shaped package carries a round with a certified control. |

**Mechanism.** `node scripts/mutate.cjs <spec.json>` where the spec names the
test files and the mutants, exactly as the throwaway already does. The seven
requirements become code paths with tests:

1. a planted no-op **CONTROL** whose survival certifies the round — and the run
   **fails** if the spec declares none;
2. the suite runs once before the first mutant; the round **aborts** unless green;
3. "the suite refused to start" is **INVALID**, never a kill — distinguished by
   the runner's own exit signature, not by parsing prose;
4. every target file hashed before and after each mutant, and after the restore;
5. all reads and writes byte-exact (`newline=''` both ways);
6. the tree must be committed first, so `git status` is a second check and
   `git checkout --` is the restore;
7. the round reports which test **files** it ran.

**Plus the two the scratch script did not have**, both of which are this
milestone's evidence:

8. **an anchor must match exactly once** — zero occurrences is `INVALID`, not a
   survival; more than one is `INVALID`, not a silent multi-edit;
9. **a survivor exits non-zero and prints the triage question** — *is this state
   reachable from outside the module, and can any listed test file read the line
   you changed?* — so that a survivor is a stop, not a number in a table.

**Where the specs live.** `test/mutation/<package>.json`, checked in beside the
tests they mutate. A spec is evidence: it says exactly which sentences a package
claims to defend, and it rots visibly when the code moves — an anchor that stops
matching is requirement 8 firing in CI rather than a stale file nobody opens.

**What this is not.** Not Stryker, not a coverage-driven mutant generator, and
not a CI job on every PR. The rounds that have paid are **hand-aimed at the
sentence the package is about**, and an automatic generator produces mostly
equivalent mutants — which this repo has already learned to treat as a design
smell rather than a score. It stays author-run and evidence-bearing.

---

## Cost & risk

**Effort:** one work package. The logic exists and is proven over 11 rounds; the
work is a port to Node, the two new requirements, and the harness's own tests.
Estimate ≈ 250 lines of tool + 150 of test.

**Blast radius:** additive. Nothing existing calls it; no gate changes until the
Definition-of-Done sentence lands, and that sentence binds authors, not CI.

**What could regress:**

- **A checked-in spec rots.** An anchor stops matching after a refactor and the
  round reports `INVALID` on a package that is fine. That is the intended
  behaviour and it is still friction — mitigated by keeping specs beside their
  tests, where the person moving the code sees them.
- **`scripts/` grows a tool with no production caller.** The seam rule
  (GYM-006) walks `src/**` only, so this is legal, but `check-invariants.cjs`
  covers `scripts/` too and the tool needs its own tests to be honest — which is
  why `test/scripts/mutate.test.ts` is in the proposal and not an afterthought.
- **A tool implies a score.** The worst outcome is a table of numbers replacing
  the triage. Requirement 9 exists specifically to make a survivor stop the round
  rather than decorate it, and the Definition-of-Done sentence asks for *a
  certified control*, never for a percentage.

---

## Success metric

Measurable within two weeks of landing (by **2026-09-24**), all three:

1. **Zero rounds run from a scratch script.** Every round in the next milestone
   is `node scripts/mutate.cjs test/mutation/<package>.json`, and every
   implementation doc's round block cites that spec path.
2. **The harness's own tests catch the three bugs the scratch scripts had** — a
   spec with no control, an anchor matching zero times, and a suite that refuses
   to start — each as a named failing case in `test/scripts/mutate.test.ts`,
   green before the tool is used on anything.
3. **At least one round reports `INVALID` or a survivor and stops**, rather than
   a table of kills. If ten rounds in a row report a perfect score with nothing
   refused, requirement 8 is not wired and the metric has **failed**, whatever
   the tests say. This is the same standard the control itself sets: *an unearned
   kill and an unearned survival are the same error.*

---

## Rollback

Delete `scripts/mutate.cjs`, `test/scripts/mutate.test.ts` and
`test/mutation/`; revert the two documentation sentences. Nothing else imports
them, no gate depends on them, and rounds go back to being written by hand —
which is the current state, so the rollback is exactly a return to today.

---

## Related

- `docs/DECISIONS-LOG.md` 2026-09-09 — the three unearned M8b rounds and the
  seven requirements
- [`GYM-006`](./GYM-006-coverage-floors-and-the-seam-rule.md) — the precedent for
  a checked-in gate that encodes a lesson rather than remembering it
- [`docs/TEST-STRATEGY.md`](../../TEST-STRATEGY.md) — where the round's definition
  is owed
- [`docs/adr/ADR-0015-gymnasium-self-improvement.md`](../../adr/ADR-0015-gymnasium-self-improvement.md)
  — the loop this proposal is filed under
