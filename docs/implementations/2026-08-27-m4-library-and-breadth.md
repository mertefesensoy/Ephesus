# M4 — The Library + engine breadth (M4.1–M4.9)

**Date:** 2026-08-27 · **Milestone:** M4 (docs/IMPLEMENTATION.md) · **Author:** the Architect (agent-assisted sessions)

## Demo view

M4's exit is memory made real: an agent is killed mid-task and comes back
holding what it had written down — and able to ask the rest of the company
what *it* knows.

```
3. SIGKILL, mid-tool-call. exitCode=-1
   respawn offer: resumable=true memorySections=1 tasksReturned=["t-demo-1"]
   ledger: ["t-demo-1=todo"]   (back on the board)

4. Respawned. The NEW process prints back the context it was handed:
   │ ## Your memory
   │ ## 2026-08-27 — agent.mason
   │ The checkout suite is flaky because the fixture seeds two carts.

   log.jsonl: memoryCarried=true resumed=true sessionId=sess-mason-demo

5. It asks what the company knows — recall on the mempalace rung:
   [mempalace] "when is staging wiped"
     -> agent.iris: The staging database resets at 03:00 UTC every night…
```

_Full capture: [`m4-respawn-recall.txt`](../demo/m4-respawn-recall.txt). Real
Agora with real git, real hook socket, real child processes, real files. The
engine is the fake engine — a real spawnable CLI — because nothing in this
environment can authenticate a real one: its **words** are scripted, every
mechanism around them is the shipped one. Said plainly rather than implied,
the same rule M3.9 set._

## Problem / Motivation

Through M3 the company could hire, talk, coordinate and be governed — but it
could not remember. `identity.md` was re-injected on respawn and the log
recorded whether memory carried, while nothing wrote or read `memory.md` at
all: the fact was reachable and false. M4 makes it true, and builds the three
layers ADR-0006 describes on top of it — markdown ground truth, recall with a
visible degradation ladder, and reflection that bounds memory without
destroying any of it. It also widens the engine roster to three and gives a
spawn the option of its own worktree.

## What Changed (by package)

| Package | What landed |
|---|---|
| M4.1 | `memory.md` per agent — append-only dated sections, atomic writes, seeded at hire; the memory layer on the spawn config; `AgentCard.respawnOffer`; SDD §10's crash lifecycle; **S-CRASH** |
| M4.2 | The recall ladder — grep (the transparency floor, pure code), SQLite FTS5 behind a seam, `eph-recall` answering on the hook socket, mtime-gated indexing |
| M4.3 | The MemPalace driver (ADR-0016), written against a real `mempalace` 3.8.0 under ADR-0009's subprocess discipline |
| M4.4 | The scheduler (idempotent ticks) and reflection — the harness asks an agent to condense its own memory and checks that nothing was destroyed |
| M4.5 | The knowledge shelf (FR-6.4) and the Memory panel, with the ladder chip |
| M4.6 | The codex adapter, at `pty-heuristic` — the grade it can demonstrate |
| M4.7 | The gemini adapter, at `pty-heuristic` — for a different documented reason |
| M4.8 | Worktree isolation (UC-01 2a), in `git.ts`, never destroying uncommitted work |
| M4.9 | The recall smoke test at every rung, and the exit demo |

## Implementation Approach

**Layer 1 is prose, and the harness keeps its hands off it.** ADR-0006 rejects
imposing schema at write time, so `src/shared/memory.ts` owns only the dated
heading the harness writes and the parser that finds those headings again.
Structure is extracted at read time; an agent that headed a section its own way
loses nothing.

**The memory layer reaches adapters as text, not as a path.** Deciding how much
of a long memory a spawn can carry is the Library's judgement; an adapter that
re-derived it would make that judgement engine-specific. When the 8 000-char
budget bites, the agent is *told* — a silently truncated memory would leave it
confidently wrong about what it knows.

**Every rung of the ladder is visible.** `recall()` answers on the best rung
that will answer and reports why it was not a higher one, all the way down to
grep, which has no index, no native module and no subprocess and therefore
cannot be unavailable. `eph-recall` prints the rung on every answer and, unlike
`eph-hook`, does **not** fail open: an agent that got silence would conclude the
company knows nothing.

**The harness never summarizes.** ADR-0005 rejects "the harness calls a model
API directly", so reflection asks the agent whose memory it is, as a normal turn
on a harness prompt, and applies what the agent proposes back to the reserved
`agent.library` endpoint. `Library.condense()` is the one method allowed to
rewrite `memory.md`, and only because the archive is written first and
`nothingDestroyed` verifies every old section survives byte-for-byte before the
rewrite is committed — a summary is never counted as containing what it
summarizes.

**The two new adapters were written against binaries that were installed and
run.** Both declare `pty-heuristic` and both mean it: codex's hook plane needs
persisted trust whose only override is `--dangerously-bypass-hook-trust`, and
gemini's lives in a *tracked* settings file ADR-0009 forbids the harness
writing. Neither adapter lowers a permission default on the Architect's behalf,
neither writes anything into anyone's repository, and both declare no `resume`
and no transcripts rather than claim capabilities they cannot honour. Grading up
would have been easy and wrong.

## Verification

Every M4 exit criterion was verified by running it; the table is in
`docs/PROGRESS.md` under the M4 verdict. Headlines: the respawn demo above; the
recall smoke test **16 passed** at grep, fts *and* mempalace against the real
3.8.0; the conformance table run 17 times each against codex and gemini beside
claude; S-CRASH 3 passed; 76 scenario cases across 11 files; the whole gate
**1506 passed / 5 skipped**, run twice with no flake, up from 1236 at M3 close;
CI green on all nine package branches (runs 44–53).

**Owed to a local session, recorded rather than faked:** the Memory panel's
screenshot (`electron-rebuild` cannot fetch Electron headers through this
environment's proxy, so `npm run dev` cannot boot) and a real-engine respawn
demo (no engine here can authenticate). The two-agent close-out audit M0–M3
each received is also still owed — the harness this session ran under withheld
the Agent tool.

## Related Docs

- [ADR-0006 — the Library](../adr/ADR-0006-library-memory.md) ·
  [ADR-0016 — MemPalace](../adr/ADR-0016-mempalace-archival.md) ·
  [ADR-0009 — engine adapters](../adr/ADR-0009-engine-adapters.md) ·
  [ADR-0005 — Artemis](../adr/ADR-0005-artemis-orchestrator.md) ·
  [ADR-0004 — the single committer](../adr/ADR-0004-agora-single-committer.md)
- [SDD](../sdd/SDD.md) §1.1, §2, §3, §4.6, §5, §10 · [SRS](../srs/SRS.md) FR-6, NFR-7, UC-01
- [PROGRESS](../PROGRESS.md) — the M4 verdict · [DECISIONS-LOG](../DECISIONS-LOG.md) — 56 entries this milestone
