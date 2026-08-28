# ADR-0019 — Recursive Improvement: the self-improvement mission as a third built-in profile

**Status:** accepted · **Date:** 2026-08-28

## Context
The Stoa has now run end to end: a watchlist source studied at a pin, a
provenance-cited brief (RB-001), two Architect-approved proposals, both landed
with named tests — the loop the Architect commissioned works. The Architect's
directive (2026-08-28): package it as a **mission**. Skeleton Crew keeps the
Architect's apps alive and Front Office runs a project's outward face
(ADR-0012); the company's *primary standing mission* — improving itself
(ADR-0015) — deserves the same first-class packaging: roles, triggers,
playbooks, Harbor wiring, budgets, in one activatable, inspectable bundle. The
directive also names the delivery shape: the Architect presents repositories to
study **by URL, in the app**; the company works from what the Stoa reports and
Artemis ranks; finished changes arrive as **pull requests the Architect
approves and merges**.

Everything this profile needs already exists by design: the watchlist and
briefs (ADR-0017), the gated proposal loop (ADR-0015), company modes and the
proof gate (ADR-0018), worktree isolation (UC-01 2a), agent branch/PR
conventions (ENGINEERING-STANDARDS §2, §7), and GitHub via `gh` (FR-10.1).
The decision is composition, not new machinery.

## Decision
**Recursive Improvement** ships as the third built-in mission profile
(FR-9.5), a declarative ADR-0012 bundle whose target repository is, by
default, the company's own.

- **Activation is mode-gated.** The profile activates only in company mode
  `improving` (ADR-0018) — it *is* that mode's mission packaging, so the proof
  gate that guards the mode guards the profile. Activation in `directed` is
  refused with the missing evidence listed; reverting the mode deactivates the
  profile's triggers with it.
- **Roles.** A researcher (the Stoa's reader), one or more improvers (take
  approved proposals to code in their own worktrees), and Artemis's standing
  duties (rank briefs' candidates, file/assign proposals, pre-screen — never
  verdict). Hire templates are part of the bundle, versioned like any other.
- **The reading desk.** The Architect feeds the profile by presenting
  repository URLs in the app's Stoa panel — which registers them on the
  watchlist with tags. Registration authority is unchanged (FR-13.1:
  Architect-only; agents may propose, never register). The profile does not
  widen the Stoa's rules; it gives them a cadence and a crew.
- **Delivery is a pull request, and merge authority is the Architect's
  alone.** An approved proposal is implemented on an `agent/<name>/<topic>`
  branch in the improver's worktree and opened as a PR under the company's
  GitHub identity (ADR-0020), carrying evidence (ENGINEERING-STANDARDS §2) and
  citing its GYM proposal and RB brief ids — the provenance chain from
  watchlist to diff, clickable. Agents never push `main`, never merge, and no
  auto-merge path exists in the profile. A rejected PR is revised on the same
  branch (ENGINEERING-STANDARDS §7).
- **Budgeted like everything Gymnasium.** The profile runs inside the
  FR-12.5 slice, reported in the standup brief; it can never starve Skeleton
  Crew or Front Office instances sharing the floor (ADR-0012 coexistence,
  stricter-wins).

## Options considered
- **Leave self-improvement as bare mode + cadences (status quo after
  ADR-0018).** Works, but the roles, playbooks, PR wiring, and budgets would
  be configured by hand per installation — exactly the ad-hoc-ness profiles
  exist to remove for the other two missions.
- **Fold it into Skeleton Crew** (the "keep apps alive" crew also improves the
  harness). Mixes two authorities: Skeleton Crew's autonomy levels are tuned
  for the Architect's *other* repos; self-modification wants the strictest
  gate posture in the fleet. Separate bundle, separate knobs.
- **Direct commits to a bot branch, no PRs.** Loses GitHub-native review — the
  one surface where the Architect's merge authority is enforced by the host,
  not just by our own gates. PRs are the belt over the harness's suspenders.
- **Auto-merge when CI is green.** Rejected for the same reason ADR-0015
  rejected metrics-only automation: green CI is a metric, and the Architect's
  merge is the human gate the whole design keeps.

## Consequences
- The company's primary standing mission becomes switch-on-able the way its
  other missions are — and switch-off-able: deactivate the profile (or revert
  the mode) and the cadences stop, with the ledger intact.
- SRS gains FR-9.5, UC-16, and acceptance §6.10; TEST-STRATEGY gains
  S-RECURSE; the SDD gains the §7.8 delivery sequence; IMPLEMENTATION's M7
  builds three built-in profiles instead of two, with the recursive one
  depending on M5b's Stoa and modes.
- The Architect takes on a real review load: every improvement is a PR on
  their desk. Mitigations are the ones already in the grammar — one scoped
  change per proposal, Artemis's ranking, the budget slice — plus the risk
  register's R15 watching PR volume as a health metric.
- The profile needs an identity to open PRs with; that decision is deliberately
  separate (ADR-0020) so revoking the credential never has to touch the
  mission's design.

## Prior art
ADR-0012 (profiles as declarative bundles; stricter-wins); ADR-0015/0017/0018
(the loop this packages); ADR-0004's spirit at the repo boundary (one merge
authority, like one committer); upstream Munder Difflin's evidence-mandatory
PR policy, already inherited by ENGINEERING-STANDARDS §2; the RB-001 →
GYM-002/003 cycle as the proven trace this profile industrializes.
