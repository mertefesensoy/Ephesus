# The shims run `main()` only when they are the program, and all four prove it from outside a process

Every dependency-free program under `shims/` ends in a guard that calls `main()`
only when the file is the program, so that a test can import its helpers. The
guards matched a file-name *suffix*, so an importer whose own name merely ended
in a shim's ran that shim's `main()` on import. And for three of the four, nothing
tested the import side at all. This change makes all four compare the whole file
name, and holds each one from outside a process. A file that is not the shim
imports it, with everything `main()` would act on and a live endpoint, and must
run nothing — not even a stdin read that takes nothing. It was recorded as one
follow-up on 2026-10-01 (DECISIONS-LOG, "A GUARD TESTED FROM OUTSIDE A PROCESS").

## 1. Problem / motivation

**The guard was a suffix match.** All four shims ended in

```js
if (process.argv[1] && process.argv[1].endsWith('eph-hook.mjs')) { main()… }
```

so an importer named `x-eph-hook.mjs` was taken for the shim. Run against the
unchanged guards, each shim's new `x-<shim>.mjs` case failed on a real side effect
of the `main()` it ran:

| Shim | What a file named `x-<shim>.mjs` did by importing it |
|---|---|
| `eph-hook` | attached a reader to its stdin (`readableFlowing` became `true`) to read the engine payload, then posted it |
| `eph-recall` | asked the Library and printed `recall: 1 result(s) for "flaky checkout"…` |
| `eph-gh-token` | fetched a GitHub credential and printed it on stdout |
| `eph-usage` | printed its status line, `5h 12%` |

**Three import sides were untested.** A mutation round against the tests as they
stood (§4) found that the guards of `eph-hook`, `eph-recall` and `eph-gh-token`
could be replaced by `if (true)` without failing a single test. For `eph-recall`
and `eph-gh-token` the vitest *run* still went red, but by accident: `main()` ran
inside the worker that imported the shim, took its own `process.exit(1)` path on
that worker's arguments and environment, and vitest refuses an unexpected exit.
`eph-hook` fails open and never exits, so the same mutants went through a green
run. And `eph-gh-token`'s guard could be replaced by `if (false)`, because no test
ran that shim as a program at all.

**One stray read was invisible even where the import side was tested.** #10's
`eph-usage` test asserts that importing leaves `process.stdin.readableFlowing` at
`null` and every byte of stdin unread. A bare `process.stdin.read()` at module
scope passes both. It takes no data from the stream, but it starts a read on the
process's stdin, and a pending read keeps a process alive until stdin ends.

**Nothing held the guard's first half.** Review of this change found that
deleting `process.argv[1] &&` passed every test, because every importer file,
program run and vitest worker has an `argv[1]`. Only an import whose `argv[1]` is
undefined — `node -e` with no arguments, or a REPL — would crash on
`path.basename(undefined)`.

**When this work began, `main` carried three of the four guards.** On `main` at
`bb3e016`, `shims/eph-usage.mjs` ended in an unconditional `main().catch(…)`. Its
guard and its import test came with #10's unmerged branch,
`fix/eph-usage-coverage-10`. So the Architect chose to stack this branch on that
branch's head, `60062b4`, and all four guards change together. While the work was
in flight, #60 was squash-merged as `cab9e1b`, with code, tests and coverage
floors byte-identical to `60062b4`'s. The Architect then chose to merge `main`
into this branch and resolve the four conflicts here. Both decisions are in
DECISIONS-LOG, 2026-10-02.

## 2. What changed

