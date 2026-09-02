# The flaky temp-dir teardown — a git child sitting in the directory we were deleting

## Problem / motivation

The suite failed differently on every run: full-suite failure counts of 202,
75, 62, 33 and 12 were all observed on the *same* tree. That made the suite
useless as a gate — a real regression was indistinguishable from noise, and the
previous work package had to separate the two by re-running every affected file
in isolation.

Filtering a full run for filesystem errors gave an unusually clean signal.
Every single one was the same shape:

```text
EBUSY: resource busy or locked, rmdir '…\eph-brief-cTOsD5\agora'
EBUSY: resource busy or locked, rmdir '…\eph-worktree-MK6hJ6\target-repo'
EBUSY: resource busy or locked, rmdir '…\eph-scenario-xY8h0q\repo-mason'
```

Never a file. Never a write. Always `rmdir`, and always on a directory a `git`
command had been run in.

## What changed

| File | Change |
|---|---|
| `test/tmpdir.ts` | New. `removeTempDir()` — the one temp-directory remover, with a retry that actually retries and a bounded budget. |
| `test/main/tmpdir.test.ts` | New. Reproduces the pin deterministically and locks down the `rmSync` measurement that decided the implementation. |
| `src/main/hermes.ts` | New `Hermes.settled()` — resolves once an in-flight sweep has finished, without starting one. |
| `test/main/hermes.test.ts` | Three tests for the `settled()` contract; rig teardown now stops → settles → drains. |
| `test/scenarios/company.ts` | `close()` settles before draining; `cleanupHomes()` uses the shared remover. |
| `vitest.config.mts` | `testTimeout`/`hookTimeout` raised from the 5 s default to 30 s. |
| 54 other test files | The duplicated `fs.rmSync(dir, …)` teardown replaced by `removeTempDir(dir)`. |

## Implementation approach

### Finding the cause: three wrong guesses, then a probe

Guessing was cheap and wrong three times. Each wrong guess is recorded because
each is the obvious answer, and a reader who reaches for one should know it was
tried:

1. **"A git child holds its cwd."** Right in the end, but the first repro —
   `git init`/`add`/`commit` then `rmSync`, 25 iterations — failed 0/25.
2. **"Transient Windows sharing violations under write load."** 2400
   write-then-rename cycles and 15 build-then-remove cycles: 0 failures.
3. **"Parallelism is the missing ingredient."** Ten concurrent worker processes
   doing git-then-remove, 120 iterations: 0 failures.

So the mechanism was instrumented instead of guessed. A temporary probe replaced
the failing `rmSync` with a hand-written post-order walk that deleted every entry
individually and reported which paths refused:

```text
=== BUSY-PROBE C:\…\eph-scenario-qXZwHn ===
DIR  C:\…\eph-scenario-qXZwHn\agora :: EBUSY
```

**Every file and every subdirectory deleted cleanly. Only the repository root
refused.** A directory that is locked while all of its contents are deletable is
not a file-locking problem — it is an open *directory* handle, and the ordinary
way to hold one without holding anything inside it is to have it as a process's
current working directory.

A control confirmed it exactly. Park a child process with `cwd` set to a
directory, delete around it, and the signature reproduces precisely — and the
directory becomes removable the instant that child exits:

```text
with a child cwd-ed into agora: [ 'DIR agora EBUSY' ]
after the child exits: removed cleanly
```

`src/main/git.ts` runs every git command as
`execFile('git', args, { cwd: <repo> })`. On Windows that makes each git child a
lock on the repository directory for as long as it lives. `agora`,
`target-repo`, `repo-mason` and `not-a-repo` are exactly the directories git is
run in, which is why those and nothing else appeared in the error inventory.

### Fix 1 — quiesce in the right order: stop, settle, then drain

`Company.close()` stopped Hermes and then drained the Agora commit queue. But
`Hermes.stop()` only clears the timers and watchers; a sweep *already running*
keeps going, and a sweep ends by calling `agora.commitSoon()`. So draining
drained a queue the sweep was about to add to — and the git child that late
commit starts was still alive when `cleanupHomes()` deleted the directory it was
running in.

`Hermes.settled()` is the missing middle step. It awaits the in-flight sweep and
deliberately does **not** start one: a shutdown must not deliver mail nobody
asked it to deliver. It absorbs the in-flight sweep's failure, because
`onSweepError` has already reported it and an unhandled rejection at shutdown
would take the process down at the worst possible moment.

