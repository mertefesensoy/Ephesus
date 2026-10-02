# A test that runs git removes its temp directories with removeTempDir

**Date:** 2026-10-02
**Requirement:** ENGINEERING-STANDARDS §6.2 (every fixed bug has a regression test) · TEST-STRATEGY §2
(integration tests on real fs and real git in temp dirs, nothing mocked) · the 2026-09-07 temp-hygiene
guard (`2026-09-07-the-suite-cannot-say-it-is-out-of-memory.md`)
**Branch:** `fix/temp-hygiene-requires-remover`, cut from `main` at `cab9e1b`

---

## 1. Problem / motivation

`test/temp-hygiene.test.ts` guards the tree against the defect it was written for on 2026-09-07: a test
file that makes a temp directory and never removes one. As written it asked one textual question of
each file — does it contain `removeTempDir(` or `rmSync(`? — and accepted either.

That acceptance let `test/main/pacing-wakes.test.ts` keep this teardown:

```ts
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
```

and on linux CI (run `36924116592`) it threw `ENOTEMPTY` on `agora/.git`. Node 20's synchronous
`rmSync` lists a directory's children ONCE and then retries only the `rmdir` of that directory, so a
single entry written after the listing spends the whole budget (§5). The writer was git's own
housekeeping: `git commit` starts `git maintenance run --auto`, which on POSIX detaches and outlives the
commit, and git 2.55 repacks there — `git repack` was still writing `.git/objects/pack` when the teardown
ran. That diagnosis, and the evidence for it, are in `2026-10-02-pacing-wakes-teardown.md` on
`fix/pacing-wakes-teardown`; on `main` until it lands, the 2026-10-01 DECISIONS-LOG entry still leaves the
writer as a follow-up. `test/tmpdir.ts`'s `removeTempDir` lists the tree afresh on every attempt, so it
outlasts a writer that stops inside its budget; `rmSync`'s retry does not.

So the guard accepted, by rule, the exact teardown that failed. `removeTempDir` had become the one
remover on 2026-09-01, when 54 teardowns were converted to it and only deliberate in-test deletions kept
an explicit `rmSync` (`2026-09-01-flaky-temp-dir-teardown.md`). `capacity-watch`, `pacing-wakes`,
`engines/claude-usage-statusline` and `cost-in-dollars` landed that same evening in the old idiom, and
the 2026-09-07 guard accepted them by rule — "five files legitimately use `rmSync` with their own retry
budget; forcing a migration is beyond this fix", the fifth being the `test/pin.ts` probe. The two incident
files were written on a parallel line that night and reached `main` hours after the guard, which passed
them for the same reason. That rule was right for files that never touch git and wrong for files that
do.

## 2. What changed

| File | Change |
|---|---|
| `test/temp-hygiene.test.ts` | The guard reads each file's TypeScript syntax tree instead of its text. A file that reaches real git — however it reaches it — may not remove a tree with a raw recursive remove except as part of a test, and must call `removeTempDir` if it makes a temp directory. A premise test re-derives, from the tree, every module git can start through. 134 tests, among them the old `pacing-wakes` teardown as the case the guard must fail. |
| `test/main/pacing-wakes.test.ts` | Its teardown removes its temp directories with `removeTempDir`. |
| `test/main/incident-surface-wiring.test.ts` | Its teardown removes its temp homes with `removeTempDir`. |
| `docs/DECISIONS-LOG.md` | One entry: the rule, and the evidence for keeping `rmSync` where no git runs. |
| `docs/implementations/2026-10-02-temp-hygiene-requires-remover.md` | This document. |

No production file changed. The sweep and the headroom refusal in the same test file are untouched.

## 3. Which files the tightened guard flagged

Surveyed by grep first (every `mkdtemp` caller, every git sighting, every remover call), then by the
guard's own first run against the unfixed tree. Both named the same two files:

