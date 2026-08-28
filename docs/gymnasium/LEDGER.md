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
| [GYM-001](./proposals/GYM-001-stoa-build-phase-mirror.md) | Stand up the Stoa build-phase mirror (`docs/stoa/` + `/research`) | landed | ≥ 1 watchlist brief yielding ≥ 1 Architect-approved proposal by 2026-09-25 | 2026-08-28 | 2026-08-28 (Architect directive, ADR-0017) | — | — |
| [GYM-002](./proposals/GYM-002-hook-boundary-steer.md) | Deliver rung-1 steer over the hook boundary, not the command queue | approved | S-BREAKER mid-turn steer case green in CI (steer reaches the engine within one hook boundary; pre-fix hold captured as the failing case); zero S-suite regressions for 2 weeks | 2026-08-28 | 2026-08-28 (Architect) | | |
| [GYM-003](./proposals/GYM-003-closing-time-shutdown.md) | Closing Time: an orderly quit that parks WIP and writes memory first | approved | Closing-time scenario green in CI (all-ACK, deadline, idempotency) + one live quit with a real agent's memory.md appended pre-teardown; zero shutdown regressions for 2 weeks | 2026-08-28 | 2026-08-28 (Architect) | | |