### Fix 2 — a remover that actually retries

The first version of `removeTempDir()` was nothing but a bigger
`maxRetries`/`retryDelay`, on the strength of the `fs.rmSync` documentation:
`EBUSY` is "retried with a linear backoff wait of retryDelay milliseconds longer
on each try". That reads as 10 × 50 ms ≈ 2.75 s of patience.

Measured on node v20.16.0 against a confirmed pin, it is not patient at all:

| options | result |
|---|---|
| `maxRetries: 10, retryDelay: 50` | EBUSY after **3 ms** |
| `maxRetries: 20, retryDelay: 50` | EBUSY after **1 ms** |
| `maxRetries: 20, retryDelay: 100` | EBUSY after **1 ms** |

It gives up in milliseconds whatever it is told, and leaves the contents in
place. **The budget every teardown in this suite was passing had no effect
whatsoever** — which also means the first version of this fix fixed nothing, and
the A/B that appeared to validate it was really measuring Fix 1.

So the retry is written out explicitly, with `Atomics.wait` for the sleep
because teardown hooks are commonly synchronous, and a 10 s ceiling.
`tmpdir.test.ts` asserts the measurement, so if a future node honours its own
budget the test fails and this helper can go back to being a config change.

The wait is legitimate rather than a paper-over: what it waits for is a process
exiting, which it will. And it still throws when the directory is genuinely
unremovable, because a teardown that cannot clean up after a fair wait is a leak
— a process nobody shut down — and swallowing it would trade a flaky suite for a
silent one.

### Fix 3 — a timeout that was measuring the wrong thing

The teardown was never the largest source of noise. Categorising a run's
failures put `EBUSY` at 1–2 and `Test timed out in 5000ms` at 4–5, rising to
**87** under heavy load. Those timeouts were concentrated in two files:
S-LIVELOCK (ping-pong to the hop cap) and S-STOPLOOP (continuations to the block
cap) — the two scenarios whose shape is "loop many message round trips", each
round trip paying for a real git child.

Run alone on an idle machine, `honours the hard block cap even though the mail
never goes away` takes **8.8 s**. The default budget is 5 s. That is not a hang
being caught; it is a threshold set below the work the test does.

A timeout exists to catch a hang, not to fail work that is merely slow. 30 s
keeps that job — a stuck test still fails, just later — with honest headroom on a
loaded Windows machine.

## Design decisions

**Why not stop pinning the directory at the source.** *(This was attempted
afterwards — running git from a neutral cwd with `--git-dir`/`--work-tree` — and
REVERTED, because it does not work: git chdirs into its `--work-tree`, so the
pin moves from the cwd we passed to the work tree rather than disappearing, and
at every call site here those are the same directory. Measured with 8 concurrent
`git status` processes against an empty work tree, git's own cwd elsewhere:
`EBUSY` on the work-tree directory, and no error on a bystander directory git
was not using. For any command that has a work tree — `add`, `commit`, `status`,
which is nearly all of them — the pin is unavoidable, so the waiting below is
not a stopgap under a better fix. It is the fix.)* The structural fix is to stop giving git the repository as its
`cwd` — `--git-dir`/`--work-tree` from a neutral directory — which would make
the pin impossible in production too. Not done here: it changes the semantics of every git invocation in the
app (pathspec resolution for `add -A`, `init`, `worktree add`) to fix a symptom
that only appears in test teardown. Production degrades gracefully today —
`GitWorktrees.remove()` lets *git* do the removal and surfaces git's own error —
so the exposure there is a visible refusal, not corruption. Recorded with the
evidence rather than acted on.