| File | How it reaches git | Its teardown |
|---|---|---|
| `test/main/pacing-wakes.test.ts` | `new Agora` (line 65), `ensureRepo()` | `afterEach`: `fs.rmSync(dir, { recursive, force, maxRetries: 10, retryDelay: 50 })` (line 39) — the CI failure |
| `test/main/incident-surface-wiring.test.ts` | `new Agora` (line 102), `ensureRepo()` | `afterEach`: `fs.rmSync(home, { recursive: true, force: true })` (line 45) — one pass, no retry at all |

`incident-surface-wiring` never failed, but it is exposed to the same writer: its `ensureRepo()` makes
the seed commit, and that commit is what starts the detached maintenance. With no retry, its first
listing is its only chance.

**Neither fix drains anything.** `pacing-wakes` keeps its `drained().catch(() => {})`, because the
teardown's drain and settle order belong to `fix/pacing-wakes-teardown` (§8). `incident-surface-wiring`
needs no drain: `ensureRepo()` is awaited, and nothing else in the file queues a commit — its endpoint
writes through `agora.appendLog`, which appends and never commits (`src/main/agora.ts:172`).

### How the guard now reads the tree

114 files are judged — every file that makes a temp directory or reaches git — and none is at fault.
43 reach git: 24 by importing a door module (20 `src/main/agora.ts`, 4 `src/main/git.ts`), one by running
the `git` program itself (`test/scripts/check-attribution.test.ts`), and 18 through
`test/scenarios/company.ts`. Seventeen of those 18 make no temp directory of their own and were never
judged before (§4.2). 71 make a temp directory and never reach git.

### What the guard did NOT flag, and why that is right

| File | Why it passes |
|---|---|
| `test/main/worktrees.test.ts` | Reaches git and calls `fs.rmSync(…, { recursive: true })` twice (lines 305, 417) — both inside `it` bodies, deleting a worktree to see what the code does next. That removal is the test. Its teardown already calls `removeTempDir`. |
| `test/scenarios/s-bounce.test.ts` | Reaches git through `startCompany`; its recursive `rmSync` (line 65) archives an agent's mailbox inside an `it` body — again the test itself. |
| `test/main/restore.test.ts` | Reaches git; its one `rmSync` (line 327) deletes a file, without `recursive`. |
| `test/main/tmpdir.test.ts`, `test/pin.ts`, `test/tmpdir.ts` | Call `rmSync` on purpose to measure it, or are `removeTempDir` itself. None reaches git — the comments that name `ExecGitRunner` and `git` are comments — and a test asserts all three read that way. |
| `capacity-watch`, `cost-in-dollars`, `engines/claude-usage-statusline`, `incident-refusals` (all `test/main/`) | Tear down with `rmSync` and never touch git (§6.1). |
| The scenario files | Reach git through `startCompany`; all tear down through `cleanupHomes`, which calls `removeTempDir`. |

## 4. Implementation approach

### 4.1 Read the syntax tree, never the text

Every question is asked of the TypeScript syntax tree (`ts.createSourceFile`), as
`scripts/reachability.cjs` asks its own — `typescript` is already a dev dependency, so nothing is added.
A call is a `CallExpression`, so a comment, a string and an import line are none. The 2026-09-07 version
had already learned this once — written as `includes('removeTempDir')`, it was satisfied by the import a
deleted teardown left behind — and the git side needed it as much: the text `ExecGitRunner` sits in
`tmpdir.test.ts`'s header, and `'git push -u origin agent/'` is a grant string in
`profile-activation.test.ts`, and neither runs git.

### 4.2 Which files reach git: doors, not spellings

The task named four ways a test runs real git: it constructs an `Agora`, calls `ensureRepo`, uses
`ExecGitRunner`, or shells out to `git`. The first draft looked for those spellings, and the refutation
pass (§9.3) broke it from both sides: `import { Agora as Store }` hid git, and an
`import type { ExecGitRunner }` added to `test/tmpdir.ts` — whose header already names the runner, and
which 92 files import — would have made all of them, the `rmSync` measurement included, read as running
git.

