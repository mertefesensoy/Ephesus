# Gymnasium ledger — self-improvement record

The company's primary standing mission is to improve itself (ADR-0015). Every
improvement lives here from proposal to measured outcome. Rows are never deleted —
rejected and regressed entries are the training data for better proposals.

Proposal files live in `proposals/GYM-<NNN>-<slug>.md` (structure defined in
`.claude/skills/improve/SKILL.md`). Status flow:
`proposed → approved | rejected`; `approved → landed → validated | regressed`
(`regressed` ⇒ rolled back per the proposal's rollback section).

| ID | Title | Status | Success metric | Proposed | Decided | Measured | Outcome |
|---|---|---|---|---|---|---|---|
| [GYM-001](./proposals/GYM-001-stoa-build-phase-mirror.md) | Stand up the Stoa build-phase mirror (`docs/stoa/` + `/research`) | landed | ≥ 1 watchlist brief yielding ≥ 1 Architect-approved proposal by 2026-09-25 | 2026-08-28 | 2026-08-28 (Architect directive, ADR-0017) | due 2026-09-25 | — |
| [GYM-002](./proposals/GYM-002-hook-boundary-steer.md) | Deliver rung-1 steer over the hook boundary, not the command queue | landed | S-BREAKER mid-turn steer case green in CI (steer reaches the engine within one hook boundary; pre-fix hold captured as the failing case); zero S-suite regressions for 2 weeks | 2026-08-28 | 2026-08-28 (Architect) | due 2026-09-11 | |
| [GYM-003](./proposals/GYM-003-closing-time-shutdown.md) | Closing Time: an orderly quit that parks WIP and writes memory first | landed | Closing-time scenario green in CI (all-ACK, deadline, idempotency) + one live quit with a real agent's memory.md appended pre-teardown; zero shutdown regressions for 2 weeks | 2026-08-28 | 2026-08-28 (Architect) | due 2026-09-11 (live-quit evidence owed with the metric check) | |
| [GYM-004](./proposals/GYM-004-company-identity-attribution.md) | Amend the attribution standard for the company's GitHub identity (ADR-0020) | landed | Attribution job green over full history (2026-09-11 sweep); carve-out ships only with S-RECURSE green (M7) | 2026-08-28 | 2026-08-28 (Architect directive, ADR-0020) | due 2026-09-11 | |
| [GYM-005](./proposals/GYM-005-adr-append-only-check-fix.md) | Fix the ADR append-only CI check (allow additions; fail loud) | landed | PR #1 docs job green with 4 added ADRs; probe shows a modified ADR still caught; no false-positive through 2026-09-11 | 2026-08-28 | 2026-08-28 (Architect, PR #1) | PR #1 run + probe | |
| [GYM-006](./proposals/GYM-006-coverage-floors-and-the-seam-rule.md) | Coverage floors and the seam rule: a wiring seam with no test is a defect (M8.0) | landed | A planted regression (one test file removed, one orphan module) fails the CI code job by name; zero false positives of either gate on green work; every M8 package closed in the window names its production call path or records none — by 2026-09-16 | 2026-09-02 | 2026-09-02 (Architect, four M8.0 decisions) | due 2026-09-16 | |
