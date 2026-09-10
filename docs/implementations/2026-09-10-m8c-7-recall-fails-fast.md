# Recall must fail fast or not accept the call

**Date:** 2026-09-10 · **Milestone:** M8c.7 · **Branch:**
`fix/m8c-7-recall-fails-fast` from `origin/main` `06487a3`

---

## 1. Problem / motivation

Finding 9 of [the M8 exit run](../demo/m8-onehour-aftershock.md), in the
health-watcher's own words:

> `$EPH_RECALL` is **unavailable, not merely empty**. Two attempts (unscoped, and
> `--scope knowledge`) produced **zero bytes of output and never terminated**;
> the second was **killed at 90s, exit 143**. So I could not fall back on a
> colleague's transcription of the runbook either, and **no agent can currently
> look anything up**.

`DIAGNOSIS.md` reported memory as `BROKEN` with the documented, expected cause —
MemPalace absent, *"falls back to a full-text rung"* — and nothing else. **A
missing optional that degrades to a lesser rung is the documented design; a path
that accepts the call, returns nothing and never returns is a different thing**,
and it was disclosed nowhere. A reader of the report would believe recall had
gracefully degraded. It also removed the crew's only route around M8b.1.

---

## 2. The root cause, which was not in the shim

`eph-recall.mjs` has had a **ten-second timeout** and named refusals since it was
written. Its transport honours that timeout correctly. It never ran.

`EPH_RECALL` is composed in `index.ts` from `process.execPath` — and in this
application that is **Electron, not Node**. Handed a `.mjs` path, Electron treats
it as an *app to load* rather than a script to run: it starts, finds no entry
point, and sits there. No stdout, no stderr, no exit.

**Exit 143 is SIGTERM.** The process did not fail; the agent gave up on it.

`ELECTRON_RUN_AS_NODE` is Electron's documented answer, and it appears nowhere in
the tree. The variable is set on the *agent's* environment rather than prefixed
onto the command, because `EPH_RECALL` and `EPH_GH_TOKEN` are command **strings**
an agent pastes into its own shell — the variable has to be inherited. Its only
effect is on an Electron binary, which nothing else an agent runs is.

**Writing the probe found a second defect in the same line.** The command was
composed unquoted:

```
C:\Program Files\nodejs\node.exe C:\…\eph-recall.mjs
```

which is three words to a shell. The first real spawn in this package's own tests
failed instantly for exactly that reason. Both halves are quoted now.

---

## 3. What changed

| File | What |
|---|---|
| `src/main/engines/claude.ts` | `ELECTRON_RUN_AS_NODE: '1'` on the agent's environment, with the incident in the comment. |
| `src/main/index.ts` | Both shim commands composed through `shellCommand`; one call to `reportRecallProbe`. |
| `src/main/recall-probe.ts` | **new.** `shellCommand`, `runRecallProbe` (injectable child), `probeRecallCommand`, `reportRecallProbe`. |
| `src/shared/recall.ts` | `recallProbeCondition` — the pure rule, three ways to be unreachable and one way not to be. |
| `scripts/coverage-floors.json` | The new module joins the `library` row. |
| `test/main/recall-probe.test.ts` | **new**, 20 cases: the rule, real spawns, the timeout, the kill, the spawn-error path, and what boot calls. |
| `test/main/engines/claude.test.ts` | The variable is asserted, and allowlisted in the "nothing else" check. |

---

## 4. Mathematical / statistical details

No formula. The classification, stated exactly, because getting it backwards is
how the original defect stayed invisible:

> A probe of the recall command is **unreachable** iff
> `timedOut ∨ code = null ∨ output = ""`, and each disjunct gets its own
> sentence — *never answered*, *could not be run*, *answered nothing (exit n)*.
> It is **reachable** iff `¬timedOut ∧ code ≠ null ∧ output ≠ ""`.

**The discriminator is OUTPUT, not the exit code**, and that is the load-bearing
choice. The 2026-09-09 process was killed, so its code says nothing about whether
recall works; meanwhile `eph-recall` exits **1** with a named cause when the
harness is down, and that is the shim *working* — the agent learns something. A
check keyed on the exit code would have passed the hang (no code at all) and
failed the working refusal (code 1): **both backwards.** That is the round's
control case.

---

## 5. Design decisions

**Fix the cause, then check it anyway.** `ELECTRON_RUN_AS_NODE` makes the shim
run; the probe exists because a command the harness *composes* and only agents
*run* is a command nothing checks. That is how this survived to a live run in the
first place, and the fix would have been just as invisible when it broke again.