So the guard reasons about **doors**: the modules outside `test/` that git can start through — those
that run git themselves, and, to a fixed point, those that import one of them for its values. Today:
`src/main/git.ts` (it runs `git`), `src/main/agora.ts` (imports it), `src/main/index.ts` (imports both),
`scripts/arm-hooks.cjs` and `scripts/check-attribution.cjs` (run `git`). None of the four named ways is
possible without an import of `agora.ts` or `git.ts` somewhere in the test's own import graph, under any
local name, so a file reaches git when:

- it imports a door module for its values — statically, by re-export, by `import()`, `require()`,
  `vi.importActual` or `vi.importMock`, with `./x.js` resolving to `x.ts` as the bundler does. Type-only
  imports run nothing and never count;
- it starts git itself: a `child_process` call — resolved through the file's own bindings, so renames,
  namespaces, `require`, a default import and `promisify` all count, and `RegExp.prototype.exec` and a
  local function that happens to be called `exec` do not — whose program is `git` (by name, path or
  `git.exe`) or whose command line starts with `git` (`exec`, or `shell: true`);
- it passes a git-starting script to such a call, named as a path segment anywhere in the command;
- or it imports a helper under `test/` that does any of these, followed through re-exports, as deep as
  the chain goes. That last item is how 18 scenario files reach a real Agora through `startCompany`.

**A file that reaches git is judged whether or not it makes a temp directory.** The first draft judged
only `mkdtemp` callers, so a scenario file that tore down its company with the shipped `pacing-wakes`
teardown — the exact CI defect, on an Agora's tree — passed. Judging every file that reaches git closes
that, and raised no new fault in the real tree.

**The premise test keeps the doors honest.** It re-derives the door set from `src/`, `scripts/`,
`shims/` and the fake programs under `test/fakes/`, and requires it to equal `GIT_DOORS`. It derives from
what runs git, never from the list itself — a case proves a recorded door imported in a tree where
nothing runs git opens nothing. So moving the Agora's construction into a new factory module, or
subclassing it, is a failing test, not a blind spot. ADR-0004 keeps the list short.

### 4.3 What counts as part of a test

The second half of the rule forbids a raw recursive removal — `rmSync`, `rm`, `rmdirSync`, `rmdir` —
in a file that reaches git, unless it is part of a test. The first draft decided "part of a test" by the
spelling of the enclosing call (`it`/`test`), and both refuters broke it: vitest hangs `afterEach`,
`describe` and `extend` off `test`, so `test.afterEach(() => fs.rmSync(…))` read as a test body; and an
alias (`const itWithGit = it.runIf(hasGit)`), a body passed by name, or a helper hoisted out of two tests
read as teardown.

Now a removal is part of a test when every way it runs is from inside a test's registration:

- a registration is a call whose chain starts at `it`, `test`, an import rename of either, vitest's
  namespace, or a `const` alias of any of those (`it.runIf(ok)`, `ok ? it : it.skip`, a factory
  returning one, `test.extend/override/scoped(…)`), and whose every member is one of vitest 4.1's
  modifiers (`concurrent`, `sequential`, `skip`, `only`, `todo`, `fails`, `each`, `for`, `skipIf`,
  `runIf`) — so `test.describe` and `test.afterEach` are not;
- what a hook runs is teardown wherever the hook is registered, and so is a `finally` or a `process`
  handler inside a test. That covers every vitest hook — the collection hooks (`beforeEach`,
  `afterEach`, `beforeAll`, `afterAll`, `aroundEach`, `aroundAll`) as well as `onTestFinished` and
  `onTestFailed` — because `@vitest/runner` 4.1.11 checks only `test()` and `suite()` for being called
  inside a test (`chunk-artifact.js`, lines 1560 and 1917): `afterEach` and the rest register on the
  current suite from wherever they are called (line 746 and its siblings). The guard does not depend on
  what vitest then does with such a hook;
- a named function — a declaration, a class method, or an arrow held by a `const` — is part of a test
  when every use of it is (two functions calling each other decide nothing; a function used only by
  itself is no test), so a helper hoisted out of two tests stays allowed and one a hook calls does not;
