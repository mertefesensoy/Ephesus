---
name: improve
description: File a Gymnasium self-improvement proposal for Ephesus — scan the repo and its records for the highest-leverage improvement, write a structured proposal with measurable success criteria, and queue it for the Architect. Use when asked to find improvements, when a retro/review surfaces recurring friction, or on a scheduled improvement pass.
---

# Gymnasium improvement proposal

Self-improvement is the company's primary standing mission (ADR-0015), and it is
**governed**: improvements are proposed → approved → implemented → measured. This skill
produces the *proposal*; implementation only happens after an explicit Architect
verdict.

1. **Gather evidence.** Improvement hunts start from records, not vibes:
   - `docs/PROGRESS.md` + past session reports (recurring blockers, split packages,
     3-attempt failures);
   - `docs/DECISIONS-LOG.md` (clusters of minor decisions = a missing convention);
   - test flakiness / slowest suites; CI failures; `/doc-sync` drift history;
   - once the system runs: the Agora's `log.jsonl`, breaker trips, budget burn,
     memo rejection patterns, org metrics (SDD, Odeon artifacts).
2. **Pick ONE improvement** — the highest leverage-to-risk item. Not three. Scope it to
   ≤ 1 work package.
3. **Write the proposal** to `docs/gymnasium/proposals/GYM-<NNN>-<slug>.md` (next NNN
   from the directory; create it if missing) using exactly this structure:
   - **Evidence** — the observed friction, with refs (file, log line, report date).
   - **Proposal** — the change, concretely (files, mechanism, doc sections affected).
   - **Cost & risk** — effort, blast radius, what could regress.
   - **Success metric** — a number or binary check measurable within 2 weeks of
     landing (e.g. "median package completion needs ≤ 1 session", "zero drift findings
     in next /doc-sync"). No metric → not a valid proposal.
   - **Rollback** — how to undo it.
4. **Classify the gate** (ADR-0015 authority table): process/docs/tooling improvements
   → Architect approval; anything touching invariants (BUILD-PROMPT §3), ADRs, gates,
   secrets, or dependencies → Architect approval AND a decision memo when the system is
   live. Nothing self-approves.
5. Add a row to `docs/gymnasium/LEDGER.md` (id · title · status: proposed · metric ·
   dates), commit as `docs(gymnasium): propose GYM-<NNN> <title>`, and present the
   proposal to the Architect ending with the explicit question: approve, amend, or
   reject?
6. **On a later approval:** implement via `/build-package` discipline, flip the ledger
   row to `landed`, and schedule the metric check; when the metric is measured, record
   the result in the ledger (`validated` or `regressed` → rollback per the proposal).

Never bundle an unapproved improvement into unrelated work. Never delete a rejected
proposal — mark it `rejected` with the Architect's reason; rejections teach the next
proposal.
