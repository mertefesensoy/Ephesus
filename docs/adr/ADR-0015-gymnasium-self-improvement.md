# ADR-0015 — The Gymnasium: self-improvement as the company's primary standing mission, governed

**Status:** accepted · **Date:** 2026-08-26

## Context
The Architect's directive elevates a new goal above the mission profiles: **the company's
primary standing goal is to improve itself** — its playbooks, prompts, tooling, docs,
tests, and eventually its own code. An ungoverned version of this is the classic failure
mode of autonomous systems: agents "improving" themselves into unreviewable drift,
gamed metrics, or safety regressions. The company already has the machinery to govern
change (Odeon memos, Watch gates, org metrics, versioned profiles); self-improvement
must run *through* that machinery, not beside it.

This mission also predates the running system: the *build phase* is the company
improving itself in embryo, so the loop must exist in the repository now
(`/improve` skill, `docs/gymnasium/`) and carry forward into the product unchanged in
shape.

## Decision
**The Gymnasium** — where the city trains itself — is a first-class subsystem defined
by one loop and three hard rules.

**The loop:** `observe → propose → gate → land → measure → keep-or-rollback`, always in
that order, always recorded:

1. **Observe.** Improvement candidates come only from records: org metrics, breaker
   trips, memo-rejection patterns, budget burn, `log.jsonl`, drift audits, retro
   reports — and during the build phase, PROGRESS/DECISIONS-LOG friction. No
   evidence, no proposal.
2. **Propose.** One scoped change per proposal, written to
   `docs/gymnasium/proposals/GYM-<NNN>-*.md` (later: filed by agents through the same
   template as an Odeon memo subtype `trigger:"self-improvement"`), carrying a
   **measurable success metric** and a **rollback**. A proposal without a falsifiable
   metric is invalid by construction.
3. **Gate.** Authority table (stricter always wins):
   - Playbooks, prompts, docs, tooling, tests → Architect approval; Artemis may
     *pre-screen and rank*, never approve.
   - Hire templates / role changes → the existing org-review path (UC-12).
   - Anything touching invariants, ADRs, gates, secrets, dependencies, or the
     Gymnasium's own rules → Architect approval + full decision memo. **The Gymnasium
     may never widen its own authority.**
4. **Land** via the normal build discipline (packages, tests, evidence, CI).
5. **Measure** the declared metric within its declared window; record `validated` or
   `regressed` in `docs/gymnasium/LEDGER.md`; regressions roll back per the proposal.

**The three hard rules:**
- **R1 — Nothing self-approves.** No agent, Artemis included, approves an improvement
  it proposed; the Architect is the approval authority for every Gymnasium class.
- **R2 — The ledger is total.** Every proposal, rejection, and measured outcome is a
  permanent ledger row; rejected and regressed entries are retained as training data
  for future proposals.
- **R3 — Improvement work is budgeted, not ambient.** Gymnasium work runs inside an
  explicit budget slice (time/tokens per week) so self-improvement can never starve
  the missions that pay for it; the standup brief reports the slice's spend.

## Options considered
- **Unbounded self-modification** (agents edit their own prompts/playbooks freely).
  Fastest learning, and exactly the drift/metric-gaming failure mode; unauditable.
  Rejected outright.
- **Improvement as an occasional human chore** (Architect files everything). The
  status quo the product inverts; wastes the richest data source — the company's own
  operating records.
- **A separate "meta-agent" with its own machinery.** Duplicates memos/gates/ledger;
  a second governance system is a second place for governance to fail. The Gymnasium
  deliberately reuses Odeon + Watch + org primitives.
- **Metrics-only automation** (auto-land when metrics improve). Metrics get gamed;
  Goodhart's law is not optional. Human gate stays.

## Consequences
- Self-improvement is auditable end-to-end: the ledger + memo archive reconstruct why
  the company works the way it does (extends NFR-13 to the company's own evolution).
- The loop costs friction by design — one proposal at a time, metric required,
  Architect in the loop. The intended effect: fewer, better improvements that
  compound; the metric on the Gymnasium itself is its validated-vs-regressed ratio.
- The build phase and the run phase share one improvement grammar, so nothing is
  thrown away at launch: `docs/gymnasium/` becomes the seed of the live system's
  improvement archive, and `/improve` becomes an Artemis-facing playbook.
- SRS gains UC-13 and FR-12; SDD gains the Gymnasium component; TEST-STRATEGY gains
  the E-GYM eval; IMPLEMENTATION threads the loop from M3 (dogfood start) onward.

## Prior art
The Odeon's enforced-accountability argument (ADR-0008) — this ADR is its recursive
application; org review loop (SRS UC-12); Goodhart's law as the standing warning;
kaizen/retrospective practice for the evidence-first, one-change-at-a-time discipline.