- everything else — `describe` bodies, fixtures, the module itself — is not a test.

The modifiers, fixture builders and hooks above are read from that source, not remembered.

### 4.4 Cannot tell counts as can

A removal counts as recursive when its `recursive` is anything but a literal `false` — read in the order
the object is built, so a later spread overrides an earlier `recursive: false` and a later
`recursive: false` overrides a spread — and also when its options are a variable, a spread or a computed
key it cannot read. A check that passes whatever it could not read is a check that cannot fail. The fault
says so: `rmSync at line 4 (options it cannot read)`. The one exception is the callback in
`fs.rm(path, () => {})`, which is plainly not options; `fs.rm(path, done)` counts, since `done` could be
either.

### 4.5 Not vacuous

The tree test asserts no offenders — which an empty walk, or resolution broken on real paths, would also
produce. So it also asserts named judgements, one per way the rule sees git: `pacing-wakes` is seen
importing `src/main/agora.ts`, `s-livelock` reaching git only through `company.ts`, `check-attribution`
running the `git` program itself — and the `rmSync` measurement in `tmpdir.test.ts` seen NOT to reach git.

## 5. Mathematical details

**`rmSync`'s budget, and why it is spent on nothing.** Node 20's `rimrafSync` removes a non-empty
directory by listing its children once (`readdirSync`), removing each, then trying `rmdirSync` up to
`maxRetries + 1` times, sleeping `i × retryDelay` ms after the `i`-th failure. The sleeps total

    retryDelay × (1 + 2 + … + maxRetries) = retryDelay × maxRetries × (maxRetries + 1) / 2

which for `maxRetries: 10, retryDelay: 50` is `50 × 10 × 11 / 2 = 2 750 ms` — 2 750 of the 2 841 ms the
failing CI test took (`2026-10-02-pacing-wakes-teardown.md` does that arithmetic). If an entry lands after
the listing, every one of those `rmdir` attempts fails with `ENOTEMPTY`: nothing in the loop removes it.

**`removeTempDir`'s.** Each attempt is a fresh single-pass `rmSync` — a new listing — and failures classed
as transient (`EBUSY`, `EPERM`, `ENOTEMPTY`, `EACCES`, `EMFILE`, `ENFILE`) are retried after waits of 25,
50, 100, 200, then 250 ms, until `TEMP_REMOVE_BUDGET_MS` (10 s). A writer that stops inside the budget is
outlasted; one that does not is reported, not hidden.

**Cost.** The tree test parses every `.ts`, `.tsx`, `.js`, `.mjs` and `.cjs` file under `test/`, and the
premise test every module under `src/`, `scripts/`, `shims/` and `test/fakes/`; the whole guard file,
134 tests, takes about 4.7 s of test time on this machine, against a 30 s per-test timeout.

## 6. Design decisions

### 6.1 `rmSync` stays acceptable where no git runs — on evidence

The task asked to keep `rmSync` for files that never touch git unless there was a reason not to. The
question that decides it: what defeats `rmSync`? Something that outlives the test inside its directory —
a writer, or on Windows a process whose working directory it is. Git is the one this suite cannot stop,
because its housekeeping detaches from the commit that started it, beyond anything a test can await.

The four files that still tear down with `rmSync` were each checked against that:

| File | Writers | Children |
|---|---|---|
| `test/main/capacity-watch.test.ts` | fixtures written synchronously; `CapacityWatch` only reads, through `tick()`, which every test awaits; `start()` (the timer) is never called | none |
| `test/main/cost-in-dollars.test.ts` | synchronous fixture writes; the ledger store is in memory; `BudgetWatcher`'s timer is never started | none |
| `test/main/engines/claude-usage-statusline.test.ts` | the shim, inside its child | `execFileSync` — exited before teardown |
| `test/main/incident-refusals.test.ts` | the endpoint, synchronously; no Agora | none |

Nothing there can write after the listing, so moving them would change nothing they can observe.

