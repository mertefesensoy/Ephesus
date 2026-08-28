# 2026-08-28 — Recursive Improvement profile + company GitHub identity (design package)

## Problem / Motivation

The Stoa's first full cycle (RB-001 → GYM-002/003, approved and landed) proved
the research-to-improvement loop works. The Architect's directive: package it as
a **third mission profile** — the company continuously studies repositories the
Architect presents by URL in the app, improves itself from what the Stoa reports
and Artemis ranks, and delivers every change as a **pull request the Architect
approves** — and give the company a **GitHub account so agents co-author
themselves**. Documentation-only package; the build lands with M7 (profiles +
Harbor), on M5b's Stoa/modes foundations.

## What Changed

| File | Change |
|---|---|
| `docs/adr/ADR-0019-recursive-improvement-profile.md` | **New.** The profile: mode-gated activation, researcher/improver roles, the reading desk (watchlist by URL), PR-only delivery, Architect-only merge, gym budget slice. |
| `docs/adr/ADR-0020-company-github-identity.md` | **New.** One machine account, broker-held fine-grained PAT, per-agent co-author trailers, write-not-admin, host-enforced merge authority, the attribution carve-out spec. |
| `docs/adr/README.md` | Index rows. |
| `docs/srs/SRS.md` | Scope: three profiles; "Company identity" definition; UC-16 (delivery flow); FR-9.5 (the profile); FR-10.5 (the identity); acceptance §6.10 (the recursive test). |
| `docs/sdd/SDD.md` | §7.8 delivery sequence; §9 mode-gate + token-grant note. |
| `docs/TEST-STRATEGY.md` | S-RECURSE. |
| `docs/IMPLEMENTATION.md` | M7 builds three profiles (recursive one named with its dependencies and the attribution carve-out); M7 exit gains §6.10 + S-RECURSE; risks R15 (PR flood / rubber-stamping) and R16 (credential misuse). |
| `docs/ENGINEERING-STANDARDS.md` | §2 attribution clause amended with the ADR-0020 run-phase exception (original rule enforced until FR-10.5 lands). |
| `README.md` | Three configurations in "what makes it different". |
| `docs/gymnasium/GYM-004` + `LEDGER.md` | The standards change ledgered (§3's rule), landed by directive, metric due 2026-09-11. |

## Implementation Approach

Composition over invention: every mechanism the profile needs already exists —
watchlist/briefs (ADR-0017), gated proposals (ADR-0015), modes + proof gate
(ADR-0018), worktrees, agent branches, `gh`. The profile is the ADR-0012 bundle
that arms them with roles, cadences, and PR wiring. Two authorities are made
host-enforced rather than convention-enforced: activation requires mode
`improving` (so the §6.9 proof gate guards the mission too), and merge requires
the Architect's GitHub identity (the machine account holds write, `main` stays
PR-and-review protected — an agent *cannot* merge even if it tries).

## Mathematical / Statistical Details

None — governance and packaging. The only new quantities are R15's health
metrics (PR throughput, time-in-review) computed from existing records.

## Design Decisions

- **Artemis ranks, the Architect approves and merges** — the directive's
  "Artemis approved" is honored as ADR-0015 pre-screening; verdicts and merges
  stay with the Architect, matching both R1 and the directive's "want my
  approval on the requests".
- **One machine account, not per-agent accounts** — "co-author themselves" is
  delivered by per-agent co-author trailers; N accounts add management burden
  and GitHub-ToS friction without adding review signal (ADR-0020 options).
- **Separate ADRs for mission and identity** — revoking a credential must never
  require redesigning a mission.
- **Standards amendment ledgered as GYM-004** — ENGINEERING-STANDARDS §3 makes
  process changes ledger rows regardless of who orders them; the enforcement
  carve-out ships only together with S-RECURSE (amendment and teeth land as one).

## Verification

- Docs-only: relative-link check green (the CI docs job re-verifies); no
  existing ADR modified (0019/0020 are new files); requirements stated once
  (FR-9.5/FR-10.5) and referenced everywhere else.
- When M7 builds it: S-RECURSE per TEST-STRATEGY §3, and the recursive test
  (SRS §6.10) as the live exit demo.

## Related Docs

[ADR-0019](../adr/ADR-0019-recursive-improvement-profile.md) ·
[ADR-0020](../adr/ADR-0020-company-github-identity.md) ·
[SRS](../srs/SRS.md) FR-9.5, FR-10.5, UC-16, §6.10 · [SDD](../sdd/SDD.md) §7.8, §9 ·
[GYM-004](../gymnasium/proposals/GYM-004-company-identity-attribution.md) ·
[RB-001](../stoa/briefs/RB-001-munder-difflin-orchestration-autonomy.md)
