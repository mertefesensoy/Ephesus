# A removed worktree takes its directory with it

**Date:** 2026-09-06
**Found by:** the M8.6 audit, working toward a releasable MVP
**Requirement:** SRS UC-01 alternate 2a · NFR-7 (spirit) · ADR-0004
**Branch:** `fix/mail-lost-when-a-woken-agent-dies`

---

## 1. Problem / Motivation

Three directories were sitting in `~/.ephesus/worktrees/` — one per crew agent —
**completely empty**, with no `.git` file, and unknown to `git worktree list` in
the target repository. `git worktree remove` had unregistered them and left the
directories behind.

Left alone they accumulate, one per agent id per activation. Worse, they were
*actively harmful* until earlier the same day: `worktreePathIsVacant` refused a
target directory that already existed, so the residue of one activation refused
the next activation for the same agent id — the "defect #5" refused spawn seen
during the one-hour run. That fix (an empty directory counts as vacant) made the
residue harmless; it did not stop it being produced.

## 2. What changed

| File | Change |
|---|---|
| `src/main/git.ts` | `sweepEmptyResidue`; `WorktreeRemoval.removed: true` now carries `residue: string \| null` |
| `src/main/agents.ts` | Widened the local `AgentWorktrees` type; residue is logged on the exit row and raised through `onExitError` |
| `test/main/worktrees.test.ts` | Two cases through the real removal path, plus the two existing expectations updated |

## 3. Implementation approach

After `git worktree remove` succeeds and the prune runs, `sweepEmptyResidue`
looks at the path:

- gone → `null`, nothing to do;
- **empty** → `rmdirSync`, and `null`;
- **not empty** → left exactly as it is, and a sentence saying so.

The empty-only rule is the whole safety argument. By that point git has said the
worktree is gone *and* `state.clean` has already refused a dirty one, so an empty
directory is bookkeeping. Anything still inside is a file nobody accounted for,
and deleting it would be precisely the *"losing an agent's unpushed work to a
tidy-up"* that `git.ts` refuses by design — the same rule that keeps `--force`
out of the entire module.

A leftover that cannot be swept is **not** a failed removal: the worktree really
is gone. So `removed` stays `true` and the residue rides alongside it, is written
onto the `exit` log row, and is raised through `onExitError` so it is visible
rather than silent (invariant §7).

## 4. Verification

The two new cases drive the **real** removal path and make git behave the way it
behaved on this machine, by wrapping `ExecGitRunner` so that a successful
`worktree remove` re-creates the directory. Real git does every other step; only
the one observed behaviour is reproduced.

- *sweeps the empty directory git unregistered and left behind* — `residue: null`,
  and the path is gone.
- *leaves residue in place, and SAYS so, when a file is still in it* — the file is
  byte-identical afterwards and the residue names the count.

**Mutation: 6/6 killed** — the sweep removed entirely; the emptiness check
inverted (deleting a directory with files in it); a non-empty leftover reported
as clean; an absent directory reported as residue; the `rmdir` skipped while
still reporting success; and a path it cannot even list reported as tidy.

**The coverage gate caught a real dilution, and the fix was simplification.**
The first draft had two catches — "could not be read" and "could not be
deleted" — and `agora` fell below its floor because only one of them was
reachable from a test. They said the same actionable thing: the directory is
still there and this could not tidy it. So they became one. A branch that
exists in order to be uncovered is a branch that should not exist.

Gates: typecheck, lint, invariants, full suite, coverage floors.

The three real directories were cleared from the Architect's harness home after
confirming each held zero entries.

## 5. What the audit found and then refuted

Recorded because the method matters more than the finding.

The audit first reported that **the crew's spawn was missing from the book of
record**: no `event: 'spawned'` row exists for any crew agent (all 51 are
Artemis's), so a forensic reader could not answer *"did this hire run in its own
worktree, or in my checkout?"* — the exact question about the hazard M8.6 calls
the one item that can destroy the Architect's uncommitted work.

**It was wrong.** `kind: 'spawn'` rows carry no `event` field at all, so a survey
grouping by `event` cannot see them. There are **132** recording `cwd` for every
spawn, isolated or not, and **51** more carrying `worktree`, `branch`,
`branchCreated` and the source repo. The record was complete, and the proposed
fix would have added a second, worse copy of it.

Grouping by *shape* rather than by the expected field found it in one command:

```python
Counter(tuple(sorted(k for k in row if k not in ('ts', 'seq'))))
```

## 6. What the audit confirmed about M8.6

Three of the package's four decisions, verified from the machine:

- **The rung-3 stop outlives the exit and is load-bearing.**
  `~/.ephesus/breaker-stops.json` holds two, including a crew agent, and the log
  shows that stop refusing a *later* reactivation: `"will not be respawned — the
  breaker stopped it at rung 3 (burn-rate); clear the stop first"`.
- **Crew agents respawn** — `ci-babysitter` ×5, `verifier` ×3, against the
  register's own measurement of zero crew respawns.
- **The isolation refusal** releases the claimed id before throwing, and Artemis
  takes `blocked` from the same predicate rather than being exempt.

It also explained an apparent anomaly: one crew agent has an engine config and no
worktree. That is `health-watcher` — stopped at rung 3, worktree released on
death. The feature working, not a leak.

## 7. Related docs

- `docs/PROGRESS.md` — the M8.6 audit note
- `docs/adr/ADR-0004-agora-single-committer.md` — why `git.ts` is the only module that runs git
- `docs/implementations/2026-09-04-m8-6-crew-isolation-and-survival.md` — the package audited