**The reason it could change, written down.** A file that leaves an *asynchronous* child running in its
temp directory needs `removeTempDir` whether or not the child is git — on Windows that child's working
directory is an open handle, and `rmSync`'s retry does not wait it out (`tmpdir.test.ts` measures this).
The guard does not look for that, deliberately: `tmpdir.test.ts` and `pin.ts` start exactly such children,
on purpose, to measure the pin, and tear down with `rmSync` because what they pinned is by construction
still held. A rule wide enough to catch the shape would punish the measurement. It stays a residual (§7).
Today every file that both makes a temp directory and starts the fake engine — `fake-engine.test.ts`,
`agent-worktree.test.ts`, `s-crash.test.ts`, `conformance/engine-adapters.test.ts`,
`scenarios/company.ts` — already removes it with `removeTempDir`.

### 6.2 The other choices

| Decision | Alternative rejected | Why |
|---|---|---|
| Read the syntax tree | Keep matching text | Text cannot tell a call from a comment, a string or a type; the guard had already been fooled once by an import. `typescript` is in the tree, and `reachability.cjs` reads sources this way. |
| Doors are modules, reached by value imports | Match `new Agora` / `ensureRepo` / `ExecGitRunner` by name | Names are defeated by an alias and fooled by a type position; every way a test reaches git goes through an import of a door. |
| Judge every file that reaches git | Judge only `mkdtemp` callers | Seventeen scenario files reach git through a helper's temp directory; the CI teardown would have passed in any of them. |
| A removal is a test's when every way it runs is from a test | Decide by the spelling of the enclosing call | Spelling read `test.afterEach` as a test and an aliased or hoisted test as teardown. |
| Name every vitest hook, collection hooks included | Name only `onTestFinished`/`onTestFailed` | Vitest checks only `test()` and `suite()` for being inside a test, so a collection hook can be registered from one; naming it keeps the guard right whatever vitest then does with the hook. A draft that left them out passed its mutation round only because no case registered one inside a test (§9.2). |
| Forbid raw recursive removal outside tests, not just require a `removeTempDir(` call | Only require the call | The weaker rule passes a file that removes one list with each remover — not "removes its temp dirs with `removeTempDir`". |
| Premise derived from what runs git | A hand-kept list | A list only stays true while nobody adds a door; deriving it makes a new door a failing test. |
| Script names count only inside a `child_process` call | Count any mention | `check-invariants.cjs` names both scripts in its allowlist without running them; a citation or a source read is not a run. |
| Change only the removal line in `pacing-wakes` | Take `fix/pacing-wakes-teardown`'s whole teardown | The drain and settle order are that branch's subject and depend on its `src/main/git.ts` change. |
| Branch `fix/temp-hygiene-requires-remover` | `test/temp-hygiene-requires-remover` | CONTRIBUTING §5 allows `feature/`, `fix/` and `docs/`. |

## 7. What the guard still cannot see

Recorded so the next reader knows the edge of what is checked. None of these shapes exists in the tree
today unless it says so.

- **A temp directory a helper made and nobody removes.** The guard now catches a raw `rmSync` teardown of
  `startCompany`'s home, but not a scenario file that drops its `cleanupHomes()` call: that is a leak, the
  2026-09-07 rule's territory, and that rule only sees `mkdtemp` in the judged file itself. The same
  holds for a future `makeTempDir()` beside `removeTempDir`, and the removal check is per file, not per
  directory — a file that calls `removeTempDir` once passes with a second directory never removed.
  Handed to a follow-up task, with the next item.
- **A temp directory made without `mkdtemp` — live today.** `test/main/gates.test.ts:392` hands a
  `PromptStore` the path `os.tmpdir()/eph-prompts-<pid>`, which `PromptStore.read` creates and nothing
  removes: nine such directories were in `%TEMP%` on 2026-10-02. Found by the refutation pass, outside this
  change's subject, and handed to the same follow-up.
- **`scripts/check-invariants.cjs`'s git tripwire** matches line by line, so it never sees
  `src/main/git.ts`'s own call, which Prettier wraps over two lines, and would miss a wrapped call
  elsewhere. This guard's premise reads the tree and does see it. Handed to its own follow-up, because
  it is a CI gate.
