# GYM-003 — Closing Time: an orderly quit that parks WIP and writes memory first

**Status:** proposed · **Proposed:** 2026-08-28 · **Gate class:** tooling/code →
Architect approval (extends SDD §10's recovery table with an orderly-quit row;
touches no invariant, ADR, gate rule, secret, or dependency)

## Evidence

- **[RB-001](../../stoa/briefs/RB-001-munder-difflin-orchestration-autonomy.md)
  finding 1, applicability 1** (source pinned at `b91a49f`): upstream's
  `closingTime.ts:1–25` — on quit, the orchestrator broadcasts closing time;
  every worker parks WIP, **appends state + next steps to its `memory.md`**, and
  ACKs; a completion message triggers teardown. The module rides existing rails
  and "never types into terminals".
- **Our quit discards working memory by design today:** graceful close unwinds
  spawns and restores settings (PROGRESS M1.4b evidence) but nothing asks agents
  to write down where they were first. SDD §10 covers *crash* recovery; M4's
  respawn-with-memory re-injects whatever `memory.md` holds — which, for an
  agent killed at quit, is missing exactly its last session's state. The M4
  S-CRASH work proved the value of what survives; this closes the gap in what
  gets *written*.

## Proposal

One work package on existing rails:

1. A **closing-time option in the quit path**: instead of immediate teardown, the
   harness broadcasts a Hermes `request` (subject constant, body rendered from
   `prompts/hermes/closing-time.md` — invariant §8) to every live agent: commit
   or park WIP in your worktree, append current state + next steps to your
   `memory.md`, reply with the ACK subject. Delivery, wake, and Stop-hook
   draining are the existing machinery — the module injects mail and watches
   routed traffic, exactly the upstream shape; it never types into PTYs.
2. The harness (not Artemis — she may be among the workers being closed) watches
   ACKs with a **hard deadline** (configurable, default ~90 s): all ACKs in →
   normal teardown; deadline hit → remaining agents are killed the current way
   and the shortfall is logged per agent (`kind: shutdown`, visible in the
   Activity feed — invariant §7, no silent degradation).
3. Immediate quit remains available (the current behavior, one click) — closing
   time is offered, never forced; a second click skips the wait.
4. Tests: a scenario with fake engines — all-ACK path (every agent's `memory.md`
   grew a parked-state section before teardown), non-ACK path (deadline kill +
   logged shortfall), and idempotency (a second closing-time request while one
   is in flight is refused). Exit evidence: one live quit with a real agent whose
   `memory.md` visibly gained the section.
5. Docs in the same package: SDD §10 gains the orderly-quit row; SDD §2 notes
   nothing (no new files — mail and memory are existing formats).

## Cost & risk

≤ 1 work package. Blast radius: the shutdown path in `index.ts` (SDD §1.1 gives
it shutdown ownership) — the risk is a hung quit, bounded by the deadline in (2);
Electron's `will-quit` sequencing is the fiddly part and gets its own test. An
agent may ACK without actually writing memory (engine judgment, not mechanism) —
acceptable: the mechanism guarantees the *opportunity* and the audit trail, the
E-eval layer judges quality. No new dependency, no schema change.

## Success metric

Binary, measurable the day it lands and stable for 2 weeks: **the closing-time
scenario is green in CI** (all-ACK, deadline, idempotency cases), and one
recorded live quit shows a real agent's `memory.md` appended with parked state
before teardown, with the full exchange visible in `log.jsonl`. Zero regressions
in the existing shutdown behaviors (settings restore, spawn unwind — the M1.4b
guarantees) across the two weeks.

## Rollback

Remove the closing-time branch from the quit path (immediate quit is the code
that remains), delete the prompt file and scenario. Memory already appended by
agents during the feature's life is data, not configuration — it stays.
