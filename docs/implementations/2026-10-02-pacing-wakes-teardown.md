# git's own housekeeping outlived `drained()` — the pacing-wakes teardown

**Date:** 2026-10-02 · **Branch:** `fix/pacing-wakes-teardown` from `origin/main`
`bb3e016`

---

## 1. Problem / motivation

`test/main/pacing-wakes.test.ts` failed once on linux CI, in its teardown, on a
branch that touched neither `src/`, nor that file, nor `test/tmpdir.ts`:

```text
FAIL  test/main/pacing-wakes.test.ts > the pace gates the stop-hook wake path (decideOnStop) > lets the turn end instead of buying another one while slow
Error: ENOTEMPTY: directory not empty, rmdir '/tmp/eph-pace-hFrNSG/agora/.git'
```

GitHub Actions run 36924116592, attempt 1 — branch `fix/eph-usage-coverage-10`,
commit `adaa6e8`, image ubuntu-24.04 `20260927.320.1`, **git 2.55.0**, Node
v20.20.2: 1 failed, 4632 passed, 15 skipped. The failing test took 2841 ms; its
seven git-backed siblings took 77–107 ms each. The same test passed on the same
production tree in run 36923589834 and on main's push run 34981836416. The
DECISIONS-LOG recorded it the day it happened (2026-10-01, #10) as out of that
change's scope — green on the rerun and on five further CI runs of the tree —
and left finding the writer as a follow-up. This is that follow-up.

The teardown stopped each Hermes, awaited `agora.drained()` behind a
`.catch(() => {})`, then called `fs.rmSync(dir, { recursive, force,
maxRetries: 10, retryDelay: 50 })`. Something was writing into `agora/.git`
after `drained()` had resolved, and the rest of this document is what that was.

## 2. The root cause

### 2.1 The writer: a detached `git repack`, started by our own commit

`git commit` ends by running git's housekeeping, `git maintenance run --auto`.
`prepare_auto_maintenance()` (git's `run-command.c`) passes it `--detach`
unless `maintenance.autoDetach` — falling back to `gc.autoDetach` — says
otherwise, and a detached maintenance **daemonizes** (fork, `setsid`, parent
exits; 2.55 takes its lock first) and carries on in a process whose parent is
no longer anything Node knows about. trace2 of a commit made with the runner's
flags, git 2.53.0 (`-q` here, hence `--quiet`; the Agora's own commits start
it with `--no-quiet`):

```text
child_start  ["git","maintenance","run","--auto","--quiet","--detach"]
```

What it carries on doing depends on the git version. **git 2.55's default
strategy for unscheduled maintenance is `geometric`** (`initialize_task_config`
in `builtin/gc.c`), whose detached-phase tasks are `commit-graph`,
`geometric-repack`, `worktree-prune` and `rerere-gc`. `geometric-repack` fires
when the approximate loose-object count exceeds 256 — and the approximation is
`256 × (loose objects in objects/17/)`, so **two loose objects whose ids start
`17` start a background repack** (§5.2). Forcing that condition shows the
difference between the two versions at hand:

```text
git 2.53.0: maintenance … --detach → region "detach" → exit        (nothing else)
git 2.55.0: maintenance … --detach → region "detach" → region "geometric-repack"
            child_start ["git","repack","-d","-l","--cruft","--cruft-expiration=2.weeks.ago","--quiet","--write-midx"]
            child_start ["git","pack-objects", … ".git/objects/pack/.tmp-…"]  ×2
            child_start ["git","multi-pack-index","write", …]
  commit exited at .227260; the repack's region closed at .234941
```

**Caught in the act.** An instrumented copy of the test (never committed) read
`/proc` at the moment `drained()` resolved, for every process whose working
directory was inside the temp dir. Linux (WSL2, 4 CPUs, four loops side by
side), git 2.55.0, Node v20.20.2, `bb3e016`, 1 600 git-backed teardowns:

| at the moment `drained()` resolved | teardowns |
|---|---|
| a git process still running in the directory | **8** |
| …`git maintenance run --auto --no-quiet --detach` | 8 |
| …`git repack -d -l --cruft … --write-midx` | 6 |
| …`git pack-objects … .git/objects/pack/.tmp-NNNN-pack` | 7 |
| `objects/maintenance.lock` held | 7 |

**The exact signature, on demand.** The trigger is chance, so it was forced
through git's own environment (`GIT_CONFIG_COUNT=1`,
`maintenance.geometric-repack.auto=-1`) — the same mechanism, made certain.
The unmodified file then failed 12 runs in 50, each failing test taking
~2.79 s, with the CI's message and two siblings of it:

```text
ENOTEMPTY: directory not empty, rmdir '/tmp/eph-pace-WUnme1/agora/.git'
ENOTEMPTY: directory not empty, rmdir '/tmp/eph-pace-NrtZse/agora/.git/objects/pack'
ENOTEMPTY: directory not empty, rmdir '/tmp/eph-pace-DdepKT/agora'
```

### 2.2 Why the delete spent its whole budget

Node 20's synchronous `rmSync` retries the `rmdir` of a directory whose
children it listed **once**; `maxRetries` never re-lists. One entry written
after the listing is never deleted, so every retry fails and the call throws
after the whole budget (§5.1) — whether or not the writer is still going. And
git recreates the directories it needs (`safe_create_leading_directories`), so
a repack can put back `objects/pack`, `objects` and even `.git` after they were
deleted, which is why the error names whichever level it resurrected.

### 2.3 The three suspects

- **The swallowed `.catch(() => {})`.** Not this failure: `drained()` cannot
  reject today — `drain()` catches every commit error and rejects the callers'
  promises instead — so the catch hid nothing here. It is removed anyway,
  because the day `drained()` can reject, it would read a failed drain as a
  finished one.
- **`drained()` resolving before the committer's last git child exits.** No.
  `execFile`'s callback fires on `close`, after the child has exited, and every
  `git` the committer started had. The writer is a *grandchild* that detached
  on purpose — nothing Node could have waited for.
- **A detached `git gc --auto` / maintenance.** Yes — §2.1.

### 2.4 Why only this file, and why now

**Only this file:** it was the one git-backed test that went on committing
after setup and deleted with `rmSync`'s own budget. `removeTempDir` lists the
tree afresh on every attempt and waits 10 s, which absorbs a short-lived
writer. `pacing-wakes.test.ts` was written on 2026-09-01 on a branch parallel
to the one that moved 54 files onto `removeTempDir` that same evening
(`021a4f5` is not a descendant of `39aad30`), so the sweep never saw it.
`incident-surface-wiring.test.ts` also deletes a git-backed home with a bare
`rmSync`, but its only commit is the seed, awaited at setup — exposed in
principle, and covered now that the housekeeping is part of that commit.

**Not "since git 2.55 arrived":** the two green runs had git 2.55.0 too (main's
on image `20260907.300.1`). The trigger needs two loose objects in one shard —
~0.5 % of this file's test repositories by measurement — and the failure needs
the repack to recreate something after the listing as well. Rare by
construction, which is why it was seen once.

## 3. What changed

| File | Change |
|---|---|
| `src/main/git.ts` | `IDENTITY_ARGS` gains `-c maintenance.autoDetach=false -c gc.autoDetach=false`, so the housekeeping a commit starts finishes inside the commit; `GitRunner.run`'s contract says so. |
| `src/main/agora.ts` | `drained()`'s contract states what idle now covers, and since when. |
| `test/main/agora.test.ts` | Regression test: a commit's housekeeping has finished — its pack is on disk — when `drained()` resolves. |
| `test/main/pacing-wakes.test.ts` | Teardown: stop → settle → drain (no `.catch`) → `removeTempDir`, the documented order and the house remover. |
| `test/tmpdir.ts` | Doc: ENOTEMPTY from a writer, and what no remover can do about one it has no handle on. Code unchanged. |
| `test/main/tmpdir.test.ts` | Two cases that run on every platform: `rmSync`'s budget lists once; `removeTempDir` lists every attempt. |
| `docs/sdd/SDD.md` | §10 "Git lock contention" row amended. |
| `docs/DECISIONS-LOG.md` | The choice of foreground housekeeping, and its cost. |

## 4. Implementation approach

**The fix is at the writer's owner, not at the remover.** No teardown can wait
for a process it has no handle on, and git's housekeeping, once detached, is
exactly that. So the commit is told not to detach it: `maintenance.autoDetach`
is git's documented switch (2.47+), and `gc.autoDetach` is the key it falls
back to and the one older git's `gc --auto` reads. With both set, `git commit`
waits for its own housekeeping, `ExecGitRunner.run()` resolves after it, and
`drained()` resolves after that — so once Hermes is stopped and settled, "the
queue is idle" means no git process the committer started is still running,
which is what serialising every git invocation through one queue (ADR-0004)
promised. One exception stays, and is stated where the contract is: a commit
the runner's 20 s timeout kills orphans its housekeeping exactly as before.

**The production call path** (ENGINEERING-STANDARDS §6.7): `index.ts:1096`
builds the Agora with no `git` option → `agora.ts:153` defaults to
`new ExecGitRunner()` → `git.ts:82` prepends `IDENTITY_ARGS` to every `git`
the committer runs. Production awaits a commit in two places: boot
(`ensureRepo()` and `reconcile()`, `index.ts:1123–1124`, before
`createWindow()` at `:3484`) and quit (the `agora-drain` step, `:3652`). The
regression test drives the same default runner.

**It is what Git for Windows already did.** `daemonize()` is unavailable there.
trace2 on this machine (2.53.0.windows.2) with a forced task: the maintenance
process entered and left its `detach` region in the same microsecond, ran the
task's children, exited at 29.053 — and `git commit` exited after it, at
29.058. The fix makes linux and macOS behave like the platform the Architect
runs.

**Why in `ExecGitRunner` and not on the commit call.** Global options must
precede the subcommand, and putting them into `args` breaks the implicit
`GitRunner` contract that `args[0]` is the subcommand — `agora.test.ts` injects
commit failures by matching `args[0] === 'commit'` (three places). The runner
already owns the global options for exactly this kind of reason (`commit.gpgsign`,
`core.hooksPath`: never let the machine's git config change what the harness's
git does). Of the commands the harness runs (`add commit init remote rev-parse
status worktree`) only `commit` starts maintenance (git's callers are `am`,
`commit`, `fetch`, `merge`, `rebase`, `receive-pack`), and `commit` only ever
runs in the Agora — so a target repository keeps git's defaults.

**The regression test summons the detached phase on purpose**, since the
natural trigger is chance: repository-local config switches the `loose-objects`
task on with an always-true condition (`maintenance.loose-objects.enabled=true`,
`.auto=-1`, honoured by 2.53 and 2.55 alike), pins `maintenance.auto=true` so
a developer's global "off" cannot make it vacuous, and sets
`maintenance.autoDetach=true` — a user who asked for detached housekeeping —
so the runner's command-line flag has to win over it. The commit carries one
`ROTATE_AT_BYTES` (4 MiB) blob of incompressible bytes — the size a live
`log.jsonl` reaches before it seals, so a blob the Agora genuinely commits.
After `commitSoon()` + `drained()` — the exact pattern the failing teardown
used — it asserts a finished pack (`.idx`, renamed into place last) exists.
It asserts the pack and **not** the lock, because measurement showed the lock
is not version-proof (§5.3). A red names which red: if no pack ever appears it
says the test proved nothing on this git; if one appears only later, it says
`drained()` resolved while the housekeeping was still packing.

**The teardown** takes the order `hermes.test.ts` documents and the remover the
rest of the suite uses. `hermes.settled()` is a no-op here today (nothing in
this file starts a background sweep) and is there so the next test that calls
`hermes.start()` inherits a correct teardown rather than a race.

**`removeTempDir` was checked, not changed.** It handles ENOTEMPTY from a live
writer correctly within its design: ENOTEMPTY is in `TRANSIENT`, and every
attempt lists the tree afresh, so a writer that stops inside the budget is
outlasted. What it cannot do is wait for a writer it has no handle on — on
linux an attempt can land between two writes and report success while the
writer runs on, and a writer that recreates its directories (git does) puts the
tree back afterwards (§5.4). That limit is now written in its header, with the
consequence: a teardown waits for its writers *before* calling it.

## 5. Mathematical / statistical details

### 5.1 `rmSync`'s retry budget

With `maxRetries = n` and `retryDelay = d`, Node 20's synchronous rimraf sleeps
`i·d` before retry `i + 1`, for `i = 1 … n`, so a directory that never empties
costs

```text
Σ_{i=1}^{n} i·d = d·n(n+1)/2 = 50 ms · 10·11/2 = 2 750 ms
```

The failing test measured 2 841 ms; 2 841 − 2 750 = 91 ms, inside the 77–107 ms
its git-backed siblings took. So the body ran normally and the teardown spent
the entire budget — the shape of an entry that appeared after the one listing,
not of a writer that was slow to stop. The remover probe of §5.4 reproduced
2 763–2 778 ms on linux (six runs) and 3 112–3 658 ms on win32 (nine).

### 5.2 How often the trigger fires

git 2.55's `geometric-repack` auto-condition, with its default limit 100:

```text
threshold  T = ⌈100 / 256⌉ · 256 = 256
estimate   L̂ = 256 · k,   k = number of loose objects in objects/17/
fires  ⇔  L̂ > T  ⇔  k ≥ 2
```

Object ids are uniform in their first byte, so for a repository holding `N`
loose objects `k ~ Binomial(N, p)` with `p = 1/256`, `q = 1 − p`:

```text
P(fire) = 1 − q^N − N·p·q^(N−1)
N = 10: 0.07 %    N = 20: 0.28 %    N = 30: 0.62 %    N = 40: 1.08 %
```

It is re-evaluated by every commit's housekeeping, so a test making a handful
of commits has several draws at a growing `N`. Measured rather than estimated:
8 of 1 600 teardowns had the repack still running at `drained()` before the
fix, and 7 of 1 600 test repositories had been repacked by the end of their
test after it — about 0.5 %.

### 5.3 The regression test's margin, and why it asserts the pack

Forced `loose-objects` task, incompressible blob, the old (detached) runner,
linux, 10 commits per row — what remained true right after the committer's
`git rev-parse HEAD`:

| | still running | lock held | pack missing |
|---|---|---|---|
| git 2.55.0, detached | 10/10 | 10/10 | 10/10 |
| git 2.55.0, foreground | 0/10 | 0/10 | 0/10 |
| git 2.53.0, detached | 10/10 | **0/10** | 10/10 |
| git 2.53.0, foreground | 0/10 | 0/10 | 0/10 |

The lock column is why the assertion is the pack: 2.53 does not hold the lock
through the detached phase, so "no lock" would pass on 2.53 with the defect in
place. Margin, git 2.55.0, 4 MiB: the detached repack outlived the commit by a
median 92 ms against a median 1.6 ms for the `rev-parse` that follows it — a
ratio of about 57.

### 5.4 Is a "0" after the fix evidence?

For the natural, loaded condition the before-rate of a live writer at
`drained()` was 8/1 600 = 0.5 %. If the fix changed nothing, the chance of
seeing **none** in 1 600 teardowns is

```text
(1 − 0.005)^1600 = e^{1600 · ln 0.995} ≈ e^{−8.0} ≈ 3 × 10⁻⁴
```

For the forced condition (12 failures in 50, p ≈ 0.24), the chance of 0 in the
100 runs after is `0.76^100 ≈ 10⁻¹²`. By the rule of three, 0/1 600 bounds the
remaining live-writer rate below ≈ 0.19 % at 95 % confidence; the mechanism
argument (§4) is what says it is zero.

The remover, with a writer adding a file every ~1 ms into a `.git` already
holding 2 000 entries, three runs per cell in the final revision of the probe
(the `rmSync` row ran in every revision — six runs on linux, nine on win32,
ENOTEMPTY each time):

| | linux v20.20.2 | win32 v20.16.0 |
|---|---|---|
| `rmSync` budget, writer stops at 1.5 s | ENOTEMPTY 3/3, after the writer stopped | ENOTEMPTY 3/3, after the writer stopped |
| `removeTempDir`, writer only adds | ok 3/3 (2–10 attempts), nothing left | ok 3/3 (5–6 attempts), nothing left |
| `removeTempDir`, writer recreates dirs | "ok" 3/3 **while the writer ran; tree back 3/3** | ok 3/3, returned after it stopped, nothing left |

## 6. Design decisions

1. **Foreground housekeeping, at the source — chosen.** Deterministic, git's
   documented configuration, cross-platform, and the behaviour Windows already
   had.
2. **A bigger `maxRetries` — rejected.** The budget never re-lists (§2.2), so
   a single late write defeats any number.
3. **The teardown waits for `objects/maintenance.lock` to go — rejected.**
   It reads git's internals, and on git 2.53 the lock is not held through the
   detached phase at all (§5.3): the wait would have been a no-op.
4. **Turn auto-maintenance off (`maintenance.auto=false`) — rejected.** The
   Agora is long-lived and every commit stores a fresh `log.jsonl` blob of up
   to 4 MiB; without housekeeping its object store grows without bound, the
   opposite of TEST-STRATEGY §7's "Agora repo growth linear with events".
5. **Set the config only in tests (`GIT_CONFIG_*` in global setup) —
   rejected.** The suite would stop exercising production's git, and
   production's `drained()` — the shutdown sequence's `agora-drain` step —
   would keep resolving with git still writing the Agora.
6. **The cost, measured and accepted — the one call worth an Architect's
   second look.** On linux and macOS a commit now waits for its own
   housekeeping. Measured on a production-shaped Agora — commits of a live
   log grown to 4.1 MB, no packs, the shape the 2026-09-07 DECISIONS-LOG entry
   recorded (2 547 loose objects) — in WSL2 on this machine, one run per row:

   | git, repository | commit with the fix's flags |
   |---|---|
   | 2.55.0, 400 commits, 3 200 loose / 58 MB — first housekeeping (commit-graph + all-into-one repack → one 2.2 MB pack) | 2 799 ms |
   | 2.55.0, 60 commits later — incremental geometric repack | 348 ms |
   | 2.53.0, 400 commits, 3 200 loose — below `gc --auto`'s 6 700 | 50 ms, no housekeeping |
   | 2.53.0, 900 commits, 7 201 loose / 129 MB — full `gc` | 15 456 ms |

   Delivery is unaffected — it is a rename, and durability is the commit
   (ADR-0004) — and commits batch while one runs. Two places do wait: boot,
   when `reconcile()` lands a commit that crosses a threshold
   (`index.ts:1123–1124`, before the window opens), and quit, in
   `agora-drain` (`:3652`). The 2.55 first row is once per Agora, when git
   2.55 first meets one never packed. The last row recurs every ~850 commits
   on git older than 2.55, close enough to the runner's 20 s timeout that a
   slower machine will reach it: the commit has landed by then, so the
   queue's retry finds a clean tree and succeeds, and the orphaned `gc`
   finishes on its own — as it always did. This is the profile Windows
   production already has, because Git for Windows cannot detach. If the boot
   stall ever matters, the two boot commits could skip housekeeping and leave
   it to the next ordinary commit; that is not done here.
7. **The regression test is blind on Windows, and says so** in its own
   comment: Git for Windows cannot detach, so it passes there with or without
   the fix. It has teeth where CI runs.
8. **`gc.autoDetach=false` stays, although no test here can kill its
   removal.** git 2.47 and later read `maintenance.autoDetach` first and never
   consult `gc.autoDetach` while it is set, so on both gits measured the
   mutant that cuts only that pair survives by construction (§7.2). It is for
   older git, whose `gc --auto` reads it — a git these machines do not run.
   Recorded as a survivor, not counted as coverage.

**Not done here, and why** — each is out of this package's scope and worth
its own:

- Eleven teardowns in `test/main` and five sites in `test/scenarios` still
  write `drained().catch(…)`.
- `temp-hygiene.test.ts` accepts any `rmSync(` as a remover, so a new
  git-backed file can reintroduce the single-listing budget the way this one
  did.
- Test helpers that run `git commit` directly through `execFileSync`
  (`worktrees.test.ts`, `agent-worktree.test.ts`, `check-attribution.test.ts`)
  bypass `ExecGitRunner`, so their housekeeping can still detach on POSIX.
  They remove through `removeTempDir`, so the likely result is a rare leaked
  directory (§5.4), not a failure.
- A machine whose global git config turns on `core.fsmonitor` would have git
  start its fsmonitor daemon, which outlives a call by design.
  `IDENTITY_ARGS` does not neutralise it, and nothing here has observed it.

## 7. Verification

Linux runs used a clone of `bb3e016` in WSL2 (Ubuntu 26.04, kernel
6.6.114.1), Node v20.20.2 — the CI's — and git 2.55.0 built from the
checksum-verified kernel.org tarball with `NO_RUST=1`, beside the
distribution's git 2.53.0. `NO_RUST` swaps git's optional Rust parts for C
fallbacks; the maintenance, repack and pack-objects code exercised here is C
either way. That build is a condition of these numbers, not CI's own binary.

### 7.1 Before and after

| Condition | Tree | Runs | Passed |
|---|---|---|---|
| natural, idle, git 2.53.0 | `bb3e016` | 50 | 50 |
| natural, idle, git 2.55.0 | `bb3e016` | 50 | 50 |
| natural, idle, git 2.55.0 | branch | 50 | 50 |
| natural, 4 loops on 4 CPUs, git 2.55.0, probe | `bb3e016` | 200 (1 600 teardowns) | 200 — but 8 live writers at `drained()` |
| natural, 4 loops on 4 CPUs, git 2.55.0, probe | branch | 200 (1 600 teardowns) | 200 — 0 live writers; 7 repacks, all finished inside their commit |
| trigger forced, git 2.55.0 | `bb3e016` | 50 | **38** (12 × ENOTEMPTY) |
| trigger forced, git 2.55.0 | fix only (original teardown) | 50 | **50** |
| trigger forced, git 2.55.0 | branch | 50 | **50** |

The natural condition never produced the ENOTEMPTY in these samples (it needs
the second race of §2.2); it produced the writer. The forced condition
produced the failure itself. Both moved to zero.

### 7.2 Mutation rounds, each with a control

Regression test, 20 runs per tree, linux, each tree named by its `git.ts`
sha256 prefix:

| tree | git 2.55.0 | git 2.53.0 |
|---|---|---|
| fixed (`381d86db…`) | 20/20 pass | 20/20 pass |
| control, a no-op edit to `git.ts` (`9dc234c5…`) | 20/20 pass | 20/20 pass |
| both `-c` pairs cut (`a57adefb…`) | 20/20 killed | 20/20 killed |
| only `maintenance.autoDetach=false` cut (`57d5e0f5…`) | 20/20 killed | 20/20 killed |
| only `gc.autoDetach=false` cut (`64e491a8…`) | survived 20/20 | survived 20/20 |

Every kill read *"drained() resolved while the housekeeping the commit started
was still packing"*. The single-pair kill is owed to the test's own
`maintenance.autoDetach=true`: without it, either pair alone keeps git 2.47+
in the foreground and that mutant survived too (an earlier revision of the
test, found by review). The last survivor is decision 8 — expected, and
recorded rather than counted.

`removeTempDir` cases, linux: stable 30/30; control 10/10; mutant A
(`ENOTEMPTY` dropped from `TRANSIENT`) 10/10 killed; mutant B (`removeTempDir`
reduced to `rmSync`'s own budget) 10/10 killed.

### 7.3 To re-run

```bash
npx vitest run test/main/agora.test.ts -t "does not resolve while git maintenance"
```

On linux with git ≥ 2.55, the CI failure on demand — red on `bb3e016`, green
on this branch:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.geometric-repack.auto GIT_CONFIG_VALUE_0=-1 npx vitest run test/main/pacing-wakes.test.ts
```

The gate, as BUILD-PROMPT §4 runs it:

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs
```

### 7.4 The gate on this branch

On the final tree — this branch rebased onto `cab9e1b`, the `main` that
landed while it was in flight — each platform once:

| Step | linux — WSL ext4, git 2.55.0, Node v20.20.2 | win32 — this machine, git 2.53.0.windows.2, Node v20.16.0 |
|---|---|---|
| `npm run typecheck` | 0 | 0 |
| `npm run lint` | 0 | 0 |
| `node scripts/check-invariants.cjs` | 0 | 0 |
| `npm run test:coverage` | 0 — 237 files, 4 637 passed, 14 skipped | 0 — 237 files, 4 643 passed, 8 skipped |
| `node scripts/check-coverage.cjs` | 0 — 17 subsystems on linux | 0 — 17 subsystems on win32 |

Before the rebase, the same gate was green on both platforms on `bb3e016`
plus this change (236 files; `npm test` on win32 too), with three runs not
counted, each for a stated reason. Two win32 coverage attempts exited 1 from
the v8 provider's `rmdir 'coverage\.tmp'` losing to OneDrive's file handle —
the environmental failure the 2026-09-10 DECISIONS-LOG entry records — once
at teardown after all 236 files had passed, and once at startup on the
directory the first had left, before any test ran; removing the stale,
git-ignored `coverage/` let the next run through. One `npm test` attempt was
refused by the suite's own memory guard (0.69 GB free while the WSL VM was
resident) and ran nothing. And the first linux run after the rebase is
discarded: its setup could not fetch `cab9e1b` (the 2.55 build has no https
transport), so it ran on `bb3e016` without this change — caught by the base
and changed-file count the script prints, and rerun with a setup that fails
hard.

## 8. Related docs

- [ADR-0004 — the single committer](../adr/ADR-0004-agora-single-committer.md)
- [SDD §10 — error handling & recovery invariants](../sdd/SDD.md)
- [TEST-STRATEGY §2 — real fs and real git in temp dirs](../TEST-STRATEGY.md)
- [ENGINEERING-STANDARDS §6 — Definition of Done](../ENGINEERING-STANDARDS.md)
- [2026-09-01 — the flaky temp-dir teardown](2026-09-01-flaky-temp-dir-teardown.md),
  which introduced `removeTempDir` and the stop → settle → drain order