- An asynchronous non-git child left running in a temp directory (§6.1).
- In a file that reaches git, a temp root removed with `rmSync` inside a test body: position cannot tell
  it from a deliberate removal.
- A git program named through a variable or `which('git')`, a shell line that runs git without starting
  with it (`cd x && git init`), and a git script spawned through a variable holding its path — the shape
  `test/scripts/check-attribution.test.ts` uses, which is judged as reaching git anyway because it also
  runs `git` directly.
- `child_process` reached by `await import('node:child_process')`: only static imports and `require`
  are bound.
- A helper used by a test in its own file and exported (`export { f }`) for another file's hook: uses
  are counted per file, so its own file reads it as a test's.
- An aliased `mkdtempSync` import, `fs.rmSync.call(…)`, and `.githooks/*` (shell, not parsed; no test
  runs them).
- Two functions with the same name in different scopes share one verdict.

## 8. Merging beside `fix/pacing-wakes-teardown`

That branch (not merged when this was cut) rewrites the same `afterEach` in `pacing-wakes.test.ts`:
stop, settle, drain without swallowing a rejection, then `removeTempDir`. Whichever lands second meets a
conflict in that `afterEach` body; the resolution is that branch's version, which already ends in
`for (const dir of temps.splice(0)) removeTempDir(dir)`. The `import { removeTempDir } from '../tmpdir'`
line is placed identically on both branches. Its new `tmpdir.test.ts` cases use a plain `node` writer,
not git, and keep their `rmSync` measurement inside `it` bodies, and its `agora.test.ts` additions make
no raw removal, so this guard stays green after both land. `docs/DECISIONS-LOG.md` will conflict at its
end, as it already does against `main`; keep both entries.

## 9. Verification

### 9.1 The guard was fed the defect

On the unfixed tree the first version's first run failed exactly where it should:

```text
"test/main/incident-surface-wiring.test.ts": [
  "runs real git (new Agora at line 102) but never calls removeTempDir",
  "runs real git (new Agora at line 102) and removes a tree with rmSync at line 45, outside any test body",
],
"test/main/pacing-wakes.test.ts": [
  "runs real git (new Agora at line 65) but never calls removeTempDir",
  "runs real git (new Agora at line 65) and removes a tree with rmSync at line 39, outside any test body",
],
```

and the old `pacing-wakes` teardown is kept as a fixture the guard must fail, both faults asserted word
for word, beside the same file with its teardown fixed, which must pass.

### 9.2 Two mutation rounds, each with a control

Both rounds ran from a scratch harness, not committed — GYM-008's tool has not landed — on a committed
tree, against `test/temp-hygiene.test.ts` (the only file whose tests exercise the guard): baseline green
first, a no-op control that must survive, every find-string checked unique before the first run, the
file restored byte-exact and hash-checked with a clean `git status` after every mutant, and a run the
suite REFUSED for low memory retried rather than scored — another worktree's suite held this machine near
its 1 GB floor throughout.

**Round 1, on the first version: 65 mutants, 63 killed, 2 survived, 0 unexpected.** The two survivors
were predicted: the control, and deleting a text pre-filter that was an optimisation the reading already
implied. The refutation pass (§9.3) then broke that version anyway, which is the point of having both.

**Round 2, on the guard as committed: 145 mutants, 144 killed, 1 survived — the control — 0 unexpected**
(baseline 134/134). It was run first on a draft, 139 mutants with the same result, and again after the
design review in §9.4 changed how hooks are read; the table is the second run.

