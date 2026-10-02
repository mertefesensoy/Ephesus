# A teardown no longer reads a failed drain as a finished one

Sixteen places in the tests, across fourteen files, waited for the Agora's
commit queue with `await agora.drained().catch(() => {})`: fourteen teardowns,
the scenario rig's copy of the quit sequence's drain step, and one drain in the
middle of a blackout case. An empty catch makes a drain that rejected look
exactly like one that finished: the teardown carries on, deletes the directory,
and nothing reports the failure. This change removes all sixteen. `drained()`
cannot reject today, so nothing behaves differently now; what changes is that
the day it can, the test fails instead of hiding it. One site also gained an
assertion, so the claim this change rests on — a drain still resolves when an
injected fault kills the commit it was waiting for — is tested rather than only
read.

## 1. Problem / motivation

On `main` at `cab9e1b`, `grep -rn "drained().catch" test` found seventeen sites
(line numbers are `main`'s):

| Where | Form | What it is |
|---|---|---|
| twelve `test/main/*.test.ts` files | `.catch(() => {})` | the `afterEach` that drains every Agora a test built |
| `test/scenarios/company.ts:828` | `.catch(() => {})` | `close()`, the teardown all twenty rig-based scenario files share |
| `test/scenarios/company.ts:667` | `.catch(() => undefined)` | the rig's copy of the shipped quit sequence's `agora-drain` step |
| `test/scenarios/s-blackout.test.ts:238` | `.catch(() => {})` | `close()` of the company a blackout case restarts |
| `test/scenarios/s-blackout.test.ts:351` | `.catch(() => {})` | inside "killed mid-commit", straight after a fault kills the commit |
| `test/scenarios/s-crash.test.ts:183` | `.catch(() => {})` | the S-CRASH rig's `close()` |

**Every one of these catches guards nothing, and would hide the failure it
seems to be there for.** `Agora.drained()` cannot reject (§3), so none of them
can ever run. That is the shape the M8.8 implementation doc recorded about a
`try/catch` around `Agora.tasks()`: a catch that could never fire, which let an
unreadable ledger read as "no blocks". The risk is in the future. If
`drained()` ever can reject — a refactor of the queue, or a commit failure
allowed to reach it — all sixteen sites would swallow the rejection, and the
teardowns would then delete the directory that held the evidence. ENGINEERING-STANDARDS §4 calls
silent fallback "the one unforgivable failure mode in this codebase"; a test
that cannot fail on the thing it is waiting for is the same failure in the
suite.

**One of them also made the rig disagree with production.** The shipped quit
step is `{ name: 'agora-drain', run: () => agora?.drained() }`
(`src/main/index.ts:3652`), with no catch, because `QuitSequence.runPhase`
(`src/main/shutdown.ts:270-286`) already isolates every step: a step that
rejects is reported through `onDegraded('shutdown/stop:agora-drain', …)`,
recorded `ok: false`, and the quit carries on. The rig's step caught the
rejection first, so a drain that failed at quit would have reached the shipped
sequence as a clean stop. S-CLOSING asserts that no stop failed and that
nothing degraded (`test/scenarios/s-closing.test.ts:212`, `:214`, `:242`), and
those assertions could not have seen it. The rig's own doc comment says "the
reporting — is the shipped object"; at this step it was not.

The twelfth `test/main` site, `test/main/pacing-wakes.test.ts`, is fixed the
same way on `fix/pacing-wakes-teardown`, alongside a separate teardown race
(`docs/implementations/2026-10-02-pacing-wakes-teardown.md` on that branch, not
yet merged). This change does the other sixteen.

## 2. What changed

| File | Change |
|---|---|
| `test/main/agora-ipc.test.ts` | The `afterEach` drain loses its `.catch(() => {})`. |
| `test/main/briefing.test.ts` | The same. |
| `test/main/endpoint-not-listening.test.ts` | The same. |
| `test/main/hermes.test.ts` | The same. |
| `test/main/ledger-endpoint.test.ts` | The same. |
| `test/main/log-readers-across-rotation.test.ts` | The same. |
| `test/main/mail-stranded.test.ts` | The same. |
| `test/main/memo.test.ts` | The same. |
| `test/main/odeon.test.ts` | The same. |
| `test/main/vfx-seam.test.ts` | The same. |
| `test/main/watch-ipc.test.ts` | The same. |
| `test/scenarios/company.ts` | `close()` drains with no catch, and its comment says why; the quit sequence's `agora-drain` step is `run: () => agora.drained()`, as in `index.ts`. |
| `test/scenarios/s-blackout.test.ts` | The restarted company's `close()` drains with no catch; "killed mid-commit" drains with no catch and asserts that the commit really failed (§3). |
| `test/scenarios/s-crash.test.ts` | The rig's `close()` drains with no catch. |
| `docs/implementations/2026-10-02-drained-teardown-no-swallow.md` | This document. |

No production file changed.

## 3. Implementation approach

### Why `drained()` cannot reject, even under an injected fault

`drained()` is `await this.chain` (`src/main/agora.ts:511-513`). `this.chain`
starts as `Promise.resolve()` and is reassigned in exactly one place, `commit()`
(`:476-479`), as `this.chain.then(() => this.drain(), () => this.drain())`, so
its newest link always takes the outcome of a `drain()` call. `drain()`
(`:535-547`) returns early on an empty batch, and everything else — `runCommit`,
the `onCommit` callback, and resolving each caller — sits inside one `try`. The
`catch` only calls each caller's `reject`, and a promise's `reject` cannot
throw. So a commit that fails rejects the promise of whoever queued it, never
the queue: an awaited `commit()` rejects at its caller, and `commitSoon()`
records the failure in `commitFailures()` and `onCommitError` (`:491-503`).

The injected faults the scenarios use fire inside that `try`. All four
commit-path fault points — `before-stage`, `after-stage`, `before-commit` and
`after-commit` — are awaited in `runCommit` (`:561-580`), so a fault that throws
there leaves `runCommit` at once and `drain()` catches it like any other
failure. The fifth, `before-reconcile`, is awaited in `reconcile()` before
anything is queued (`:450`), so it rejects `reconcile()`'s caller and never
reaches the queue. The Hermes faults throw in the router, and `Hermes.settled()`
absorbs a failed sweep on purpose (`src/main/hermes.ts:766-768`); neither touches
the Agora's queue.

A catch could never have helped with a drain that does not settle at all. A
fault that never resolves, or a git child that never exits, makes `drained()`
hang, and the hook timeout reports that whether or not a catch is there.

### Checking each site

| Site | Agora faults live when it drains? | Needs to tolerate a rejection? |
|---|---|---|
| the 11 `test/main` teardowns | None. Every Agora in these files is built with real git and no `faults`, custom runner or commit callbacks; `hermes.test.ts` injects Hermes faults only. | No |
| `company.ts` `close()` | Whatever the case passed as `agoraFaults`. Only S-BLACKOUT's "killed mid-commit" passes one, and it is still armed at teardown: a commit that fails there lands in `commitFailures()` and the drain resolves. | No |
| `company.ts` quit step | The same. A rejection here would not even crash a test: the shipped sequence reports it, which is the point. | No |
| `s-blackout.test.ts` restarted company | None: its Agora is built without faults. | No |
| `s-blackout.test.ts` "killed mid-commit" | `after-stage` throws on every attempt once armed. | No — this is the site that proves it (below) |
| `s-crash.test.ts` | None: S-CRASH's fault is a `SIGKILL` of the fake agent, not of the Agora. | No |

No site needs the catch, so none keeps one.

### The site that proves it

In S-BLACKOUT's "killed mid-commit" the case arms the fault, then
`hermes.sweep()` delivers one message and queues its durability with
`commitSoon` (`src/main/hermes.ts:789-792`) before the sweep resolves. The next
`drained()` therefore waits for that commit to be attempted, and the fault kills
it between `git add` and `git commit`. The case now drains with no catch and
then asserts:

```ts
expect(company.agora.commitFailures()).toContainEqual({
  subject: 'hermes: deliver 1, reject 0',
  reason: 'blackout between stage and commit'
})
```

So both halves of the claim are tested: the drain resolved, because a rejection
would fail the line before, and the commit it waited for really was killed. The
case's existing premise check, `isDirty()`, cannot tell those apart, since a
commit killed after staging and a commit never attempted both leave the tree
dirty; before this change the case would also have passed if the fault had
never fired. It is `toContainEqual` rather than `toEqual` because the rig's own
event handlers queue commits too (`company.ts:266-578`: gate, ledger, breaker,
Odeon, shutdown and incident events), and one that lands while the fault is
armed is recorded as well. The claim is about this commit, not the length of
the list.

### What was deliberately not changed

- **`test/main/pacing-wakes.test.ts`**, which `fix/pacing-wakes-teardown`
  changes.
- **`src/main/agora.ts`.** The same branch rewrites the doc comment on
  `drained()`, and the contract this change needs is already stated there:
  "Resolves when the queue is idle". Tests pin the behaviour instead:
  `test/main/agora.test.ts:284` and `:318` drain with no catch after a commit
  gave up, and S-BLACKOUT now does the same after an injected fault.
- **The rest of the pacing-wakes teardown pattern.** Every changed `test/main`
  file already removes its directories with `removeTempDir`. Two teardowns stop
  a Hermes without `await hermes.settled()` — `vfx-seam.test.ts` and
  S-BLACKOUT's restarted company — but neither starts Hermes's timers, and every
  sweep in them is awaited by its test, so no sweep can be in flight when they
  drain. Adding the wait there would be a consistency change, not a fix, and
  this change is about catches.
- **`docs/DECISIONS-LOG.md`.** Removing a catch that cannot run is not one of
  the §8.2 choices the log exists for, and the log is append-only: an entry
  here would collide at its tail with the pacing-wakes branch's entries.

## 4. Mathematical / statistical details

**The queue never rejects (induction over the chain).** Let
`c₀ = Promise.resolve()`, and for the n-th call to `commit()` let
`cₙ = cₙ₋₁.then(d, d)` with `d = () => this.drain()`. By the promise resolution
procedure, whichever way `cₙ₋₁` settles, `cₙ` adopts the state of the promise
`d()` returns. `d()` is an async function whose body cannot throw (§3), so that
promise fulfils whenever it settles. `c₀` fulfils, and if `cₙ₋₁` settles either
way then `cₙ` fulfils once `d()` settles; so no `cₙ` ever rejects. `drained()`
awaits the `cₖ` that is newest when it is called, so it either fulfils or never
settles — it cannot reject. The one hypothesis is that `drain()`'s body cannot
throw, and mutant `drain-rethrows` below breaks exactly that and nothing else.

**The differential.** For a mutant `M` of `src/main/agora.ts` and a test tree
`T`, let `F(T, M)` be the set of tests that fail when the file set in §6 runs.
`T = main` is the test files as `origin/main` has them (`cab9e1b`); `T = branch`
is this change. The production file and the mutant are byte-identical across
the two trees, and only the fourteen changed test files differ. Then
`F(branch, M) \ F(main, M)` is exactly the set of failures the catches hid, and
`F(main, M) \ F(branch, M)` must be empty: removing a catch cannot make a test
pass that failed with it.

## 5. Design decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| Drop every catch | Keep them, each with a comment | A comment cannot make a catch that never runs do anything. The rule applied was to keep a catch only where a site genuinely has to tolerate a rejection, with the reason written beside it, and none of the sixteen does (§3). |
| The rig's quit step matches `index.ts` | Keep its catch, since `QuitSequence` catches anyway | It did not duplicate the sequence's isolation, it pre-empted the sequence's reporting: the step read `ok: true` and nothing degraded. The rig exists to run the shipped sequence. |
| Assert the commit failure in S-BLACKOUT | Rely on reading `agora.ts` | A reading is true of today's code. An assertion fails the day it stops being true, at the site where it matters. |
| …with `toContainEqual` | `toEqual([…])` | The rig's event handlers can queue commits while the fault is armed; the claim is about this commit, not the length of the list. |
| No new test in `agora.test.ts` | Pin the fault path there as well | `drain()` handles a fault's throw and git's give-up through the same `catch`, and the give-up is already pinned at `:284` and `:318`. The fault path is pinned where a real component queues a real commit. `agora.test.ts` is also being edited on the pacing-wakes branch. |
| Leave `src/main/agora.ts` alone | Write "never rejects" into `drained()`'s doc comment | That comment is being rewritten on the pacing-wakes branch, its current contract already says it, and tests now hold the behaviour. |
| Two teardowns keep `stop()` without `settled()` | Make every teardown stop, settle, then drain | Neither can have a sweep in flight; the change would be cosmetic, and this one is about catches. |

## 6. Verification

```bash
npm run typecheck
npm run lint
node scripts/check-invariants.cjs
npm run test:coverage
node scripts/check-coverage.cjs
```

**The gate**, on Windows_NT 10.0.26200 with node v20.16.0 and git
2.53.0.windows.2, over the tree the first commit (`6a90fad`) records, before it
was committed:

| Check | Result |
|---|---|
| `npm run typecheck` | green, all four projects |
| `npm run lint` | green: ESLint with no warnings, and Prettier |
| `node scripts/check-invariants.cjs` | `invariants ok`, reachability 189/199 with 10 unreachable by recorded decision |
| `npm run test:coverage` | 237 files passed; 4640 tests passed and 8 skipped (4648) |
| `node scripts/check-coverage.cjs` | `coverage floors ok (17 subsystems on win32; 19 untested modules, all recorded)` |
| `node scripts/check-readme-current.cjs` | current for M8 |
| the attribution hooks | `attribution ok`, identity and message |

The totals are `main`'s as last measured locally (237 files and 4648 tests, in
the eph-usage implementation doc of 2026-10-01): this change adds an assertion to
an existing case, not a case. The same gate ran again over the finished branch,
this document included, before it was committed: green again, with the same
totals.

