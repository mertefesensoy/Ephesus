# ADR-0008 — The Odeon: accountability as an enforced subsystem, not a convention

**Status:** accepted · **Date:** 2026-08-26

## Context
The product thesis: the Architect governs a company the way a software architect governs
engineering teams — through standups, design reviews, decision records, and meetings.
If these are merely *encouraged agent behaviors* (prompt suggestions), LLM agents will
skip them under pressure exactly when they matter most. Upstream has approvals and an
activity log, but no accountability artifacts.

## Decision
Accountability is **mechanism-enforced** by the harness, with four artifact types
(FR-7), all stored immutably in the Agora and all derived from/linked to ledger + log
data:

1. **Briefings** — compiled by Artemis *only* from Agora data (ledger, log, budgets,
   Harbor queue). The briefing template forbids claims without a source ref; the
   compiler attaches refs so every spoken sentence is traceable (acceptance test §6.2).
2. **Slide reviews** — a ledger task flagged `review:deck` is *mechanically unclosable*
   until a deck artifact exists (the harness rejects the `done` transition). Decks are
   single-file HTML from a standard template; evidence (diffs, screenshots, test
   output) is embedded, not linked to mutable state.
3. **Decision memos** — policy triggers (new dependency, public API/schema change,
   security posture, spend) are enforced at the gate layer: the matching action is held
   until a memo exists and is verdict-ed. Flow: agent files memo → Artemis triages
   (delegated classes: decide + countersign; else queue for Architect) → verdict returns
   as a Hermes message → memo archives immutably. A rejected memo reverses the change.
4. **Meetings** — Artemis chairs: turn order enforced by the meeting driver (attendees
   receive the floor via Hermes `query`, one at a time), minutes + action items written
   to blackboard + ledger on close. Attendee avatars gather in the Odeon room — the
   meeting is *watchable*.

## Options considered
- **Prompt-only convention** ("please write a memo when…"). Fails silently; unauditable;
  rejected as the core of the thesis.
- **Human-side-only tooling** (Architect writes the ADRs). That's the status quo this
  product exists to invert.
- **Heavyweight workflow engine** (BPMN-ish states). The four artifacts need exactly
  three mechanical hooks — task-close gate, action gate, meeting turn-taking — a
  workflow engine is ceremony beyond that.

## Consequences
- The Odeon depends on the Agora being the single source of truth (ADR-0004) — that
  dependency is deliberate and load-bearing.
- Enforcement adds friction to agents; memo policy granularity is the tuning knob and
  lives in profile config (too broad = agents drown in paperwork; the org review loop
  UC-12 watches memo volume as a health metric).
- Artifacts are the training substrate for future improvements: rejected memos and
  review comments are exactly the feedback that hire-template revisions feed on.
