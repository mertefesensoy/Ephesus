---
name: goal
description: Drive the current milestone's goal run end-to-end — resolve the milestone from docs/PROGRESS.md (M3 as of this writing), enforce the Architect's sole git authorship and a properly named feature branch before any commit, then loop the /build-package cycle through the milestone's packages and close with /milestone-review. Use when asked to run the milestone, start "the M<x> run", or invoked as /goal.
---

# Run the current milestone goal

You are executing a full milestone run, not a single package. The contract for
every step is `BUILD-PROMPT.md`; this skill only adds the run's session
mechanics (identity, branching, sequencing). Where they seem to disagree,
BUILD-PROMPT wins.

## 0. Session preconditions — before reading anything else

1. **Sole authorship.** Every commit in this repository is authored by the
   Architect and nobody else:

   ```bash
   git config user.name "MERT EFE ŞENSOY"
   git config user.email "sensoymertefe@gmail.com"
   ```

   Never add `Co-Authored-By`, session, or any identity-bearing trailer; never
   put a model identifier in a commit message, file, or PR body. This is
   enforced three ways (ENGINEERING-STANDARDS §2): `.githooks/` refuse the
   commit, CI's attribution job scans the whole history, and you verify
   yourself — run `node scripts/check-attribution.cjs` now and after every
   push. If hooks are unarmed (fresh clone that skipped `npm install`), run
   `node scripts/arm-hooks.cjs`.

2. **Green baseline.** `npm ci` (or confirm node_modules is current), then
   `npm run typecheck && npm run lint && node scripts/check-invariants.cjs`
   must pass before you write a line. A red baseline is a blocker to report,
   not to absorb.

## 1. Resolve the milestone

Open `docs/PROGRESS.md`; the current milestone is the first one with unchecked
packages (BUILD-PROMPT's build-state block names it — **M3, resuming at
M3.1**, as of 2026-08-27). Read the milestone's package plan there in full,
including the Architect-verdict and carried-items paragraphs at its head:
those decisions are already made — do not re-litigate them.

## 2. Branch policy — one package, one branch

- Cut each work package's branch from up-to-date `main`, named
  `feature/m<x>-<n>-<slug>` after the package it carries
  (e.g. `feature/m3-1-secret-broker`, `feature/m3-6-floor-layout-v2`).
  Bug-fix-only branches use `fix/<topic>`.
- Never commit directly to `main`; never reuse a branch whose work has merged;
  never rewrite history on a pushed branch.
- One package per branch. Push with `git push -u origin <branch>`. Do not open
  a PR unless the Architect asks; when asked, the PR carries the package's
  evidence (BUILD-PROMPT §4 PROVE).
- Merging to `main` is the Architect's call per package unless they have given
  a standing instruction for the run.

## 3. Execute the packages, in order

For each unchecked package, run the `/build-package` loop
(READ → PLAN → BUILD → TEST → PROVE → COMMIT → REPORT) on that package's
branch. Hard rules, restated because milestone runs tempt shortcuts:

- `npm run typecheck && npm run lint && node scripts/check-invariants.cjs &&
  npm test` green before every commit. Never proceed on red; never weaken a
  test to pass it.
- The package's owed tests (its *Tests:* line in PROGRESS.md) are part of the
  package, not a follow-up.
- Tick the package in `docs/PROGRESS.md` with a one-line evidence note in the
  same commit series; log minor choices in `docs/DECISIONS-LOG.md`.
- A must-ask (BUILD-PROMPT §8) stops the package: write the question with
  options + recommendation into the session report and move to the next
  independent package if one exists.
- 3 genuinely different failed attempts on a blocker → stop, record, report.

## 4. Close the milestone

When every package is ticked, run `/milestone-review`: exit criteria verified
*by execution* (for M3: the UC-02 and UC-08 demos; S-GATE, S-BREAKER,
S-LEDGER, S-SECRETS green), PROGRESS verdict recorded, docs re-synced
(`/doc-sync` if drift is suspected). A milestone with a red or unverified
exit criterion is not closed.

## 5. End of every session

Finish with the BUILD-PROMPT §9 session report, and re-run
`node scripts/check-attribution.cjs` — the run is not clean until it says so.