**The differential round.** GYM-008 (approved 2026-09-10) will make a mutation
round a checked-in tool; it is not built yet, so this round ran from scratch
scripts, and everything needed to repeat it is here.

- **Mutants**, each one exact replacement in `src/main/agora.ts`.
  `noop` adds `void 0` after `await this.chain` in `drained()`: the control,
  which must stay green on both trees. `drained-rejects` adds
  `throw new Error('mutant: drained() rejected')` there instead: a drain that
  rejects, whatever the reason. `drain-rethrows` adds `throw err` after the loop
  that rejects the callers in `drain()`'s `catch`: the realistic route, a commit
  failure allowed to reach the queue.
- **Trees.** `main` is the fourteen test files as `origin/main` (`cab9e1b`) has
  them, checked out over this branch; `branch` is `6a90fad`. `src/main/agora.ts`
  is the same blob, `3265623`, in both.
- **Files run**: the eleven changed `test/main` files; `test/main/agora.test.ts`,
  whose three drains never had a catch; `test/main/pacing-wakes.test.ts`, whose
  catch neither tree removes, as an in-run control for what a catch does; and
  all of `test/scenarios`. That is 36 files and 492 tests.
- **Each run**: `npx vitest run <files> --maxWorkers=4` with the JSON reporter;
  the tree checked clean against `HEAD` before; `agora.ts` and the fourteen test
  files hashed before and after (identical in every run); restored with
  `git checkout HEAD --` and checked clean again. vitest 4.1.11, with 1.52 to
  2.60 GB free at the start of each run.
