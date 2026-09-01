# Surviving the provider's usage limit

**Date:** 2026-09-01
**Branch:** `feature/usage-limit-parking` (cut from `fix/workspace-trust-and-remembered-targets`)

## Problem / Motivation

Ephesus is meant to run for days. Hitting the provider's usage limit is a normal
event in that life, not a fault — but nothing in the harness knew that.

The Architect's requirement, verbatim:

> if we hit a usage limit we make sure we don't lose the agents and not kill the
> terminal. When the usage limit is reached we will ask the agents to continue
> from where they were left off.

Before this change the harness had no notion of provider capacity at all. What
it had instead were three mechanisms that would each do the wrong thing:

- **The ghost path** (`agents.ts` `offerRespawn`). A deliberate kill and a crash
  already take the same route by design, and a refusal would have joined them —
  recorded with an exit code, offered back to a human as a restart.
- **Artemis's respawn ladder** (`artemis.ts`). Five rungs, then
  `setOrchestrator(null)` and a company with no orchestrator. Restarting into a
  usage limit cannot succeed, so a limit that outlived five rungs would spend the
  whole ladder and leave the company headless over a condition guaranteed to
  clear on its own.
- **Nothing at all.** The reference engine does *not* exit on a refusal (see
  Evidence). It writes a synthetic message and returns to its prompt. So the
  actual pre-change behaviour was worse than a crash: the agent went quiet, the
  avatar went idle, the dock said `idle`, and a company that had stopped working
  was indistinguishable from a company that had finished.

That last one is the invariant §7 failure this whole system is built against.

## What changed

| File | Change |
|---|---|
| `src/shared/capacity.ts` | **New.** The vocabulary (`CapacityLimit`, `ParkedAgent`, `CapacityView`) and the pure decision: the retry ladder, the company view, the strip sentence. |
| `src/main/engines/types.ts` | `TranscriptReader.limitOf?(raw)` — an optional, pure, per-record classifier. Optional so an engine that cannot tell a refusal from a finished turn says so rather than pretending coverage. |
| `src/main/engines/claude.ts` | **`claudeCapacityLimit`** — the detector, plus the evidence for it in the doc comment. Wired onto the adapter's transcript reader. |
| `src/main/watch/capacity.ts` | **New.** `CapacityWatch`: tail-reads live transcripts, parks, schedules and fires the continuation, verifies, clears. Plus `readTail`. |
| `src/main/artemis.ts` | `holdForCapacity()` / `releaseForCapacity()` / `heldForCapacity()`. An exit during a hold is remembered, not charged to the ladder. |
| `src/main/agents.ts` | `capacityParked?()` option; `RespawnOffer.waitingForCapacity` is asked, never inferred from an exit code. |
| `src/shared/agents.ts` | `RespawnOffer.waitingForCapacity`. |
| `src/main/index.ts` | The production wiring: construction, the three effects, the resume prompt, teardown, and the deliberate *absence* of a `capacityWatch.forget` on exit. |
| `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts` | `watch:capacity` (pull) and `capacity:state` (push). |
| `src/renderer/src/StatusBadge.tsx` | `CapacityBadge` — the status-strip badge. |
| `src/renderer/src/AgentDock.tsx` | `DockRow.capacity`, `rowTone`, and the park overriding the phase word. |
| `src/renderer/src/App.tsx` | Strip state, poll + push, badge placed first on the strip. |
| `prompts/watch/capacity-resume.md` | **New.** The continuation text (invariant §8). |
| `src/shared/log.ts`, `docs/sdd/SDD.md` | New log kind `capacity`, and §4.3 updated to match. |
| `test/fixtures/claude-limit/transcript.jsonl` | The record shapes a real engine wrote, negative controls included. |
| `test/…` (5 files) | See Verification. |

## Evidence for the detector

This is the part the requirement said would be audited hardest, and the part the
repo's own history says not to guess at. The rule is:

```
type === 'assistant' && isApiErrorMessage === true && error === 'rate_limit'
```

**Source 1 — records a real engine wrote on this machine.** Searching all 245
transcripts under `~/.claude/projects/` found three refusal records in
`C--Users-senso-OneDrive-Masa-st--tmac-oss/39ba11ac-….jsonl` (engine 2.1.237),
at `2026-08-30T21:58:55.766Z`, `2026-08-31T01:31:37.479Z` and
`2026-08-31T03:47:34.024Z`. Each carries:

```json
"type": "assistant", "error": "rate_limit", "isApiErrorMessage": true,
"apiErrorStatus": 429, "message": { "model": "<synthetic>", "content": [{ "type": "text",
"text": "You're out of usage credits. Switch to another model, or manage usage credits at …" }] },
"errorDetails": "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\", …}}"
```

