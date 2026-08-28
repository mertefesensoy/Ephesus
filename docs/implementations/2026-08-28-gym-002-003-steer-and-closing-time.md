# 2026-08-28 — GYM-002 + GYM-003: hook-boundary steer and closing time

## Problem / Motivation

The Stoa's first research brief ([RB-001](../stoa/briefs/RB-001-munder-difflin-orchestration-autonomy.md))
surfaced two evidence-backed gaps, both Architect-approved as Gymnasium proposals:

- **GYM-002.** Breaker rung 1's corrective sentence rode `commandQueue.submit`,
  and `decideCommand` holds mid-turn text — so a looping agent (mid-turn by
  definition) heard its correction only after the looping turn ended. ADR-0011's
  "one injected sentence" bargain had silently become "…delivered late".
- **GYM-003.** Graceful quit restored settings and unwound spawns but never let
  agents park WIP or write `memory.md` first, so M4's respawn-with-memory
  re-injected a file missing exactly its last session.

## What Changed

| File | Change |
|---|---|
| `src/main/watch/steer-notes.ts` | **New.** `SteerNotes`: grade-conditional steer channel — `native` holds one note per agent, answered exactly once on the next `post-tool` hook reply as `{decision:'block', reason}`; lower grades keep the queue path. Latest-wins; `session-start` clears stale notes. |
| `src/main/index.ts` | `SteerNotes` wired (breaker `effects.steer`, hook `onEvent` answer, `steer-channel` log event). Closing time wired: `ClosingTime` construction, Hermes `closing` endpoint option, quit-path offer (`showMessageBoxSync`) before `teardown()`. |
| `src/main/watch/breaker.ts` | `BreakerEffects.steer` doc updated: the wiring owns the channel. |
| `src/main/closing.ts` | **New.** `ClosingTime`: requests to every live agent from `agent.closing`, ack watching (by `in_reply_to` or the `CLOSING-TIME-ACK` subject), hard deadline, report + `kind: shutdown` log events, reentry refusal. |
| `src/shared/reserved.ts` | Fourth reserved id: `CLOSING_ENDPOINT` (`agent.closing`) — unspawnable, so acks cannot be forged by a hire's id. |
| `src/shared/routing.ts` | Closing-endpoint route: any agent, `inform`/`done` acts only; anything that asks bounces. |
| `src/shared/log.ts` | `shutdown` log kind. |
| `src/main/hermes.ts` | `closing` endpoint option + dispatch; an ack with no closing in flight bounces "no closing time is in progress" (FR-3.4). |
| `prompts/hermes/closing-time-subject.md`, `-body.md` | The request's words (invariant §8); body names the ack subject and deadline. |
| `test/fakes/fake-engine/fake-engine.mjs` | Surfaces harness decisions on stdout (`hook-answer …`) exactly as the real shim relays them — how S-BREAKER proves same-turn delivery. |
| `test/scenarios/company.ts` | Runs the SHIPPED `SteerNotes` and `ClosingTime` (the M5.1 rule); options `hookGrade`, `closingDeadlineMs`. |
| `test/main/steer-notes.test.ts`, `test/main/closing.test.ts` | Unit contracts (8 + 10 cases). |
| `test/scenarios/s-breaker.test.ts` | GYM-002 block: the defect on record (queue holds mid-turn), same-turn hook delivery against a real spawned process, exactly-once, sub-native queue fallback. |
| `test/scenarios/s-closing.test.ts` | **New.** S-CLOSING: all-ack with `memory.md` grown pre-teardown, deadline naming silence, out-of-season bounce, reentry refusal — on real processes, real files. |
| `test/shared/routing.test.ts` | Closing-endpoint routing cases. |
| `test/scenarios/s-blackout.test.ts` | Restart-half `Company` literal gains its closing stand-in. |
| `docs/sdd/SDD.md` | §4.3 `shutdown` kind; §9 steer-channel sentence; §10 orderly-quit row. |
| `docs/TEST-STRATEGY.md` | S-CLOSING entry. |
| `docs/DECISIONS-LOG.md` | Eight entries (mechanism deviations, semantics, environment findings). |
| `docs/gymnasium/LEDGER.md` | GYM-002/003 `approved` → `landed`, metric checks due 2026-09-11. |

## Implementation Approach

**GYM-002** keeps the breaker pure policy and moves the channel choice into a
shipped class the production wiring and the scenario rig both construct. The
delivery mechanism deviates from the proposal's named `additionalContext`: the
shim already relays `{decision, reason}` verbatim for every event, and the
engine's documented `post-tool` semantics for `block` are "prompt the model with
the reason" — the same hook-boundary latency with zero shim/adapter changes,
and the proposal's merge risk disappears because steer and Stop answer
different events. Recorded in DECISIONS-LOG as a deviation inside the approved
scope.

**GYM-003** rides existing rails end to end: `deliverFromHarness` for the
requests, the wake watchdog / Stop-hook drain to get them acted on, and the
ratified harness-endpoint pattern for the acks (a fourth reserved id, guarded
in the routing table like the ledger and library endpoints). The harness — not
Artemis — runs the protocol, because Artemis may be among the workers being
closed. The deadline is a hard promise: closing time can slow a quit, never
hang it, and every silent agent is named.

## Mathematical / Statistical Details

None — both changes are protocol/plumbing; the only numbers are the 90 s
default deadline (bounded wait, configurable) and exactly-once delivery
semantics asserted by test.

## Design Decisions

Recorded individually in [DECISIONS-LOG](../DECISIONS-LOG.md) (2026-08-28
entries): decision-channel-on-post-tool over additionalContext; latest-wins /
once-only / session-start-clears note semantics; log-event channel visibility
over a new card field; endpoint acks over magic-subject mail; harness-run over
orchestrator-run closing; dual ack signal (`in_reply_to` or exact subject).

## Verification

- `npm run typecheck` · `npm run lint` (zero warnings) ·
  `node scripts/check-invariants.cjs` — all green.
- Targeted suites: steer-notes 8/8 · closing 11/11 · S-BREAKER (incl. 4 new
  GYM-002 cases) · S-CLOSING 3/3 · routing/message/hermes/S-WAKE/S-STOPLOOP/
  S-LIVELOCK/S-BOUNCE/S-BLACKOUT — 160/161 in the combined sweep, the one
  failure a Windows `EPERM` temp-rename flake in untouched M2 cursor code.
- Environment findings recorded in DECISIONS-LOG: `agent-worktree` (4) and
  `s-crash` (3) fail **at HEAD** on this machine (spawn-phase timeouts),
  verified pre-existing by running both with the diff stashed.
- Owed to the metric checks (2026-09-11): a recorded live quit with a real
  agent's `memory.md` appended pre-teardown (GYM-003), and two weeks of
  S-suite stability (both).

## Related Docs

[GYM-002](../gymnasium/proposals/GYM-002-hook-boundary-steer.md) ·
[GYM-003](../gymnasium/proposals/GYM-003-closing-time-shutdown.md) ·
[RB-001](../stoa/briefs/RB-001-munder-difflin-orchestration-autonomy.md) ·
[ADR-0011](../adr/ADR-0011-watch-breaker-budgets.md) ·
[ADR-0017](../adr/ADR-0017-stoa-research-department.md) ·
[SDD](../sdd/SDD.md) §4.3, §9, §10 · [Ledger](../gymnasium/LEDGER.md)
