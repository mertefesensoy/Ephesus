# GYM-005 — Fix the ADR append-only CI check: allow additions, stop masking errors

**Status:** landed · **Proposed:** 2026-08-28 · **Decided:** 2026-08-28 (Architect:
"let's fix the CI first then merge" — PR #1)

## Evidence
- The check's first real exercise — PR #1, the first PR ever to *add* ADRs —
  false-positived: `git diff … -- 'docs/adr/ADR-*.md'` lists **added** files, so
  the four new ADRs (0017–0020) failed a rule that exists to forbid *editing*
  accepted ones. Flagged when the check was first read on 2026-08-28 and
  restated in PR #1's description.
- Reading the step exposed a second defect: `|| true` on the diff plus
  depth-1 fetches means a git error (e.g. no findable merge base in a shallow
  clone) yields an empty `changed` and a silent PASS — the check could fail
  open on exactly the PRs it was written for.

## Proposal
One step in `.github/workflows/ci.yml` (docs job):
`--diff-filter=a` (additions are the one legal ADR change), diff against the
**merge base** so base-branch drift is never blamed on the PR, `fetch-depth: 0`
so the merge base exists, and `set -e` with no `|| true` so a git failure fails
the check loudly.

## Cost & risk
One CI step; no product code. Risk: the check goes vacuous — refuted by a live
probe before landing: a scratch commit editing ADR-0015 was flagged by the new
logic, and the branch's four added ADRs were not (both runs recorded in the
session evidence).

## Success metric
Binary, immediate: PR #1's docs job goes **green** with four added ADRs in its
diff, on the same run that carries this fix; and the probe evidence shows the
check still bites on a modified ADR. Standing: no false-positive on any later
ADR-adding PR through the 2026-09-11 metric sweep.

## Rollback
Revert the step to its previous body (preserved in git history).