| File | Change |
|---|---|
| `shims/eph-hook.mjs` | The guard compares `path.basename(process.argv[1])` with `'eph-hook.mjs'`; imports `node:path`. |
| `shims/eph-recall.mjs` | The same, for `'eph-recall.mjs'`. |
| `shims/eph-gh-token.mjs` | The same, for `'eph-gh-token.mjs'`. |
| `shims/eph-usage.mjs` | The same, for `'eph-usage.mjs'` (it already imported `node:path`). |
| `test/shims/importer.ts` | New. `runImporter` imports a shim from a named importer file in a child process and reports exit code, stdout, stderr, `readableFlowing`, the stdin left unread, and the exit code of the same import with stdin never ended (`importWithStdinOpen`). `importWithoutModulePath` imports it from `node -e` with no arguments. |
| `test/shims/eph-hook.test.ts` | `eph-hook — importing it`: two importer cases against a live hook stub, and the `node -e` case. |
| `test/shims/eph-recall.test.ts` | The rig counts recall requests; `eph-recall — importing it`: two importer cases against a real `HookServer` and `Library`, and the `node -e` case. |
| `test/shims/eph-gh-token.test.ts` | New. `eph-gh-token — as an agent runs it` (four cases: the token alone, `--json`, the harness's own refusal, outside a spawn) and `eph-gh-token — importing it` (two importer cases and the `node -e` case), against a real `HookServer`. Its `runShim` strips `NODE_OPTIONS`, because one case holds stderr to be empty. |
| `test/shims/eph-usage.test.ts` | #10's import test gains the `x-eph-usage.mjs` case, the held-open import and a positive control, and the describe gains the `node -e` case. |
| `docs/DECISIONS-LOG.md` | Eight entries, 2026-10-02: the stacked base, the asynchronous spawn, the guard's form and its residual, the held-open import, what the before round found, two conditions that voided mutation runs, merging `main` in once #60 had merged, and pinning the guard's first operand. |
| `docs/implementations/2026-10-02-shim-import-guards.md` | This document. |

No file under `src/` changed, and no coverage floor moved (§6).

## 3. Implementation approach

### The guard

```js
// Only run when executed as a program; importing it for tests must not post.
// The whole file name is compared: a suffix also matches `x-eph-hook.mjs`.
if (process.argv[1] && path.basename(process.argv[1]) === 'eph-hook.mjs') {
```

`node:path` is a built-in, so every shim stays dependency-free. Node sets
`process.argv[1]` to the absolute path of the program it was asked to run, and
every production call path asks it to run the shim's own file:

| Shim | What its header cites | How production starts it |
|---|---|---|
| `eph-hook.mjs` | SDD §1, FR-2.1, NFR-12, ADR-0009, ADR-0013 | `src/main/index.ts:1442` passes `path.join(appRoot, 'shims', 'eph-hook.mjs')`; `src/main/engines/claude.ts:836` writes `node "<that path>" --event …` into the engine's hook settings |
| `eph-recall.mjs` | ADR-0006 layer 2 | `src/main/index.ts:1518` (the boot probe) and `:2383` (`EPH_RECALL`): `shellCommand(process.execPath, <shims/eph-recall.mjs>)` → `"<node>" "<path>"` |
| `eph-gh-token.mjs` | ADR-0022 | `src/main/index.ts:2384` (`EPH_GH_TOKEN`): `"<node>" "<shims/eph-gh-token.mjs>"` |
| `eph-usage.mjs` | ADR-0023 | `src/main/index.ts:1446`; `src/main/engines/claude.ts:885-891` writes `node "<path>" --dir "<dir>"` as the engine's `statusLine` |

So `argv[1]`'s base name is the shim's on every production path, and the spawn
suites prove it from the other side: replaced by `if (false)`, each guard fails
the spawn tests that expect its shim to act (§4).

The guard's first half stays, and is now tested. Under `node -e` with no
arguments, or in a REPL, there is no module path in `argv[1]`, and
`path.basename(undefined)` throws, which would turn such an import into a crash.

| `process.argv[1]` | Suffix match (before) | Whole name (after) |
|---|---|---|
| `…/shims/eph-hook.mjs` — every production path | runs `main()` | runs `main()` |
| `…/x-eph-hook.mjs` — an importer | **runs `main()`** | nothing |
| `…/importer.mjs` — an importer | nothing | nothing |
| undefined — `node -e` with no arguments, a REPL | nothing | nothing (held by the `node -e` case) |
| `…/elsewhere/eph-hook.mjs` — an importer *named* like the shim | runs `main()` | runs `main()` (the residual, §5) |

### What an import test observes

`runImporter` (`test/shims/importer.ts`) writes an importer file into an `eph-`
temp directory, removed with `removeTempDir`, and runs `node <importer> <args>`
with the shim's environment and `input` on stdin. After `await import(<shim>)`
settles, the importer records `String(process.stdin.readableFlowing)` and then
reads its stdin to the end itself. Each test then asserts:

| Observation | Expected | What it rules out |
|---|---|---|
| exit code | `0` | a stray `process.exit`, or a hang killed at the 10 s timeout |
| stdout | `''` | a printed answer, credential, decision or status line |
| stderr | `''` | a refusal, a fail-open complaint, any stray write |
| `readableFlowing` | `'null'` | a reader attached to stdin, or the stream resumed |
| stdin left unread | the whole input | any of stdin taken |
| the same import with stdin never ended | exits `0` by itself | a read started on stdin, even one that took nothing |
| requests the endpoint received | `0` | a stray `main()` that really posted (`eph-hook`), asked (`eph-recall`) or fetched (`eph-gh-token`); for `eph-usage`, no report directory |

The importer is handed everything `main()` acts on. `eph-hook` gets an event,
field maps and a Claude payload, and `eph-recall` gets a query, each with the
environment of a live spawn whose endpoint answers. `eph-gh-token` gets that
environment alone, and `eph-usage` gets a status document, `--dir` and an agent
id. So a guard that let `main()` run would really act. Each test then
ends with a **positive control**: the same arguments, environment and input, run
as the program, must act against the same endpoint — post one envelope, reach the
Library once, fetch one credential, write the report. Without it, "nothing
arrived" could pass merely because the inputs had gone stale.

Each case runs twice, as `importer.mjs` and as `x-<shim>.mjs`. Only the second
tells a whole-name comparison from a suffix one.

The importer is a file, not `node -e`. Under `-e`, `argv[1]` is never a module
path, so the comparison the guard really makes would never happen. That is also
why one more case per shim uses `-e` on purpose. `importWithoutModulePath` runs
`node --input-type=module -e "await import(<shim>)"` with no arguments, which
leaves `argv[1]` undefined, and requires exit 0 with nothing on stdout or stderr.
It holds the guard's first half, which every other test passes with or without.

### Why the spawn is asynchronous here, and synchronous for `eph-usage`

The endpoint a stray `eph-hook`, `eph-recall` or `eph-gh-token` would call is
served by the vitest worker itself. `spawnSync` blocks the event loop that serves
it, so a stray request could only be received after the child had gone, and "no
request arrived" would be read before the server could have seen one. With an
asynchronous spawn the endpoint answers while the importer runs. `eph-usage`
talks to nobody, so #10's `spawnSync` stays; only the held-open import is
asynchronous there too.

### The held-open import

`importWithStdinOpen` repeats the import with the same input written to stdin and
never ended, and resolves to the importer's exit code. An import that started no
read lets the importer exit as soon as it settles. A read pending on stdin, even
one that took nothing, keeps the process alive until it is killed at the timeout.
Measured outside the repository on node v20.16.0, an importer of a module that
touches nothing exited by itself in 230–340 ms. An importer of a module whose
only statement was `process.stdin.read()` was killed at a 3 s timeout, 2 of 2
times. `runImporter` performs it on every call, and `eph-usage`'s test calls it
directly.

## 4. Mathematical / statistical details

**Scoring.** A mutant replaces or inserts one expression in one shim, and vitest
runs the files that import or execute that shim. Those are the only files that
can observe a guard, and none other does (`grep` over `test/`: the fake engine
uses `hook-client.mjs`, and the adapter tests use shim paths as strings). It is
**killed** when the run reports a failing test or an unhandled error; it
**survives** when the run exits 0 with every test passed; and the run is
**INVALID**, never a kill, when no test executed. Each round's no-op control (a
comment) must survive, or the round says nothing.