**One helper, not 58 call sites.** 38 of the existing teardowns had no retry at
all and 15 had one that does nothing; the inconsistency was itself the bug
surface. Only bare temp-directory identifiers were converted — deliberate
in-test deletions (archiving an agent's mailbox, clearing a lock) keep their
explicit `fs.rmSync`, because there the removal *is* the thing under test.

**A budget, not "retry forever".** Ten seconds is far more than a git child needs
and far less than a hung suite. Past it, the failure is real and is reported.

## Verification

```bash
npx vitest run test/main/tmpdir.test.ts test/main/hermes.test.ts
```

### Effect, measured

Full suite, same machine, back to back:

| | failures | spread |
|---|---|---|
| before | 202 / 75 / 62 / 33 / 12 | wildly variable |
| after | 12 / 11 | stable, and the same tests each time |

`EBUSY` occurrences went to **0** in every run after the fix.

Every one of the 11 stable failures was shown to be **independent of this
change** by checking the same files out at `cef76e0` and re-running: they
reproduce test for test on the base tree. None is a timeout or a teardown error,
which is what this change is accountable for.

### A correction: these failures were real bugs, not this machine

This section originally called the failures below "known-unrelated" and
"pre-existing", and told the reader not to chase a red suite here. **That was
wrong, and the reasoning error is worth naming.**

The evidence was that each failure reproduced test-for-test with the same files
checked out at the base commit. That is sound evidence for exactly one claim —
*this change did not cause them* — and it is the claim the gate needed. It is
not evidence that the cause is environmental, and reading it that way turned
"independent of my change" into "nobody's bug", which is a much stronger and
much less supportable statement.

Every one was a real defect, found afterwards by other sessions:

| Failure | Actual cause |
|---|---|
| `agent-worktree` ×4, `s-crash` ×3 | `probeVersion` ran with `shell: true` and never quoted the command, so `C:\Program Files\nodejs\node.exe` executed as `C:\Program`. The probe returned null, spawn took the FR-1.6 install branch and parked at `installing`. Fixed in `fb48887`. |
| `hires-exchange`, `s-profile` | Stale assertions against the loosened skeleton-crew profile. |
| `renderer/emotes` | `.gitignore` excludes the LimeZu art wholesale and allowlists our own manifests back in — but the exception list had `*.tiles.json` and `*.chars.json` and never gained `*.emotes.json`. Our own emote table was ignored along with the art it indexes and never committed. Fixed in `a151ae6`; it was never a missing generator step, and `npm run typecheck` is runnable again. |
| `shared/cost` | Timezone, not an unknown. `dayKey` reads LOCAL calendar fields by design, and the test straddled UTC midnight, so at UTC+3 both instants fall on the same local day. |

Verified from this worktree: `limezu.emotes.json` is tracked on the integration
branch, and `fb48887` is an ancestor of it. The `shared/cost` fix was reported
as verified but not yet committed, so it should not be counted as landed.

The guidance this section used to give — that a red suite here is not worth
chasing — is now the opposite of correct.

### MUTATION-CHECK

| # | Mutation | Expected red | Observed |
|---|---|---|---|
| M1 | `removeTempDir` reverts to `rmSync`'s own budget | "waits the pin out" | 1 failed |
| M2 | `EBUSY` dropped from the transient set | "waits the pin out" | 1 failed |
| M3 | budget cut to 1 s | "waits the pin out" + "long enough" | 2 failed |
| M4 | `settled()` resolves immediately | "only once a sweep in flight has finished" | 1 failed |
| M5 | `settled()` sweeps instead of settling | "starts no sweep of its own" | 1 failed |
| M6 | `settled()` lets a failed sweep reject | "resolves rather than rejecting" | 1 failed |

### Three defects in the new tests, found and fixed

Worth recording, because each made a test pass or fail for the wrong reason —
and the last one meant this change briefly *added* flakiness while removing it.

1. **The pin was not established when the assertion ran.** `spawn()` returns
   before the process exists, so one case removed its "pinned" directory in
   31 ms. Awaiting the `spawn` event is better but still only pins 9 times in
   10 — measured. The helper now waits for a flag the child writes once its own
   JS is running, which measured **20/20**.
2. **A probe that proved nothing.** An attempt to detect the pin by renaming the
   directory always reported "not pinned": Windows permits *renaming* a
   directory that is a process's cwd, and only refuses to *delete* it. The
   probe had been silently consuming the entire pin duration.
3. **The new tests were themselves load-sensitive.** The first draft asserted
   wall-clock bounds (`< 1000 ms`), which passed in isolation and failed 1–3
   times per full-suite run. Every timing assertion now measures against the pin
   — a real event — or is dropped in favour of a logical proof: a budget that
   outlasts the pin would have *succeeded*, so the throw is itself the evidence.

## Related docs

- `docs/TEST-STRATEGY.md` §2 — real fs and real git in temp dirs
- `docs/adr/ADR-0004` — the single committer, and why only main runs git
- `src/main/git.ts` — the one place that runs git, and the `cwd` this is about