- **Predictions** were written down after the controls had started and before
  any mutant ran.

| Mutant | Tree | Test files failed | Tests failed (of 492) | Unhandled rejections |
|---|---|---|---|---|
| `noop` | main | 0 | 0 | 0 |
| `noop` | branch | 0 | 0 | 0 |
| `drained-rejects` | main | 1 | 3 | 0 |
| `drained-rejects` | branch | 33 | 270 | 0 |
| `drain-rethrows` | main | 1 | 2 | 2 |
| `drain-rethrows` | branch | 2 | 3 | 2 |

`F(main, M) \ F(branch, M)` is empty for all three mutants, and every result
matched its prediction, with one difference of shape noted below.

**`drained-rejects`: what the catches hid.** On `main`, a drain that always
rejects fails three tests, all in `agora.test.ts`: the drains at `:284`, `:305`
and `:318`, which never had a catch. Every other drain in the run set swallowed
it. On this branch it fails 267 more tests, and ten scenario files fail in
`afterAll`, where they close one company shared by the whole file — nine of
them with no failing test at all, so the file is the only place the failure can
show. The prediction had expected per-test failures there; that is the
difference of shape.

| Where | Fails only on this branch |
|---|---|
| `test/main`, 11 files | 209 tests: `hermes` 73, `ledger-endpoint` 27, `odeon` 25, `briefing` 22, `memo` 18, `log-readers-across-rotation` 10, `watch-ipc` 9, `mail-stranded` 8, `vfx-seam` 8, `agora-ipc` 7, `endpoint-not-listening` 2 |
| `test/scenarios`, per test, 12 files | 58 tests: `s-ledger` 12, `s-profile` 9, `s-stoploop` 8, `s-blackout` 6, `s-bounce` 5, `s-onehour` 4, `s-wake` 4, `s-crash` 3, `s-livelock` 3, `s-closing` 2, `m7-evidence` 1, `s-secrets` 1 |
| `test/scenarios`, in `afterAll`, 10 files | `s-breaker`, `s-brief`, `s-closing`, `s-deckgate`, `s-gate`, `s-gym`, `s-meeting`, `s-memo`, `s-mode`, `s-stoa` |