| What the mutants attacked | Mutants | Killed |
|---|---|---|
| which calls count as a raw removal | 4 | 4 |
| which calls make a temp directory | 2 | 2 |
| `child_process` bindings: both module names, the seven runners, renames, default and namespace imports, `require`, `promisify`, type-only imports | 18 | 18 |
| the git program, command lines and scripts | 14 | 14 |
| imports and their resolution: each extension, five type-only forms, bare specifiers, `.js` mapping, index files, every import form | 19 | 19 |
| what registers a test, and what is teardown inside one: each vitest modifier, fixture builder and hook, chains, renames, namespaces, aliases, `process` handlers, `finally` | 42 | 42 |
| named functions and their uses: declarations, methods, arrows, property and shorthand uses, recursion | 12 | 12 |
| reading the options | 12 | 12 |
| call detection and line numbers | 5 | 5 |
| the rule and the tree: helper chains, cycles, what is judged, each fault | 10 | 10 |
| the doors: what starts git, the closure | 6 | 6 |
| the control (a comment) | 1 | survived, as it must |

Getting there mattered as much as the score. Planning round 2 found places where two pieces of logic
could never disagree — a three-valued position where two values were always treated alike, a
fixed-point loop over `const`s that are declared in order, `unwrap` where no wrapper can occur — and each
was deleted rather than left as a mutant no test could kill. Three apparent redundancies were not:
excluding a function's uses of itself (a helper that only calls itself is no test's, and the recursion
guard alone would have said it was); parsing `.tsx` as TSX (plain TS mangles a call inside a JSX
attribute); and the collection hooks. A draft deleted those last as unobservable, on the belief that
vitest refuses a hook inside a test; the pre-commit design review read `@vitest/runner` and found it does
not (§4.3). That mutant had survived because no case registered a hook inside a test — a missing test,
not a duplicate — so the hooks are named again, with that case for each of the six.

### 9.3 An adversarial refutation pass

Three independent reviewers were each given one lens — make it pass when it should fail; make it fail
when it should pass; make it report something it did not measure — on the first version, with no suite
runs (they read the code and ran it in memory). The bypass lens confirmed ten bypasses and four gaps in
the rule itself, the false-positive lens six false positives and six misleading messages, the premise
lens nine gaps; several were found twice. What changed:

| Found | Change |
|---|---|
| Hooks, `describe` and fixtures hung off `test`/`it` read as test bodies — a one-token bypass, reproduced on the real `pacing-wakes` file | Position model rebuilt (§4.3) |
| An alias, an import rename, a namespace, a body passed by name, or a helper hoisted out of tests read as teardown | Same |
| `onTestFinished` inside a test, and `test.extend` fixtures, read as test bodies | Same |
| `import type { ExecGitRunner }` read as running git — added to `test/tmpdir.ts`, it would have flagged the `rmSync` measurement | Doors are modules; type-only imports never count (§4.2) |
| `import { Agora as Store }`, a `.js`-extension import of a git helper, `.mjs`/`.js`/`.tsx` helpers, `vi.importActual`, `promisify(execFile)`, `shell: true`, a git script named mid-command | All read now; each has a case |
| A script name used as data, `RegExp.exec('git …')`, a `vi.mock` key named `ExecGitRunner` | Not read as git now; each has a case |
| `{ recursive: false, ...NUKE }` read as non-recursive; `{ …QUIET, recursive: false }`, `as`/`satisfies` options read as recursive | Options read in order and unwrapped (§4.4) |
| `fs['rmSync'](…)`, a trailing-slash directory import | Read now |
| Seventeen scenario files reaching git through `startCompany` never judged | Every file that reaches git is judged (§4.2) |
| The premise pinned files, not doors: a new `openAgora()` factory, a subclass, an aliased runner import all passed it | Doors derived by import closure (§4.2) |
| The guard read itself as running git; the non-vacuity check counted kinds, not files | Script names count only in a `child_process` call; named anchors (§4.5) |
| The fakes under `test/fakes/` were neither walked nor in the premise | Walked, and in the premise |
| Messages that misled a fixer ("never removes one" beside an `fs.promises.rm`; "removes a tree" for options it could not read; the helper chain's first hop missing) | Reworded; the whole chain is named |
| A helper's leaked temp directory, a temp directory made without `mkdtemp` (live in `gates.test.ts`), `check-invariants`' line-by-line git tripwire | Recorded (§7) and handed to follow-up tasks |

Tried and held, so the next reader knows the coverage of the attack: comments and JSDoc never read as
calls or git; grant strings and `gitleaks`/`git-lfs`/`gh` are not git; all 252 files parse with no
diagnostics in their dialect; `it.each` tables in all three forms, `it.runIf(x).each(…)`, `test.for`,
`it.concurrent` and loop-generated tests stay test bodies; `beforeEach` leftover deletion, describe-level
removal and a removal in a body's `finally` count; a removal in a body's `try` does not; no API in
`src/`, `shims/` or `scripts/` is named like a remover; the four non-git `rmSync` files have no writer
or child that outlives a test; and on today's tree the premise derives exactly the five doors.

### 9.4 A design review before committing

A design-conformance review of the whole diff (BUILD-PROMPT §3, ENGINEERING-STANDARDS, TEST-STRATEGY §2,
the attribution rule) found nothing blocking and four things to correct, all made: this document stated
the root cause without pointing at its evidence, which lives on an unmerged branch (§1 and §5 now cite
it); it claimed vitest refuses collection hooks inside a test, which `@vitest/runner` contradicts (the
guard now names every hook, with a case per hook, and round 2 was re-run on the result); it stated as
fact an `import type` in `test/tmpdir.ts` that was only the refutation's hypothetical (reworded); and
the branch's local restore-point commit was not a Conventional Commit (it is not pushed: the branch is
committed as two). Its notes added `engine-adapters` to §6.1's list, `s-bounce` to §3's, corrected §1's
history, and added two residuals to §7. It found no Gymnasium entry owed, by the precedent of the
2026-09-01 and 2026-09-07 changes to the same guard, which were recorded the same way: a DECISIONS-LOG
entry and an implementation document.

