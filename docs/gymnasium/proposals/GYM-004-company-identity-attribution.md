# GYM-004 — Amend the attribution standard for the company's own GitHub identity

**Status:** landed · **Proposed:** 2026-08-28 · **Decided:** 2026-08-28 (Architect
directive, recorded in ADR-0020 — filed here because ENGINEERING-STANDARDS §3
makes every process/standards change a ledger row, whoever orders it)

## Evidence
- The Architect's 2026-08-28 directive: package self-improvement as a mission
  profile whose changes arrive as pull requests, and "give them a GitHub account
  so they can co-author themselves."
- ENGINEERING-STANDARDS §2 as written made that impossible: "the Architect is
  the git author and committer of every commit", with `Agent:` trailers naming
  no account — a build-phase rule meeting a run-phase requirement.

## Proposal
The §2 attribution clause gains the run-phase exception specified normatively in
ADR-0020: on `agent/*` branches the running company authors commits as the
single Architect-owned machine account with per-agent co-author trailers; the
account never authors on `main` except through an Architect-merged PR; the
no-Claude/Anthropic-identity rule is unchanged and applies to the company
identity too. `scripts/check-attribution.cjs` gains exactly this carve-out when
FR-10.5 lands (M7); until then the original rule remains the enforced one.

## Cost & risk
Docs-only today; the enforcement change is one guarded branch in an existing
script, owed to M7. Risk: the carve-out drifts wider than specified — bounded
by S-RECURSE, which asserts company authorship is legal *only* on `agent/*`
branches and that no Architect or vendor identity appears in company commits.

## Success metric
Binary, standing: the CI attribution job stays green over the whole history
(checked with the 2026-09-11 metric sweep), and when FR-10.5 lands, S-RECURSE's
attribution assertions are green in the same run that introduces the carve-out
— the amendment and its enforcement land together or not at all.

## Rollback
Revert the §2 amendment (the original clause is preserved verbatim above it in
history); ADR-0020 would be superseded, not edited. No enforcement code exists
yet to revert.