**Condition.** Windows_NT 10.0.26200, node v20.16.0, vitest 4.1.11, a detached
worktree under `%TEMP%` (not synced by OneDrive) with the dependency tree linked,
every round file hashed before and after every run, and the run held until at
least 1.25 GB was free (the suite's own gate is 1.0 GB). Each run's free memory
is in the round's summary. Before: `60062b4`, 28 mutants, 0 invalid, 11 killed,
17 survived. After: `174afdb`, 36 mutants. That is nine kinds per shim: the
seven above, the old suffix match, and the first half deleted. There were 0
invalid and 32 killed, and the 4 survivors are the four controls. A round at
`7f9a810`, before the `node -e` cases, gave the same verdicts for its 32 mutants
(every kind but the last). Every file was restored and verified by hash, and
`git status` was clean after each round. In the before round, `eph-recall`'s and
`eph-gh-token`'s `if (true)` and `if (process.argv[1])` runs (four of the eleven
kills) are counted as killed by exit code, though no test failed (the footnote
below).

**Before** — the tests as they stood on `60062b4`:

| Mutant | `eph-hook` | `eph-recall` | `eph-gh-token` | `eph-usage` (#10's test) |
|---|---|---|---|---|
| no-op control | survived (33/33) | survived (12/12) | survived (7/7) | survived (46/46) |
| guard → `if (true)` | **survived** (33/33) | 12/12 pass, run exits 1* | 7/7 pass, run exits 1* | killed: the importer test |
| guard → `if (process.argv[1])` | **survived** (33/33) | 12/12 pass, run exits 1* | 7/7 pass, run exits 1* | killed: the importer test |
| guard → `if (false)` | killed: 10 spawn tests | killed: 7 spawn tests | **survived** (7/7) | killed: 11 spawn tests |
| stray `process.stdin.on('data', …)` | **survived** | **survived** | **survived** | killed: the importer test |
| stray `process.stdin.read()` | **survived** | **survived** | **survived** | **survived** (46/46) |
| stray `process.stderr.write(…)` | **survived** | **survived** | **survived** | killed: the importer test |

\* Every test passed, and vitest's JSON report says `success: true`. The run
still exited 1, after `main()` had run inside the worker that imported the shim
and printed its own refusal on the worker's arguments and environment.
`eph-recall`'s output also carries `process.exit unexpectedly called with "1"`:
vitest refuses an exit from inside a worker. Nothing about the guard was
asserted.

**After** — the tests as committed at `174afdb`. "Both file cases" are the
`importer.mjs` and `x-<shim>.mjs` imports; "all three" adds the `node -e` case.

| Mutant | `eph-hook` | `eph-recall` | `eph-gh-token` | `eph-usage` |
|---|---|---|---|---|
| no-op control | survived (36/36) | survived (15/15) | survived (14/14) | survived (48/48) |
| guard → `if (true)` | killed: all three | killed: all three† | killed: all three | killed: all three |
| guard → `if (process.argv[1])` | killed: both file cases | killed: both file cases† | killed: both file cases | killed: both file cases |
| guard → the old suffix match | killed: the `x-` case only | killed: the `x-` case only | killed: the `x-` case only | killed: the `x-` case only |
| guard → first half deleted | killed: the `-e` case only | killed: the `-e` case only | killed: the `-e` case only | killed: the `-e` case only |
| guard → `if (false)` | killed: both file cases‡ + 10 spawn tests | killed: both file cases‡ + 7 spawn tests | killed: both file cases‡ + 4 spawn tests | killed: both file cases‡ + 11 spawn tests |
| stray `process.stdin.on('data', …)` | killed: both file cases | killed: both file cases | killed: both file cases | killed: both file cases |
| stray `process.stdin.read()` | killed: both file cases | killed: both file cases | killed: both file cases | killed: both file cases |
| stray `process.stderr.write(…)` | killed: all three | killed: all three | killed: all three + 1 spawn test | killed: all three |

† The run also exits 1 on the worker exit described above; the failing tests are
the import cases. ‡ Through each import test's positive control: the same inputs,
run as the program, must act, and with `main()` never called they cannot. So
every guard's program side is now pinned twice, `eph-gh-token`'s included. The
`-e` case sees no stray stdin read, because its stdin is empty and ended. The
importer files are there for that.

**Coverage.** V8 counts only code that runs inside vitest's own workers, and every
new test observes a child process, so the `shims` row cannot move. It did not:
55.59 / 54.47 / 57.41 / 56.84 (lines / branches / functions / statements) before
and after, on win32, equal to the floors #10 ratcheted.

## 5. Design decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| Compare `path.basename(process.argv[1])` with the shim's name | Compare `argv[1]` with `fileURLToPath(import.meta.url)`, the file's identity | Node absolutises `argv[1]` but loads the main module from its real path, so through a junction or a symlink the two differ and the shim would not recognise itself: `main()` would silently never run. Measured on node v20.16.0, run through a junction: `argv[1]` names the junction's path and `import.meta.url` the target's. The cost is the residual: an importer that is itself *named* `<shim>.mjs`, in another directory, still runs `main()`. No such file exists. |
| Keep the comparison case-sensitive | Fold case on Windows | The suffix match was case-sensitive too, and every production path writes the name exactly; folding would widen what counts as the shim. |
| Stack this branch on #10's head | Cut from `main` and leave `eph-usage` owed, or add a commit to #10's reviewed branch | Architect decision, 2026-10-02: one of the guards being tightened did not exist on `main` yet. |
| Merge `main` in once #60 had merged | Rebase onto `cab9e1b`, or leave the branch stacked | Architect decision, 2026-10-02. The four conflicts are resolved once, here, and the merge leaves the tested code byte-identical (§6). |
| Spawn the importer asynchronously where the endpoint is in-process | `spawnSync`, as #10's test does | Architect decision with the plan: `spawnSync` blocks the loop that would receive a stray request. |
| A positive control in every import test | Trust that the inputs are live | "Nothing arrived" is only evidence if the same inputs, run as the program, make something arrive. |
| Add the held-open import | Record the bare-read survivor | Architect decision, 2026-10-02, after the round found it; a deterministic check costs one spawn per case. |
| `test/shims/eph-gh-token.test.ts`, a new file | Add the spawn tests to `test/main/gh-token.test.ts` | `test/` mirrors the tree. That file tests the endpoint through the shim's exported helper; this one tests the shim as a program, as `eph-hook.test.ts` and `eph-recall.test.ts` do for theirs. |
| One shared importer (`test/shims/importer.ts`) for the three new tests | Inline it in each file, as #10 did | Three copies of a process probe drift. `eph-usage` keeps #10's reviewed inline importer and only calls the shared held-open and `node -e` imports. |
| Pin the guard's first half with a `node -e` import | Mark that row of the truth table untested | Architect decision, 2026-10-02, after review found it: only an `argv[1]` that is undefined tells the guard from one without that check. |
| One test name across the four files, `runs nothing when %s imports it` | Keep #10's longer name | The four tests make the same claim. The assertions, not the name, list what "nothing" covers. |
| Mutate in a detached worktree outside OneDrive; score a run with zero tests as INVALID | Mutate the working checkout; score by exit code | Both voided runs in this change's first attempt (DECISIONS-LOG 2026-10-02, recorded for GYM-008). |

## 6. Verification

```bash
npm run typecheck
npm run lint
node scripts/check-invariants.cjs
npm run test:coverage
node scripts/check-coverage.cjs
```

**Red before green.** The new tests against the unchanged guards, on Windows_NT
10.0.26200 with node v20.16.0: `Test Files 4 failed (4) · Tests 4 failed | 75
passed (79)`. The four failures were exactly the `x-<shim>.mjs` cases, with the
side effects listed in §1. With the guards changed: `8 passed (8) · 129 passed
(129)` across `test/shims/`, `test/scenarios/s-stoploop.test.ts`,
`test/main/engines/claude-usage-statusline.test.ts`, `test/main/gh-token.test.ts`
and `test/main/recall-probe.test.ts`, and `133 passed (133)` once the `node -e`
cases were added.

**The full gate**, same machine, same Node:

| Commit | typecheck · lint · invariants | Suite | `check-coverage` |
|---|---|---|---|
| `b65ffae` (the guards and their tests) | green; reachability 189/199, 10 unreachable by recorded decision | 238 files, 4651 passed, 8 skipped (4659) | ok; `shims` 55.59 / 54.47 / 57.41 / 56.84 |
| `7f9a810` (with the held-open import) | green; the same reachability | 238 files, 4651 passed, 8 skipped (4659) | ok; `shims` 55.59 / 54.47 / 57.41 / 56.84 |
| `174afdb` (with the `node -e` cases) | green; the same reachability | 238 files, 4655 passed, 8 skipped (4663) | ok; `shims` 55.59 / 54.47 / 57.41 / 56.84 |

#10's last recorded win32 run of its tree was 237 files, 4640 passed, 8 skipped.
At `b65ffae` and `7f9a810`, eleven new cases account for the difference: two each
in `eph-hook` and `eph-recall`, six in the new `eph-gh-token` file, and one more
in `eph-usage`. `174afdb` adds the four `node -e` cases, one per shim, for
fifteen. The held-open import added assertions, not cases.

`npm run test:coverage` exited 1 on the first run after writing its report, on
the known OneDrive handle race (`EPERM … rmdir 'coverage\.tmp'`, DECISIONS-LOG
2026-09-10), and 0 on the second and third. `check-coverage` was run against the
report each run wrote, and each report's timestamp was checked against its run.
Four metrics sit under their floors inside the 0.25-point tolerance on every run:

- `boot` lines, 27.94 against 28.05;
- `boot` functions, 12.99 against 13.24. That is exactly the tolerance, with no
  margin left: it passes because `check-coverage.cjs` compares rounded figures,
  and `12.99 < 12.99` is false.
- `boot` statements, 27.03 against 27.10;
- `engines` lines, 95.52 against 95.66.

Those are the figures #10's three recorded win32 runs measured too
(`coverage-floors.json`, `platforms.win32.candidate`), and this change touches no
file under `src/`.

**After `main` was merged in.** The merge commit `7431579` resolves its four
conflicts by choosing sides and changes no tested byte: `git diff 7f9a810 7431579
-- src shims test scripts` prints nothing, so every result measured on `7f9a810`
holds for the merged tree. Against `main` (`cab9e1b`), the merge left the branch
adding the four guard changes and the five test files. The `node -e` cases
(`174afdb`), this document and the eight log entries come after it.

**Not proven here.** Nothing was run on Linux. CI measures it on the push of this
branch (`ci.yml` runs on `fix/**`), and that result belongs in the pull request,
because a document cannot record the run its own push starts. No coverage ratchet
is owed on either platform: the `shims` row cannot move (§4), and on win32 it did
not. The mutation rounds ran on win32 only. The app itself was not launched. The
production side of each guard is held by spawn suites that start the shim with
its own absolute path as `argv[1]`, which is what each cited call path writes.
No engine ran one.

## 7. Related docs

- [ADR-0006](../adr/ADR-0006-library-memory.md) — the Library; `eph-recall` is layer 2
- [ADR-0009](../adr/ADR-0009-engine-adapters.md) — engine adapters; `eph-hook` stays engine-agnostic
- [ADR-0013](../adr/ADR-0013-stop-hook-autonomy.md) — the decision `eph-hook` relays
- [ADR-0022](../adr/ADR-0022-company-identity-is-a-github-app.md) — `eph-gh-token`
- [ADR-0023](../adr/ADR-0023-usage-aware-pacing.md) — `eph-usage`
- [ENGINEERING-STANDARDS](../ENGINEERING-STANDARDS.md) — §1 (green at every commit), §2 (evidence), §6.7 (the seam rule)
- [TEST-STRATEGY](../TEST-STRATEGY.md) — §2
- [eph-usage in-process coverage](2026-10-01-eph-usage-in-process-coverage.md) — #10, where the import test this extends was written
- [GYM-008](../gymnasium/proposals/GYM-008-a-mutation-round-is-a-tool-not-a-scratch-script.md) — the mutation harness; §4's conditions are evidence for it
- [DECISIONS-LOG](../DECISIONS-LOG.md) — the 2026-10-01 follow-up and the eight 2026-10-02 entries
