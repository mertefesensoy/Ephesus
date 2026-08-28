# GYM-001 — Stand up the Stoa build-phase mirror (`docs/stoa/` + `/research`)

**Status:** landed · **Proposed:** 2026-08-28 · **Decided:** 2026-08-28 (Architect
directive, recorded in ADR-0017 — the Architect ordered this change directly, so the
verdict and the directive are the same act; filed here so the ledger stays total,
ADR-0015 R2)

## Evidence
- The Gymnasium's evidence base was internal-only by construction (FR-12.1 before
  this change): the company had no governed way to learn from external harnesses.
  The Architect's directive of 2026-08-28 names the gap and three sources to study
  (hermes-agent, munder-difflin, opencode).
- The ledger itself was empty at M4 close — the loop existed with nothing flowing
  through it; the proof gate (SRS §6.9) needs real cycles to ever be met.

## Proposal
The build-phase mirror of ADR-0017: `docs/stoa/WATCHLIST.md` seeded with the three
Architect-named sources, `docs/stoa/briefs/` with the brief template, and the
`/research` skill running the cycle under the four Stoa hard rules. Product-side
design landed in the same directive: ADR-0017/0018, SRS FR-13/FR-14 + UC-14/15 +
§6.8/§6.9 + NFR-17, SDD §4.7/§7.7, S-STOA/S-MODE/E-STOA, milestone M5b.

## Cost & risk
One documentation package (no code); ongoing cost is research-session time inside
the Gymnasium slice. Risks R12 (injection) and R13 (license) are registered in
IMPLEMENTATION with their mitigations; the mirror itself is inert until used.

## Success metric
Within 4 weeks of landing (by **2026-09-25**): ≥ 1 research brief filed from the
watchlist whose candidates yield ≥ 1 Architect-approved GYM proposal. Zero
instances of a brief finding entering the repo without a citation or outside a
gated proposal.

## Rollback
Remove `docs/stoa/` and `.claude/skills/research/`, revert the AUTOMATION/CLAUDE
rows and the SRS/SDD/TEST-STRATEGY/IMPLEMENTATION sections added for FR-13/FR-14.
ADR-0017/0018 are append-only and would be *superseded*, not deleted.