### 9.5 The gates

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs \
  && npm run test:coverage && node scripts/check-coverage.cjs
```

Run on the final tree (win32, node v20.16.0, git 2.53.0.windows.2), each step separately so every exit
code is its own:

| Step | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `node scripts/check-invariants.cjs` | `invariants ok (src, shims, scripts, test; reachability 189/199 src modules reached, 10 unreachable by recorded decision, 6 type-only)` |
| `npm run test:coverage` | **237 test files, 4761 passed, 8 skipped** — and exit 1, twice, both times AFTER every test passed: vitest wrote the report and then failed to remove its own `coverage/.tmp` (`EPERM … rmdir`), the OneDrive handle race recorded in DECISIONS-LOG 2026-09-07. The same step on this branch's tree before §9.4's hook change exited 0 (237 files, 4755 passed). |
| `node scripts/check-coverage.cjs` | `coverage floors ok (17 subsystems on win32; 19 untested modules, all recorded)` — read from the report each of those runs wrote, timestamped inside the run |
| `node scripts/check-readme-current.cjs` | `README landed list is current for M8 (32 package(s)).` |
| `node scripts/check-attribution.cjs` | exit 0 |

The gate was not loosened to absorb the `EPERM`; per that 2026-09-07 entry, that is a question for the
Gymnasium, not for a change that happens to meet it. No production file changed, so no coverage floor
moved. This machine cannot reproduce the linux failure
itself — Git for Windows never detaches its maintenance (`fix/pacing-wakes-teardown` records why) — so
the evidence that the two fixed teardowns hold on linux is CI's to give.

## 10. Related docs

- `docs/implementations/2026-09-01-flaky-temp-dir-teardown.md` — `removeTempDir` made the one remover,
  and deliberate in-test deletions kept as `rmSync` because there the removal is the test
- `docs/implementations/2026-09-07-the-suite-cannot-say-it-is-out-of-memory.md` — the guard this tightens
- `test/tmpdir.ts` — why removal waits, and what it waits for
- `docs/DECISIONS-LOG.md`, 2026-10-01 (#10) — the CI failure, recorded before its writer was found
- `docs/adr/` ADR-0004 — the single committer, which keeps the list of doors short
- `scripts/reachability.cjs` — the same syntax-tree reading, for the seam rule