That is every one of the 32 files whose drain lost its catch — eleven in
`test/main`, the twenty rig-based scenario files and S-CRASH — and no other
file. `pacing-wakes.test.ts` passed 30 of 30 on both trees, under a drain that
always rejects, because it still has its catch; S-FAILOVER and the smoke suite,
which drain no Agora, passed too. S-CLOSING fails where the quit-step change
was aimed: `expected [ { name: 'agora-drain', …(2) } ] to deeply equal []` at
`s-closing.test.ts:212` and `:242`, the shipped sequence reporting a failed step
that the rig's catch used to turn into a clean one.

**`drain-rethrows`: the realistic route.** If a commit failure ever reached the
queue, `main` would show it in two places only: the two `agora.test.ts` cases
that drain after a give-up, and two unhandled rejections (from "gives up loudly"
and "survives a crash injected between staging and committing") where a
rejected link of the chain had nobody waiting on it. Those two are why the
queue hands failures to callers in the first place: in the Electron main
process an unhandled rejection ends the harness (`agora.ts:483-490`). This
branch fails exactly one more test, S-BLACKOUT's "killed mid-commit", with
`blackout between stage and commit`, once at the drain and once at teardown. It
is the one place in the run set where a scenario's commit really fails, and so
the one site whose catch could have hidden this route.

