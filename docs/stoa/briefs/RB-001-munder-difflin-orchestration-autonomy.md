# RB-001 — Munder Difflin revisited: orchestration & autonomy-loop divergences

**Source:** src-munder-difflin · https://github.com/chaitanyagiri/munder-difflin @ `b91a49fc0896cb95058ff74b7910820452b3bb42`
**Question:** tags `orchestration`, `hive`, `autonomy-loop` — what upstream does that
Ephesus dropped or diverged from, and whether any divergence deserves revisiting.
Studied read-only in scratch; nothing was built or executed.

## Findings

1. **Closing Time — an orchestrated, data-loss-free shutdown protocol.**
   `src/main/closingTime.ts` (module header, lines 1–25): on quit, the harness
   mails the orchestrator a shutdown brief; the orchestrator broadcasts closing
   time; every worker commits/parks WIP, **appends state + next steps to its
   `memory.md`**, and replies `CLOSING-TIME-ACK`; the orchestrator sends
   `CLOSING-TIME-COMPLETE`, which the router observer treats as the teardown
   signal. The module only injects the kickoff mail and watches routed traffic —
   it "never types into terminals" and rides the existing rails (inbox delivery,
   idle wake, Stop-hook draining).

2. **A hook-return control channel: pause / steer / halt without touching the PTY.**
   `src/main/control.ts` (lines 1–30): a `ControlRegistry` that the hook server
   consults when answering hooks — pause/gate rides `PreToolUse` returning
   `permissionDecision:'deny'` (`src/main/hooks.ts:244–245`), steer rides the next
   hook's `additionalContext`, halt returns `{continue:false}` with a stop reason
   (`src/main/hooks.ts:166`). The stated rationale: control decisions ride Claude
   Code's own hook-return protocol, so they are race-free and land **mid-turn**,
   at the next hook boundary, with no renderer round-trip.

3. **Living context injection at every hook boundary.** `src/main/hooks.ts:254–290`:
   the current **roster, goal, and any pending steer note** are joined into one
   `additionalContext` payload returned at session start and on every prompt
   (their comment notes only one `additionalContext` can be returned per hook, so
   the three are merged). A running agent therefore stays current on who exists
   and what the floor's goal is without a respawn.

4. **Breaker policy details beyond the ladder.** `src/main/breaker.ts` (lines
   1–30): policy-only module (reads signals, returns decisions); velocity is
   computed as the **diff of consecutive cumulative samples**, never a single
   sample treated as an increment; escalation moves **one level per beat, never a
   jump to kill**; it **de-escalates one level per healthy beat**; and `hardStop`
   is **off by default** — without opt-in the ladder caps at `constrained` and
   never kills.