**The probe runs once, at boot, in the background.** A boot that waited on it
would have made this fix one of the things it exists to prevent. Its own deadline
is eight seconds — long enough for a cold Node start on a loaded machine, short
enough that a hung probe is not a hung anything.

**An answer is enough, including a refusal.** Treating `exit 1: recall
unavailable: this process was not started by the harness` as a fault would make
the condition fire on every correct install, which is how a report teaches its
reader to skip a column.

**The child process is injectable, and that is a deliberate seam.** With
`shell: true`, node emits `error` only when the *shell itself* cannot start — a
state no test can honestly produce, and the listener is still required because a
child process without one throws. The choice was a branch nothing could cover or
a seam that could, and this repository has already decided which is worse. Three
of the twenty cases still spawn **real processes**, because the whole finding is
that nobody ever ran the command.

**`reportRecallProbe` exists so `index.ts` holds one call and no closures.** The
`boot` coverage row failed on the `.then(…, …)` that was there first — two
functions no test can enter. That is the second time in this milestone a floor
caught a design decision rather than a number (M8c.8 was the first), and it was
right both times.

---

## 6. Verification

Full gate, this branch:

```
typecheck   green (node, preload, web, web-test)
lint        All matched files use Prettier code style!
invariants  ok — reachability 189/199 src modules reached, 10 by recorded decision, 6 type-only
tests       Test Files 236 passed (236) · Tests 4588 passed | 8 skipped (4596)
coverage    floors ok (17 subsystems on win32; 20 untested modules, all recorded)
```

**Mutation round, with a control.**

```
test files: recall-probe · claude (engines)
baseline: GREEN
  M1 the agent no longer runs Electron as node          KILLED
  M2 a hang is not reported                             KILLED
  M3 a silent exit is not reported                      KILLED
  M4 a spawn failure is not reported                    KILLED
  M5 a working refusal is reported as a fault           KILLED
  M6 the condition stops distinguishing itself from MemPalace KILLED
  M7 the command is composed unquoted again             KILLED
  M8 the probe never gives up, and becomes the hang     KILLED
  M9 a probe that threw reports a fault it did not observe KILLED
  CONTROL a no-op reword in the rule's own comment      SURVIVED — CERTIFIED

mutants: 9 real, 1 control · killed: 9 of 9 real · ROUND OK
```

**The first round killed 7 of 9, and the two survivors were different animals.**

- **M8 was a real gap.** Removing `child.kill()` left the probe reporting the
  timeout correctly and the sixty-second process still running: the condition was
  right and the machine was dirtier every boot. Two cases now assert the child is
  killed on a deadline and *not* killed when it answered.
- **M6 was a bad mutant, not a gap.** It replaced the tail of a two-line string
  concatenation while the asserted phrase lived on the line before, so it could
  not change what any test reads. **A mutant that cannot change what a test reads
  is not a mutant**, and scoring it as a survivor would have sent me looking for a
  missing test that was already there. Re-aimed at the line carrying the phrase,
  it dies.

**Adversarial refutation pass.**

| Attempt | Result |
|---|---|
| Does the shim run at all now? | Yes — asserted on the spawn plan, and M1 flips the variable and dies. |
| Is a working refusal reported as a fault? | No — a named refusal is an answer. M5 makes it a fault and dies. |
| Is the hang distinguished from the documented MemPalace degradation? | Yes, in the condition's own words, and M6 removes the sentence and dies. |
| Does a path with a space still break the command? | No — both halves quoted, asserted by construction and by a real spawn. |
| Does the probe become the hang it reports? | No — its own deadline, asserted with a real 60-second child and a 1.5-second budget. |
| Does it leave that child behind? | No — **found by M8**, now asserted. |
| Can a probe that threw invent a fault? | No — it reports nothing, because a probe that threw has observed nothing. M9 dies. |
| Is the spawn-error path reachable at all? | Only through the seam, deliberately — see §5. |
| Would the exit code alone have worked? | No, and backwards in both directions. That is the control case. |

**What this cannot claim.** That recall now *works* on the Architect's machine —
MemPalace is still absent by design and the full-text rung is what answers. What
it claims is that the command an agent is handed can be run, and that a
configuration where it cannot is a condition in `DIAGNOSIS.md` rather than ninety
seconds of silence per agent.

---

## 7. Related docs

- [`docs/demo/m8-onehour-aftershock.md`](../demo/m8-onehour-aftershock.md) — Finding 9
- [`docs/adr/ADR-0006-memory-architecture.md`](../adr/ADR-0006-memory-architecture.md) — layer 2, the agent-facing CLI
- [`docs/adr/ADR-0016-mempalace-optional-external.md`](../adr/ADR-0016-mempalace-optional-external.md) — the degradation this is NOT
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8c.7 and its acceptance
