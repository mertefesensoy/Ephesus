# ADR-0013 — Autonomy loop via the engine's Stop hook

**Status:** accepted · **Date:** 2026-08-26

## Context
An agent CLI naturally stops at the end of each turn and waits for a human. For the
company to run unattended, a finished agent must check for new work (its inbox, its
ledger assignments) and continue — without the harness re-prompting it blindly, and
without ever spinning forever.

## Decision
Use the engine's **Stop hook** as the autonomy hinge (Claude Code reference semantics;
other engines map via their adapter):

1. Agent finishes a turn → Stop hook fires → shim POSTs to the harness socket.
2. The harness checks the agent's inbox and ledger state.
3. Unread mail or an assigned-but-unfinished task → hook reply
   `{"decision":"block","reason":<the mail / the nudge>}` — the engine treats the reason
   as new input and the agent keeps working.
4. Nothing pending → the turn ends normally; the avatar goes `idle`.

Guards, all mandatory:
- Respect `stop_hook_active` (never re-block a turn the hook itself continued) plus a
  hard per-session block cap (env-configurable) as the backstop.
- Idempotent inbox consumption via the cursor (ADR-0003) so a wake never re-delivers.
- An **inbox wake watchdog** covers the complementary failure: mail arriving while the
  agent is already idle (no Stop event will come) → the watchdog nudges the session.
  Stale nudges are suppressed; mail to a dead agent bounces (FR-3.4/3.5).
- The circuit breaker (ADR-0011) watches the loop from outside; a pathological
  block-continue cycle trips rung 1.

## Options considered
- **Harness re-prompts idle agents on a timer.** Wakes agents with nothing to do (burns
  budget), and races with the human typing; the Stop hook is edge-triggered exactly
  when the agent is ready.
- **A supervisor process per agent driving via the engine API.** Reimplements the
  runtime (violates ADR-0009).
- **Agents poll their own inbox in-prompt ("check your mail every turn").** Convention,
  not mechanism — fails silently when context gets tight (same argument as ADR-0008).

## Consequences
- Autonomy fidelity is graded per engine like hooks are (native Stop hook > wrapper >
  watchdog-only); the agent card shows it.
- The block-reason string is a real prompt surface — its template lives in versioned
  config and is subject to the same review as system prompts.

## Prior art
Munder Difflin HIVE.md §2.5 & Phase 1 (Stop-hook drain, `stop_hook_active`, block cap,
inbox wake watchdog added in 0.4.5 after mail sat unread in idle inboxes).