**Source 2 — the engine's own predicate.** The shipped 2.1.252 binary contains

```js
if (b.type === "assistant" && b.isApiErrorMessage && b.error === "rate_limit" && b.quotaLimits)
```

before it reads quota information. The three fields tested here are the three
fields the engine itself tests.

**Source 3 — a real negative control.** The *same* transcript carries three
`error: "server_error"` records: an `ENOTFOUND` and two `529 Overloaded`
(`apiErrorStatus: 529`). They are in the fixture and the detector must not fire
on them. The binary also shows the engine's full taxonomy —
`billing_error` ("usage limit reached — check plan"), `rate_limit` ("rate limited
— wait and retry"), `overloaded`, `server_error`, `invalid_request` — of which
waiting fixes exactly one. `billing_error` is excluded deliberately: it reads
like a limit and no amount of waiting clears it.

**The process does not die.** In the observed transcripts, ordinary records
follow each refusal within milliseconds (`last-prompt`, `queue-operation`,
`attachment`) and the session continues for days afterwards. Ephesus spawns
`claude` interactively (`spawnArgs` builds `claude --permission-mode … ` with no
`-p`), so the refusal ends the *turn*, not the process. That is why the primary
resume path talks to the live session rather than restarting anything.

**The reset time.** `quotaLimits.resetsAt` is unix **seconds** — the engine
builds `quotaLimits` from the `anthropic-ratelimit-unified-*` response headers
(`resetsAt = Math.round(Number(header 'anthropic-ratelimit-unified-reset'))`) and
compares it elsewhere as `resetsAt * 1000 <= Date.now()`. It is absent from every
record observed here, so it is read when present and never substituted when
missing.

## Implementation approach

### Detect

`CapacityWatch` ticks every 5 s (faster than the 15 s budget fold: spend is not a
real-time quantity, a stopped company is). For each live agent it reads the
**tail** of each session transcript — 512 KiB, `readTail` — splits JSONL, and
hands each parsed record to the adapter's `limitOf`. The last refusal in the file
wins.

Tail rather than whole-file for two reasons: the question is about the *present*
state, not a total; and it makes the check O(1) in a file that reaches tens of
megabytes, on the same event loop that carries PTY bytes (SDD §11). The window is
generous by orders of magnitude because what it must span is bounded — once the
provider refuses, the turn is over and only tiny bookkeeping lines follow.

Each refusal is identified by its record `uuid` and remembered, so the company
parks once per refusal rather than once per look.

### Park

`onPark` does exactly three things, and none of them is a kill, a ghost, or a
restart:

1. Writes a `capacity` log entry (the engine's own sentence, verbatim) and pushes
   `capacity:state`.
2. Reports a degradation and pauses Hermes deliveries to that agent — a pause,
   not a discard; the mailbox keeps everything.
3. Calls `artemis.holdForCapacity()`.

### Resume

The wait is `retryDelayMs(attempts, resetsAt, from)` measured **from the
refusal's own timestamp**, which is what makes a harness restart behave
correctly: an agent refused three hours ago is already due and is continued on
the first tick rather than serving its minute again.

When it comes due:

- **Process alive** (the normal case): the continuation text is submitted through
  the FR-1.3 command queue into the session the agent was already having. No new
  process, no re-injected identity, no lost context.
- **Process died during the park**: `AgentManager.respawn()` — the existing
  `--resume <sessionId>` path (ADR-0009 `ResumeSupport`), the same machinery
  crash recovery uses — followed by the continuation, which the queue holds until
  the fresh session reports idle.

The log records which of the two ran (`via: 'live-session' | 'respawn'`), because
they are not equivalent.

### Verify

`resuming` → `clear` happens on a **verification window** (2 min) rather than on
proof of success. What a transcript can actually tell us is whether the provider
refused *again*; the harness claims only that. If it was wrong, the next refusal
re-parks the agent one rung higher and the system corrects itself, rather than
asserting a recovery it did not witness.

## Design decisions

**The capacity ladder never ends.** Every other ladder in this system does, and
for good reason: a process that will not start is a fault a human must see. This
one holds at its top rung (1 h) forever, because a healthy agent abandoned over a
condition guaranteed to clear is precisely the "losing the agent" the requirement
forbids. `retryDelayMs` clamps rather than indexes past the end, and there is a
test that asserts attempt 100 000 still returns an hour.

**A new log kind rather than reusing `breaker` or `exit`.** `breaker` is *our*
ladder against an agent misbehaving; `exit` is a dead process. A capacity park is
a healthy agent the provider declined to serve. A forensic reader who cannot tell
the three apart cannot reconstruct what the company did (NFR-13).

**The avatar is left alone.** The tempting move was `waiting-on` (SDD §6), which
reads exactly right. It would also have deadlocked the feature: `decideCommand`
*holds* text for an agent in `waiting`, and held text flushes only on an idle
observation — so the continuation would have been queued forever behind the park
that queued it. Visibility instead comes from the two surfaces the requirement
names, and the avatar keeps telling the truth (the process *is* idle) while the
dock says why.

**`limitOf` is a pure per-record classifier, not a file reader.** Same division
as `claudeUsageFact`: the Watch owns the reading (one tail read, one JSONL
split), the adapter owns the shape only it knows (NFR-12). An engine that omits
it is reported as unwatchable, once, naming the consequence.

**`onPark`/`onResume`/`onClear` are injected effects.** `CapacityWatch` owns no
subsystem, exactly as `Breaker` owns none — which is what let the whole state
machine be tested against a fake clock and a temp directory.

**Not `capacityWatch.forget()` on exit.** The exit branch in `index.ts` forgets
the budget session and the breaker rungs; forgetting the park there would be the
bug. An exit during a park is a parked agent whose process died, and it is still
owed a continuation. There is a comment at that line saying so.

## Verification

```bash
npx vitest run test/shared/capacity.test.ts test/main/capacity-watch.test.ts test/main/engines/claude-capacity.test.ts test/renderer/capacity-visible.test.tsx test/main/artemis.test.ts
```

51 tests across five files: the pure ladder (14), the detector against real
record shapes (16), the watch state machine (18 incl. `readTail`), the two UI
surfaces (9), and Artemis's held ladder (4 of 40).

**MUTATION-CHECK.** Six breaks, each confirmed red and reverted:

| # | Break | Red |
|---|---|---|
| 1 | detector also accepts `server_error` | 3 (both negative controls + the count) |
| 2 | `limitOf` unwired from the adapter | 1 ("wired, not merely exported") |
| 3 | drop the clamp so the capacity ladder ends | 1 ("never ends") |
| 4 | dock ignores the park | 2 (status reads `idle` again) |
| 5 | Artemis charges a parked exit to the ladder | 2 |
| 6 | watch drops its seen-refusal guard | 5 (re-parks every tick) |

**Gate:** `npm run typecheck` ✔ · `npm run lint` ✔ · `node scripts/check-invariants.cjs` ✔ ·
`node scripts/check-attribution.cjs` ✔.

**Known-red, not from this change** — measured by checking out `dd448a1` and
re-running the same files:

- `test/shared/cost.test.ts > splits one transcript across the days it spans` —
  flagged by the Architect as pre-existing on this branch.
- `test/renderer/emotes.test.ts` — imports
  `src/renderer/src/assets/tileset/limezu.emotes.json`, which is gitignored and
  absent in a fresh worktree. Also the only `npm run typecheck` error.
- `agent-worktree`, `agora`, `hires-exchange`, `library`, `worktrees`,
  `s-blackout`, `s-crash`, `s-livelock`, `s-profile`, `s-stoploop` — 16 failures
  at `dd448a1` before any of this landed, with the failing case varying between
  runs.
- `test/main/hermes.test.ts` — flaky here: a different test fails each run and it
  passes on rerun (3 runs: fail, pass, pass).

## What is NOT verified

- **No live run.** The detector is proven against recorded records and the
  engine's own predicate, not against a limit reproduced on demand — the
  Architect's account is not currently rate-limited and a limit cannot be
  induced. The whole park→resume→clear cycle is proven against a fake clock and
  real files on disk, never against a real refusal end to end.
- **`quotaLimits.resetsAt` in the wild.** Its unit and meaning are read out of
  the shipped binary; no observed record carries one, so that branch has never
  run against real engine output.
- **Engine-version drift.** If Claude Code renames `error` or `isApiErrorMessage`,
  the detector goes quiet and the company reverts to today's behaviour — silent
  parking. The unwatchable-engine warning does *not* cover this case, because the
  adapter still declares `limitOf`.
- **Codex and Gemini.** Neither adapter implements `limitOf`, so neither is
  parked or resumed. This is reported per agent as a degradation, once, naming
  the consequence.

## Related docs

- `docs/adr/ADR-0009-engine-adapters.md` — `ResumeSupport`, `transcripts`, NFR-12.
- `docs/adr/ADR-0011-*` — the budget/breaker ladder this deliberately is not.
- `docs/sdd/SDD.md` §4.3 (log kinds), §6 (avatar states), §9 (the Watch), §11.
- `BUILD-PROMPT.md` §3 invariants — §7 (visible degradation), §8 (prompts as files).
