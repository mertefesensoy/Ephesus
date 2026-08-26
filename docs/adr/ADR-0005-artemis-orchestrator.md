# ADR-0005 — Artemis: an LLM agent as orchestrator, prompt as control surface

**Status:** accepted · **Date:** 2026-08-26

## Context
Someone must decompose the Architect's intent, route work by capability, adjudicate
inter-agent requests, decide what escalates, chair meetings, and compile briefings.
This requires judgment, not just rules — but it must remain controllable and auditable.

## Decision
Artemis is an **ordinary engine process** (a `claude` session like any worker) holding a
privileged *role*, not privileged *code*: the harness main process is the mechanism
(routing, git, sockets, gates); Artemis is the intelligence. Specifics:

- **Prompt as policy.** Artemis's escalation policy (what counts as critical), delegated
  authority levels (which memo classes it may decide itself), briefing style, and
  meeting-chair behavior live in its system prompt + config files, editable from the UI.
  Tuning the company means editing text, not shipping code.
- **Reserved seat, supervised lifecycle.** Auto-spawns at startup into the Temple seat,
  flagged `isOrchestrator` in the registry; the harness respawns it on crash with its
  memory intact (FR-5.4).
- **Countersignature rule.** Anything Artemis decides under delegated authority is
  recorded with its countersignature in the memo/gate archive — the Architect can always
  audit what was decided *for* them (FR-5.5).
- **Proxy for the human.** Hermes routes `to:"human"` to Artemis; only items matching
  the critical policy continue to the Architect (native permission prompts + approvals
  UI + remote push). Routine clarifications never reach the human — that is the
  autonomy guarantee.

## Options considered
- **Hardcoded rules-engine orchestrator.** Deterministic but brittle; cannot answer a
  clarification or write a task spec. The recurring lesson upstream: the mechanism/
  intelligence split is what keeps both sides simple.
- **Every agent self-organizing (no orchestrator).** Democratic and unaccountable;
  livelock-prone; nobody compiles the standup.
- **The harness calls a model API directly for orchestration decisions.** Cheaper per
  decision, but creates a second agent runtime to maintain (contradicts ADR-0009) and
  loses the "you can open Artemis's terminal and read its reasoning" property.

## Consequences
- Orchestration quality tracks the underlying model and prompt; the org layer's review
  loop (UC-12) treats Artemis itself as reviewable.
- Artemis is a bottleneck by design (single scribe, single adjudicator); at larger
  scales a "department head" middle tier is the anticipated evolution (recorded for a
  future ADR, out of v1 scope).

## Prior art
Munder Difflin's GOD agent (HIVE.md §6); LangGraph supervisor pattern; Anthropic's
lead/subagent research-system writeup.