**Attribution.** Both commits passed the pre-commit and commit-msg hooks
(`check-attribution.cjs --pending`), and `node scripts/check-attribution.cjs`
over the finished branch reports `attribution ok`.

**To see the change bite by hand**, replace the body of `drained()` in
`src/main/agora.ts` with `await this.chain` followed by `throw new Error('x')`
and run `npx vitest run test/scenarios/s-closing.test.ts`. On this branch it
fails at `:212` and `:242`, and in `afterAll`. On `main` it passes.

## 7. Related docs

- [ADR-0004](../adr/ADR-0004-agora-single-committer.md) — the single committer and its retry queue
- [ENGINEERING-STANDARDS](../ENGINEERING-STANDARDS.md) — §4 ("fail loud, degrade visible") and §6 (Definition of Done)
- [TEST-STRATEGY](../TEST-STRATEGY.md) — §2 (real fs and git, never mocked) and §3 (S-BLACKOUT, S-CRASH, S-CLOSING)
- [M8.1 — the quit path](2026-09-03-m8-1-the-quit-path.md) — why every quit step is isolated and reported
- [M8.8 — a restart is survivable](2026-09-05-m8-8-restart-survivable.md) — "A defect this package shipped, found in self-review": the `Agora.tasks()` catch that could never fire
- [The flaky temp-dir teardown](2026-09-01-flaky-temp-dir-teardown.md) — why a teardown drains before it deletes
- `docs/implementations/2026-10-02-pacing-wakes-teardown.md`, on `fix/pacing-wakes-teardown` and not yet merged — the first site fixed this way, and the stop → settle → drain order