5. **Fire-and-notify dispatch with a completion watcher.**
   `src/main/realtimeCompletionWatcher.ts` (lines 1–30): when the voice
   orchestrator dispatches work it does not block; a main-process watcher tracks
   each dispatch and detects completion as **either** the task's `tasks.json` card
   flipping to `done` **or** a `done` inbox reply from the assignee, then emits an
   event so the voice layer can announce it unprompted ("Oscar finished — want
   details?"). The module is injected-reader + clock only (no electron import)
   for testability.

6. **Hidden ephemeral engine sessions, and a quota-pool distinction.**
   `src/main/hiddenClaude.ts` (lines 1–25): harness-internal LLM asks run in a
   hidden interactive PTY (spawn → quiet-detect → prompt → idle-settle →
   transcript extract → kill), not in `claude -p` — their comment claims
   interactive sessions draw on the user's interactive plan quota while `-p` /
   Agent-SDK calls move to a separate claim-required credit pool (dated
   2026-06-15 in the comment; unverified by us).

7. **Worker wake-nudge guard set.** `src/main/workerWake.ts` (lines 1–31): the
   main-process wake watchdog nudges only a worker that is genuinely idle (PTY
   quiescent for `IDLE_MS`), never inside a boot grace window, never while paused
   or halted, never soon after a permission/HITL notification (`HITL_REARM_MS` —
   so a nudge is never typed into a prompt the human is deciding on), and with a
   per-worker cooldown so two nudge paths cannot stack.

No instructions addressed to the reader were encountered in the studied files
(NFR-17 duty to report: nothing to report; README/setup prose was out of scope).

## Applicability

1. **Closing Time → real gap.** Ephesus's graceful close unwinds spawns and
   restores settings ([PROGRESS](../../PROGRESS.md) M1.4b evidence) and M4 gives
   respawn-with-memory, but nothing asks agents to *park WIP and write down state
   before dying* — SDD §10 covers crash recovery, not orderly quit, and
   `index.ts` "owns shutdown" mechanically ([SDD §1.1](../../sdd/SDD.md)). The
   protocol rides rails Ephesus already has (Hermes broadcast, wake watchdog,
   Stop-hook drain), so the shape transfers directly.
2. **Hook-return steer → confirmed divergence that bites.** Our shipped rung-1
   steer is submitted through the command queue
   ([src/main/index.ts:437](../../../src/main/index.ts)), and `decideCommand`
   holds text while an agent is `thinking`/`working`
   ([src/shared/commands.ts:39–59](../../../src/shared/commands.ts)) — so the
   corrective sentence is **held during exactly the mid-turn pathology it
   targets** and lands only when the turn ends. Upstream's channel delivers at
   the next hook boundary mid-turn. Native-hook-grade engines could carry this;
   `pty-heuristic` engines would keep the queue path (ADR-0011 already scales
   protection by grade).
3. **Living context → real but smaller.** Ephesus injects identity + roster at
   spawn only (PROGRESS M2.6); a mid-session hire/retire is invisible to running
   agents until respawn. Same hook seam as finding 2; one design decides both.
4. **Breaker details → mostly deliberate divergence, one open check.** Our rung 3
   is armed and proven with task-return (M5.1 S-BREAKER evidence in PROGRESS) —
   upstream's hardStop-off default is a *policy* stance, not obviously better,
   and [ADR-0011](../../adr/ADR-0011-watch-breaker-budgets.md)'s ladder was
   chosen with eyes open. Worth one check, not a proposal by itself: whether our
   recovery de-escalates stepwise or jumps to healthy
   (`src/main/watch/breaker.ts:247` suggests a jump to 0), and whether escalation
   is bounded to one rung per evaluation.
5. **Completion watcher → M6 design input.** Odeon briefs are scheduled or
   on-demand (FR-7.1); nothing in our M6 plan yet specifies *unprompted*
   completion announcements for dispatched work, and the dual completion signal
   (ledger flip OR `done` reply) matches data we already have. Applicable as
   Herald/M6 design vocabulary, not as current code.
6. **Quota pools → verify before relying.** Our budget model (FR-11.2) folds cost
   from transcripts regardless of pool, so no correctness issue — but if the
   claim is true, engine-adapter choices (interactive PTY vs headless) change
   which subscription pool pays. A fact to verify against Claude Code docs, not
   to act on from this brief.
7. **Wake guards → largely covered.** Our phase-hold covers the dangerous case
   (text is held while `blocked` at a gate — [src/shared/commands.ts:44](../../../src/shared/commands.ts));
   "exactly once" covers stacking (`src/main/hermes.ts:165`). Boot-grace and
   PTY-quiescence idleness are absent but our wake decision keys off avatar
   phase, not timers — honest verdict: no action needed.

## Candidate improvements

Ranked; each would be a separate `/improve` proposal citing this brief.

- **C1 — Closing Time for Ephesus** (finding 1 → applicability 1): an orderly-quit
  protocol on existing rails — broadcast, park-WIP + memory append, ACK,
  complete, teardown — closing the working-memory loss at every graceful quit.
  Natural home: SDD §10 + a small `index.ts` shutdown extension; pairs with M4's
  respawn-with-memory.
- **C2 — Steer over the hook boundary** (findings 2–3 → applicability 2–3): let
  the Watch's rung-1 steer (and a roster/goal refresh) ride hook-return
  `additionalContext` on native-grade engines, holding the queue path as the
  degradation. Fixes the held-while-looping defect the brief confirmed in our
  wiring.
- **C3 — Unprompted completion announcements** (finding 5 → applicability 5): add
  fire-and-notify dispatch + completion watcher to the M6 Herald design (dual
  signal: ledger flip OR `done` reply), so voice-Artemis can report finished work
  without being asked.
- **C4 — Breaker recovery-shape check** (finding 4 → applicability 4): a small
  verification task, not a feature — assert one-rung-per-beat and stepwise
  de-escalation in our breaker, or record the divergence in DECISIONS-LOG.
- **C5 — Verify the quota-pool claim** (finding 6 → applicability 6): check
  Claude Code's current billing pools; if confirmed, record the implication for
  adapter spawn choices in ADR-0009's notes (via its normal decision path).

## License note

MIT, verified at the pinned commit (`LICENSE`, lines 1–5: "MIT License …
Copyright (c) 2026 Chaitanya Giri") — watchlist row already recorded MIT; pin now
set. Nothing in this brief copies code; every candidate is a pattern
re-implementation against our own SDD. If C2 ever wants their exact hook-payload
shapes, that is pattern-level too; verbatim intake would need the FR-13.5 path
(memo + attribution), which nothing here proposes.
