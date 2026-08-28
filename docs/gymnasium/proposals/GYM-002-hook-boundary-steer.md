# GYM-002 — Deliver rung-1 steer over the hook boundary, not the command queue

**Status:** proposed · **Proposed:** 2026-08-28 · **Gate class:** tooling/code →
Architect approval (ADR-0011's decision text is mechanism-neutral — "inject a
corrective message into the agent's session" — so no ADR is touched; the Watch's
gating rules are unchanged)

## Evidence

- **[RB-001](../../stoa/briefs/RB-001-munder-difflin-orchestration-autonomy.md)
  findings 2–3, applicability 2** (source pinned at `b91a49f`): upstream delivers
  pause/steer/halt through Claude Code's own hook-return protocol
  (`control.ts:1–30`, `hooks.ts:244–290` there) — race-free, landing **mid-turn**
  at the next hook boundary.
- **Our shipped wiring holds steer during exactly the pathology it targets:**
  rung-1 steer is submitted through the command queue
  ([`src/main/index.ts:437`](../../../src/main/index.ts) —
  `steer: (agentId, text) => commandQueue.submit(agentId, text)`), and
  `decideCommand` holds text while the agent is `thinking`/`working`
  ([`src/shared/commands.ts:39–59`](../../../src/shared/commands.ts)). A runaway
  agent is mid-turn by definition, so the corrective sentence waits for the very
  turn it was meant to interrupt. ADR-0011's rung-1 bargain ("a false trip costs
  one injected sentence") silently became "…delivered after the loop's turn ends".
- The steer *decision* machinery is proven (S-BREAKER, PROGRESS M5.1 evidence);
  only the delivery channel is at issue.

## Proposal

One work package on the event plane:

1. `HookServer` gains a per-agent **pending-steer note** (set by the breaker's
   `effects.steer` for `native`-grade engines): the next hook response for that
   agent carries it once as `additionalContext` (PostToolUse / UserPromptSubmit),
   then clears it. Only one `additionalContext` can ride a hook response, so the
   note composes with any future context payloads by joined-merge (RB-001
   finding 3's constraint, honored from day one).
2. Grade-conditional: engines below `native` hook grade keep today's
   command-queue path — the same reduced-protection scaling ADR-0011 already
   applies. The active channel is visible on the agent card (invariant §7).
3. Steer text keeps coming from `prompts/watch/steer-*.md` (invariant §8);
   `steerTemplateFor` and the breaker policy are untouched.
4. Tests: S-BREAKER gains the mid-turn case — a fake engine held mid-tool trips
   rung 1 and the *hook response* is asserted to carry the steer in the same
   turn; a second case asserts the queue fallback on a `pty-heuristic` fake; a
   regression case asserts the note is delivered exactly once.
5. Docs in the same package: SDD §9 records the steer delivery channel and its
   degradation; DECISIONS-LOG notes the channel change.

Out of scope (deliberately, one change per proposal): upstream's roster/goal
"living context" refresh over the same seam (RB-001 finding 3) — a future
proposal if this one validates.

## Cost & risk

≤ 1 work package. Blast radius: the hook response path — the same path that
carries Stop-hook decisions, so the merge rule in (1) is the risk to test hardest
(a malformed merge could suppress a Stop block). No schema change to hook
payloads; no new dependency. Could regress: hook-response shape for engines with
drifted schemas — covered by the existing drift-warning path (FR-2.3).

## Success metric

Binary, measurable the day it lands and stable for 2 weeks: **the new S-BREAKER
mid-turn case is green in CI** — a rung-1 steer fired while the agent is mid-turn
reaches the engine within one hook boundary of the trip (asserted on the hook
response), and the pre-fix behavior (steer held until idle) is captured first as
the failing case so the defect is proven, not assumed. Zero S-suite regressions
across the two weeks.

## Rollback

Wiring-level: point `effects.steer` back at `commandQueue.submit` for all grades
and drop the pending-note branch from `HookServer` (the tests for the queue path
still exist). No on-disk format changes to undo.
