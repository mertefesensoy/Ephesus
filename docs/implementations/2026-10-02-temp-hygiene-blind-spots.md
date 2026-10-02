# The temp-hygiene guard follows every directory, and sees the ones mkdtemp never made

`test/temp-hygiene.test.ts` is the suite's guard that a test which makes a temp
directory removes it. As rewritten on `fix/temp-hygiene-requires-remover`
(`docs/implementations/2026-10-02-temp-hygiene-requires-remover.md`), its leak rule
asked one question of a FILE: does a file that calls `mkdtemp` also call a remover
somewhere? This change fixes the leak that rule could not see, and makes the rule ask
its question of every DIRECTORY, wherever it is made, including the ones no `mkdtemp`
made at all — and then, after an adversarial pass found its first version accepting
four files in the tree that it should not have, of every function the removal sits in.

## 1. Problem / motivation

**A live leak.** `test/main/gates.test.ts`'s describe *the choke-point wiring (SDD §9),
shared with production* built its `PromptStore` with the home
`path.join(os.tmpdir(), \`eph-prompts-${String(process.pid)}\`)`. `PromptStore.read`
(`src/main/prompts.ts:42`) creates that home and writes an editable copy of every
template it serves into it, and nothing removed it. On 2026-10-02 there were nine
`eph-prompts-<pid>` directories in `%TEMP%`, one per vitest worker that had run the
file; only `test/global-setup.ts`'s two-hour, age-gated sweep reclaims them. Reproduced
with `TEMP`/`TMP` pointed at an empty directory, so no other run could write into it:
each run of the unfixed file left exactly one (`eph-prompts-31648`, then
`eph-prompts-62548`). The fixed name had a second cost. Windows reuses process ids, and
`read()` returns the home copy whenever one exists, so a worker that drew a pid an
earlier run had used would have read that run's copies instead of `prompts/` — a test
of "the template comes from `prompts/`" reading a stale one.

The guard could not see it: no `mkdtemp` made the directory.

**Four blind spots in the rule,** each the shape of a leak the suite could carry
indefinitely with the guard green:

| | Blind spot | What it would let through |
|---|---|---|
| a | A temp directory made without `mkdtemp` | The live leak above. `PromptStore`, `mkdirSync`, a socket or a git clone can each create a path built on `os.tmpdir()`. |
| b | A directory a helper makes for its callers | `test/scenarios/company.ts`'s `startCompany` made every company home with `mkdtempSync` and left the removal to `cleanupHomes()`, which each of the twenty scenario files had to call. Measured: with the call deleted from `s-livelock.test.ts`, its three tests passed and **three `eph-scenario-*` homes were left behind** per run. The guard passed company.ts because it contained a `removeTempDir(` call — inside an exported function no code in the file ran. |
| c | A future `makeTempDir()` beside `removeTempDir` | Every directory it made would leave `test/tmpdir.ts` for callers no rule judges. Same shape as (b). |
| d | The removal check was per file | A file that removed one directory was excused every other: a second `mkdtempSync` with no removal, or a pushed `home` vouching by name for an unpushed one in the next test. |

**A latent instance of the live defect.** `test/main/engines/claude-capacity.test.ts`
gave a `ClaudeAdapter` the prompt home `path.join(os.tmpdir(), 'eph-capacity-prompts')`
and the shim path `path.join(os.tmpdir(), 'eph-hook.mjs')`. Neither is created today,
only because the test never asks the adapter to compose an identity — the one thing
that reads a prompt (`src/main/engines/claude.ts:1183`, `:1287`). One added assertion
would have made it the gates leak again.

**Blind spot (b) in four more files, found by refutation.** `control-server.test.ts`,
`s-crash.test.ts`, `ephctl.test.ts` and `eph-recall.test.ts` each made a rig's home in
`startRig` and removed it only in the rig object's `async close()`, which ran only if
`rigs.push(rig)` had registered the rig with the `afterEach` that closes rigs. Deleting
the push, or the drain, leaked every home those files made: eight such mutations, all
eight green under the first version of this change (§3.7).

## 2. What changed

| File | Change |
|---|---|
| `test/main/gates.test.ts` | The choke-point describe makes its `PromptStore` home with `fs.mkdtempSync` in a `beforeAll` and removes it with `removeTempDir` in an `afterAll`. |
| `test/main/engines/claude-capacity.test.ts` | The adapter's prompt home and shim path live in an `mkdtempSync` directory the test removes in a `finally`. |
| `test/scenarios/company.ts` | Registers `afterAll(cleanupHomes)` at module level, so every company home is removed when the scenario file ends whether or not the scenario calls `cleanupHomes()` itself; the comment states what that ordering relies on. |
| `test/main/control-server.test.ts`, `test/shims/eph-recall.test.ts` | Each rig's home goes into a `homes` list the `afterEach` empties after closing the rigs; `close()` no longer removes it. |
| `test/scripts/ephctl.test.ts` | The rig's home goes into the existing `temps` list, which the `afterEach` empties after closing the rigs; `close()` no longer removes it. |
| `test/scenarios/s-crash.test.ts` | The rig's home goes into a `homes` list the `afterEach` empties after closing the rigs. `close()` keeps its own removal, deliberately (§5). |
| `test/temp-hygiene.test.ts` | The leak rule follows each directory from the call that makes it to a remover the file runs; flags any path named on the temp root outside an `mkdtemp` call unless `UNMADE_TEMP_PATHS` lists it, how often, and why; resolves `fs`/`os`/`removeTempDir` imported under other names; reasons every fault. New regression fixtures (the old rule's misses, and every bypass the adversarial pass confirmed and this closed), premise tests, and a hook-order tripwire. |
| `docs/implementations/2026-10-02-temp-hygiene-blind-spots.md` | This document. |
| `docs/DECISIONS-LOG.md` | Two entries: the helper removes its own homes; a removal only a kept function performs counts for nothing. |

## 3. Implementation approach

### 3.1 The prompt home

```ts
let home = ''
let prompts: PromptStore
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-prompts-'))
  prompts = new PromptStore(home, path.join(process.cwd(), 'prompts'))
})
afterAll(() => {
  removeTempDir(home)
})
```

One home per describe, as before: the tests share one store, and `read()` seeds each
template once. It is made in `beforeAll` rather than in the describe body because
vitest runs neither `beforeAll` nor `afterAll` for a suite whose tests are all filtered
out; a directory made at collection time would leak on a `-t` run. `mkdtemp`'s random
suffix also ends the pid reuse: every run starts from `prompts/`. The `eph-` prefix
keeps it inside the global sweep's reach if a run is killed before `afterAll`.

### 3.2 Paths on the temp root (blind spot a)

`readHygiene` records every expression that names the temp root:

- a call whose callee is named `tmpdir` — `os.tmpdir()` however `os` is bound, a bare
  `tmpdir()` imported from `os`, `require('node:os').tmpdir()` — or a local name
  `tmpdir` was imported or required under;
- `process.env.TMPDIR`, `process.env.TMP` or `process.env.TEMP`, by property or by key,
  because `s-secrets.test.ts` spells its temp root `process.env['TMPDIR'] ?? '/tmp'`.

One inside the first argument of an `mkdtemp` call is a prefix and is fine. Anything
else is a `TempPath` with a NAME: the pieces added to the root — by `path.join` or
`path.resolve`, a template (`` `${os.tmpdir()}/eph-x` ``) or a `+` chain alike, after
climbing `??`, `||`, `&&`, `?:`, `await`, type assertions and `realpathSync` — with `*`
for anything computed and the empty string for the root itself. The gates home is
`eph-prompts-*`. Each is a fault — *names 'eph-prompts-\*' on the temp root at line 4
outside an mkdtemp call: make the directory with mkdtemp, the root inside its prefix
argument, or, if nothing is ever left there, list it in UNMADE_TEMP_PATHS with the
reason* — unless the file's entry in `UNMADE_TEMP_PATHS` allows that name, once per
listed site.

`UNMADE_TEMP_PATHS` is the allowlist the task described: paths a test names on the
temp root where nothing is left — the code under test only reads them, compares
against them, fails to reach them, or removes what it puts there itself — with how many
times the file names each one, and why. Eleven sites in nine files:

| File | Name | Sites | Why nothing is left there |
|---|---|---|---|
| `test/fakes/hook-stub-server.ts` | `*.sock` | 1 | On POSIX the stub listens on it, and libuv unlinks a socket it bound when the server closes; on win32 the endpoint is a named pipe and this branch never runs. |
| `test/global-setup.ts` | (the root) | 1 | The root the stale-directory sweep reads. |
| `test/main/eventlog.test.ts` | `eph-nonexistent/log.jsonl` | 1 | `EventLog.read()` of a missing file returns nothing and creates nothing. |
| `test/main/repo-remotes.test.ts` | `eph-nope-does-not-exist` | 1 | git cannot start in a missing directory. |
| `test/main/tmpdir.test.ts` | (the root) | 1 | The working directory of the writing child #62 added: the root itself, so the handle a process holds on its cwd cannot pin the directory the case measures; the child writes only into directories the test made. |
| `test/main/worktrees.test.ts` | `no-agora-here` | 3 | `Worktrees` only `path.resolve`s and compares the forbidden root (`src/main/git.ts:217`). |
| `test/scripts/check-coverage.test.ts` | (the root) | 1 | `headCommit` reads a `.git` it does not find, and only when the test has no directory of its own. |
| `test/shims/eph-recall.test.ts` | `eph-no-such.sock` | 1 | An endpoint nothing listens on. |
| `test/temp-hygiene.test.ts` | `eph-does-not-exist-at-all` | 1 | A root the sweep must survive not finding. |

A premise test holds every entry to EXACTLY as many sites as its file names, so an entry
can neither outlive its paths nor cover a new one — the empty name included, which
would otherwise admit every bare use of the root in its file. The gates home and the
capacity test's two paths were the other three of the thirteen sites the tree had when
this began, and all three were fixed rather than listed (§5); `tmpdir.test.ts`'s
writing child arrived with #62 while this was in flight (§6).

### 3.3 One directory at a time (blind spot d)

`MadeDir` replaces the three file-level booleans (`makesTempDir`, `callsRemoveTempDir`,
`callsRmSync`). For each `mkdtemp` call, `readHygiene` follows the value it returns:

- **into a variable** — `const home = …`, or `root = …` in a hook — and from there to
  every identifier that names the same variable. Variables are told apart by SCOPE: a
  type checker built over the one file (`checkerFor`, no library, no imports, nothing
  checked) answers `getSymbolAtLocation` — and `getShorthandAssignmentValueSymbol` for
  the `home` in `{ home }` — because test after test declares its own `const home`, and
  a rule matching names would let the pushed one vouch for the one that was not. A copy
  (`const dir = home`) and `realpathSync(home)` are followed too.
- **into a list** — `push`, `unshift`, `add`, `set` — and from the list to every
  removal that takes the WHOLE list: a `for…of` over it
  (`for (const dir of temps.splice(0))`), a callback over it
  (`temps.forEach((dir) => …)`), the remover handed to it
  (`temps.forEach(removeTempDir)`), or a read from it inside a loop
  (`while (homes.length > 0) removeTempDir(homes.pop()!)`,
  `const home = homes.pop()` in one). A single read outside any loop takes one
  directory per pass and leaves the rest, and the fault says so.
- **into a remover** — `removeTempDir`, or a raw `rmSync`/`rm`/`rmdirSync`/`rmdir`
  whose options plainly say `recursive: true`. Options the guard cannot read are no
  longer credited as a removal (they still count against a git-running file's
  teardown, `recursionOf` unchanged): a check that gives the benefit of the doubt in
  either direction passes what it could not read.
- **out of a function** — `return home`, or an arrow's body. A named function in the
  file that does nothing with its directory but hand it back is judged at each of its
  calls instead, and the fault names it (*line 5 (through fresh())*). One that also
  lists it, or strands its removal, is judged where it makes it, where the reason is.

Anything else the fresh value meets is named in the fault: *it drops the path*, *it
passes it to track(), where this guard cannot follow it*, *it keeps it where this guard
cannot follow it*. So is what a variable holding it did instead of being removed: *it
calls rmSync on it without recursive, which cannot remove a directory*, *it keeps it in
an object or an array, and this guard does not follow it out of one* (only for an
object the file keeps — declares, assigns, returns or pushes — not an options bag like
`{ cwd: home }`). A file that reaches git needs every directory removed by
`removeTempDir`; any other file, by either remover. The verdict is per directory, so
the fault names its line.

### 3.4 A removal has to run (blind spots b and c)

Following a directory to a `removeTempDir(` is not enough: company.ts's removal sat in
`cleanupHomes`, an exported function nothing in company.ts ran, and the four rigs'
removals sat in `close()` methods of objects nothing in their files was seen to call. A
removal counts only if it runs whenever the directory is made:

- it sits in the same function BODY as the make — `test/pin.ts` makes and removes its
  directory in one `try/finally` inside `pinHolds`, which only other files call; or
- the file **executes** it: every function between it and the file's top level is run.
  An anonymous function handed to a call or a `new` is taken to be run by it — a hook, a
  test, `forEach`, a `Promise` executor, an IIFE — unless the call only stores it
  (`push`, `add`, `set`). A named function runs when a call of it runs, or a call it is
  handed to (`afterAll(cleanupHomes)`): calls of a function are matched by the checker's
  symbol, so `server.close()` is no call of a function `close`, and only a method runs
  through a property (`rig.cleanup()`). Stored in an object, exported, or named in a
  type, a function takes part in no call. Any other function — a method of an object
  literal, a closure returned or assigned — is only kept.

A removal that fails both is *stranded*, and the fault says how: *only cleanupHomes
would remove it, and nothing in this file runs cleanupHomes*, or *only a function
startRig keeps — an object's method, or one stored or returned — would remove it, and
nothing in this file is seen to run that*, each with the remedy *remove it from a hook,
or put it in a list a hook empties*.

A function that hands its directory back is refused when no call of it here can be
judged. EXPORTED, its callers live in files no rule follows the directory into: that is
blind spot (c), and a `makeTempDir()` in `test/tmpdir.ts` that returned
`fs.mkdtempSync(…)` fails with *makeTempDir hands it to callers in other files, where
this guard does not follow it: remove it here, from a module-level hook*. Not called
here at all — exported inside an object, under another name, through `module.exports`,
from a class a factory hands out, or only handed by reference to `Array.from` — it
fails with *… hands it back, and nothing in this file calls that*. One that lists its
directories and empties the list from a module-level `afterEach` passes.

For company.ts the remedy is the one the fault names, and the one
`test/conformance/adapter-conformance.ts:75` already uses: `afterAll(cleanupHomes)` at
module level (§5 explains why it cannot race a company still closing). The scenarios
still call `cleanupHomes()` themselves, per test where they close companies per test;
the hook removes what a forgetful one leaves. Measured on `s-livelock.test.ts` with its
call deleted, `TEMP` isolated: the old company.ts left 3 homes, the new one 0, and the
unmodified file 0 — three passing tests each time. For the four rigs the remedy is the
list: each home goes into a list the `afterEach` empties after it has closed the rigs,
so a home is removed whether or not its rig was registered. Run with `TEMP` isolated,
the four files passed (67 tests) and left the directory empty.

### 3.5 Names a function is imported under

`readHygiene` used to recognise `mkdtempSync` and the raw removers by the name at the
call. It now also records the local names they are imported or required under —
`import { mkdtempSync as makeDir } from 'node:fs'`, `const { rmSync: nuke } =
require('fs')`, `import { tmpdir as scratchRoot } from 'node:os'`, and
`import { removeTempDir as drop } from '../tmpdir'` when the specifier resolves to
`test/tmpdir.ts`. An aliased `mkdtempSync` was one of the residuals recorded on
`fix/temp-hygiene-requires-remover`; an aliased `rmSync` was an unrecorded way past its
raw-teardown rule.

### 3.6 The fixtures the old rule was tested with

Four existing cases changed, each because the old rule could not see what they now
assert:

- *accepts a file that actually calls one of the two removers* used
  `fs.mkdtempSync(x)\nremoveTempDir(home)` — a removal of a different `home` than the
  dropped directory. The directory now flows to the remover.
- *fails a file that removes one list with removeTempDir and another with rmSync* never
  put its `repo` into `repos`. It does now, and the case expects the directory fault as
  well as the raw-teardown fault: "calling the helper once is not removing every temp
  directory with it" is now said of the directory.
- The company fixture under *judges a file that reaches git through a helper* gains
  `afterAll(cleanupHomes)`, as the real file did; without it, company.ts is now the
  file at fault.
- The git-file messages read *never removes the temp directory it makes at line N with
  removeTempDir* instead of *never calls removeTempDir*.

### 3.7 What the adversarial pass found

Before closing, the guard went through an adversarial pass with two opposite lenses —
*make it pass when it should fail*, and *make it fail when it should pass, or report
what it did not measure* — evaluating the guard's own functions in memory on fixtures
and on mutated copies of real files. Every candidate the pass produced was then re-run
through the real guard (`readHygiene`/`judgeTree` in a scratch vitest file in a
throwaway worktree), so the verdicts below are measured.

**Confirmed bypasses, 16; 13 closed.**

| Found | Closed by |
|---|---|
| The four rigs' `close()` removals (8 surviving mutations in the tree); a helper returning `{ home, cleanup: () => removeTempDir(home) }` (the tmp-promise shape); a removal closure pushed onto a list nothing runs | a removal counts only in its own body or a function the file runs (§3.4); the rigs restructured |
| A stranded remover masked by `export const company = { …, cleanupHomes }`, by `export type C = typeof cleanupHomes`, or by an unrelated `server.close()` in a hook | calls matched by symbol; only calls and hand-overs run a function (§3.4) |
| A hand-back exported inside an object, under another name, through `module.exports`, from a class a factory hands out, or handed by reference to `Array.from` | a hand-back no call here can be judged for is refused (§3.4) |
| A list a hook takes one directory out of per pass; `afterAll(() => removeTempDir(temps[0]!))` | a list counts as emptied only when the remover takes all of it (§3.3) |
| A second bare `os.tmpdir()` in `global-setup.ts`, admitted by its `''` entry | allowlist entries carry their exact number of sites (§3.2) |

The three left open are recorded in §7: a variable made per test but removed once
(`beforeEach` + `afterAll`), a drain hook inside one `describe` while the list and the
maker are file-level, and an inverted condition on a push.

**Messages that reported what was not measured, fixed.** "Never removes it" when the
directory went into a kept object, or was given to `rmSync` without `recursive`; "the
temp root itself" for a template or a `+` chain; a temp-path message promising "nothing
removes what is put there" for a path nothing is put in; a helper's call-site faults
not naming the helper; a helper with a stray reported at its make AND each call; a
`RULE` that named no shape the guard can follow and contradicted the fixture for a
git file's temp root removed raw in a test body. Comments that claimed too much were
corrected: company.ts's ("after every hook" — not a `beforeAll`'s returned cleanup, a
file-scoped fixture or an `aroundAll`, which no scenario uses; and it relies on
vitest's file isolation), the allowlist's ("nothing ever makes it" — the stub's socket
is made and unlinked), and this document's own first draft, which said no file removes
a directory through a closure it hands out. Four did.

**False positives kept, by decision.** A directory held in an object and removed
through the property (`removeTempDir(rig.home)`), a list drained through a copy
(`const done = temps.splice(0)`), a local remover helper (`drop(home)`), and a cleanup
closure the test does run (`r.cleanup()`) are refused. Each would need the guard to
follow values through objects or parameters; each fault now names the shape that
passes. None occurs in the tree.

## 4. Mathematical / statistical details

### The fate of a directory

Let *M* be the set of make sites in a file: every `mkdtemp` call, plus every call of a
named function in the file that does nothing with its made directory but return it
(computed as a worklist; each site is judged once). For a site *m*, the removals that
reach it are found by following edges of a small value graph:

- *value → variable v* when the value initialises or is assigned to *v*; *v → each
  identifier with the same symbol* (scope-resolved);
- *value → list L* when the value is an argument of `L.push/unshift/add/set`; *L →
  removal r* when *r* takes the whole of *L* (§3.3);
- *value → removal r* when the value is an argument of a remover call *r*;
- *value → function f* when the value is returned from *f*.

Each variable and list is visited once per site (a `seen` set of symbols), so the walk
terminates and is linear in the identifiers of the file. A removal *r* **counts** for
*m* iff `body(r) = body(m)` or `executes(r)`, where `body(x)` is the innermost function
(named or not) around *x*, or the file, and

```
executes(x) = for each function f around x, innermost first:
                f named           → return runs(f)
                f handed to a call or new, not a collector → continue
                otherwise          → return false
              → true at the file's top level
runs(file)  = true
runs(f)     = ∃ use u of f's name that calls f or hands f to a call
              (a method through a property; any other function only through
               an identifier the checker binds to f) such that runs(home(u))
```

with `home(u)` the nearest NAMED function around *u*, or the file. `runs` is the least
fixed point, computed by depth-first search that answers *false* on re-entry, so a
function calling itself, or two calling each other, decide nothing. With *K(m)* the
kinds of the counted removals, the verdict is: no fault iff `K(m) ≠ ∅` for a file that
does not reach git, and iff `removeTempDir ∈ K(m)` for one that does. The analysis is
path-insensitive: a removal counts whether or not a branch around it is taken (§7).

For the allowlist: with *a(n)* the sites a file's entry allows for name *n* and *s(n)*
the sightings of *n* in the file, the first *min(a(n), s(n))* sightings in source order
pass and the rest fault; the premise test asserts *a(n) = s(n)* for every entry.

### Mutation rounds

Both rounds ran in a detached worktree outside OneDrive (`%TEMP%\mut-hyg-*`,
`node_modules` by junction) against a committed restore point, one mutant at a time,
running `test/temp-hygiene.test.ts` (whose whole-tree test reads every other round
file). The harness required a green baseline first, scored a run that executed zero
tests as INVALID and retried it, hashed every round file before the round and after
every run, restored with `git checkout --`, and wrote each prediction before the first
mutant ran. Mutants are named for the enforcement point they disable.

| Round | Tree | Mutants | Killed | Survived | Not as predicted | Baseline |
|---|---|---|---|---|---|---|
| 1 | `035b142` (on `70d028e`) | 59 | 56 | 3: two no-op controls; a scenario dropping `cleanupHomes()`, predicted to survive | 0 | 206/206 |
| 2 | `216cefb` (on `9a21f2e`) | 98 | 94 | 4: three no-op controls (the guard, company.ts, a rig file); the scenario case, predicted to survive | 0 | 240/240 |

Both rounds ran before the rebase onto `9723c10` (§6). Since round 2 the guard's code is
unchanged but for one `UNMADE_TEMP_PATHS` entry, and its 240 tests are the same.

Round 1 was the first version, before the adversarial pass; its 56 kills include all
seven defects put back into the real tree (the gates home, the capacity test's shim
path, company.ts's hook, four directories taken off their lists). Every bypass in §3.7 was
invisible to it — a perfect mutation score over the code the author imagined, which is
the reason the pass exists. Round 2 ran on the final guard, rebased onto
`9a21f2e`, with mutants for every enforcement point added since, and twelve defects
put back into the real tree: round 1's seven, and five of the eight rig mutations the
pass had reported surviving — a home taken off its list in `control-server`, `ephctl`
and `eph-recall`, and the drain deleted in `control-server` and `s-crash`. All twelve
were killed, by the whole-tree test.

### Cost

The checker is built only for a file with a make site: 98 of the 254 files under
`test/` the walk reads. Measured 2026-10-02 on this machine (win32, the file run
alone from a worktree outside OneDrive, two runs each, interleaved, about 1.2 GB free
at the end):

| Guard | Tests | vitest `tests` time | Duration |
|---|---|---|---|
| `9a21f2e` (the base) | 134 | 2.71 s, 2.49 s | 3.55 s, 3.28 s |
| this change | 240 | 3.95 s, 3.65 s | 4.93 s, 4.50 s |

About 1.2 s more, for 106 more tests and the per-directory walk.

## 5. Design decisions

**company.ts removes its own homes, rather than the guard requiring each scenario to
call `cleanupHomes()`.** The task offered both. A guard rule ("a file calling a helper
export that makes temp dirs must call that helper's remover export") detects the leak
after somebody writes it, and needs cross-file name resolution through imports,
renames and relays. The hook makes the leak impossible to write, and the rule that
keeps it so is local to one file: a removal has to run. The hazard the task named is
order — company.ts's comment says removing a home is separate from closing a company
because a blackout scenario runs two companies over one home and a removal racing a
commit is a teardown race. It cannot race:

- vitest 4.1.11 runs a suite's after-hooks last-registered first: `getSuiteHooks`
  reverses `afterAll` and `afterEach` when `sequence.hooks` is `'stack'`
  (`@vitest/runner/dist/chunk-artifact.js:2567`), which is its default
  (`resolved.sequence.hooks ??= "stack"`), and `vitest.config.mts` does not set it;
- the hook registers when the scenario's static import evaluates company.ts, before
  the scenario's own body registers anything, so it is the first root `afterAll` and
  runs last;
- a file's root `afterAll` runs after every `describe`'s hooks and every `afterEach`;
- every one of the twenty scenarios closes its companies in an `afterEach` or
  `afterAll` of its own (all twenty read), and none closes one through a `beforeAll`'s
  returned cleanup, a file-scoped fixture or an `aroundAll`, which would run later.

A setting change would break that silently, so the guard file carries a tripwire: two
`afterEach` hooks and two tests that assert they ran last-registered first. The one
setting orders `afterAll` and `afterEach` alike, and `afterEach` is the one a test can
observe. Checked: with `--sequence.hooks=list` and with `--sequence.hooks=parallel`,
exactly that test fails, by its name, and nothing else; with `stack`, all pass.

**A removal only a kept function performs counts for nothing, and the four rigs were
restructured, rather than the guard learning to follow objects.** Following
`rig = { home, close() { … } }` through `rigs.push(rig)` to `rig.close()` on an item
taken from `rigs` means tracking objects and their methods across returns and lists —
the same machinery again, for values that are not directories. The restructured shape
is also the more robust one: the home is removed whether or not anyone remembered to
register the rig. The cost is the false positives in §3.7, which the faults now name a
remedy for.

**`s-crash.test.ts` keeps its `close()`-time removal.** When the rigs were changed,
the line beside it, `await agora.drained().catch(() => {})`, was the one
`fix/drained-teardown-no-swallow` (PR #61) rewrote, and deleting the removal would
have made the two changes collide on adjacent lines. #61 has since merged and this
branch sits on top of it. The list drain is what the guard verifies; the second removal
of an already-removed directory is a no-op (`force: true`), and is left for a tidy that
needs no guard change.

**Refuse a helper that hands directories out, rather than judge its callers.** Judging
callers means resolving which imported names are makers through relays, renames and
namespaces, and transferring an obligation across files. Nothing in the tree hands a
directory out today (`pin.ts` removes beside the make; adapter-conformance and, now,
company.ts remove in a hook), so refusing costs nothing now and closes (c). The fault
says how to comply. If a caller-removes helper is ever wanted, the guard has to grow
cross-file judgement first, and this decision is the place to revisit.

**A type checker for scope, rather than a hand-written resolver or name matching.**
Names alone fail a common shape in the tree: seventeen files bind two or more of their
directories to the same name, test after test (`s-secrets.test.ts` declares
`const home` eight times). A resolver written here would be fifty lines of
JavaScript scoping rules (blocks, parameters, `for…of`, `catch`, hoisting) to test
and mutate; the compiler already has them, and the same checker answers which
function a call names (§3.4).

**Fix the capacity test rather than allowlist it.** Its reason would have been "the
adapter only reads prompts when it composes an identity", a fact about code in another
file that can change without anyone looking here. The allowlist is for paths that by
the test's own construction leave nothing behind.

**Key the allowlist by file, name and count, not by line or source text.** Lines drift
with every edit above them; source text breaks under formatting. The name is what the
guard reads off the path and what a reviewer can check against the reason; the count
keeps a second use of the same name — or a second bare use of the root — from passing
on the first one's reason.

**Optimistic about callbacks handed to calls.** An anonymous function handed to a call
is taken to run — a hook's body, a `forEach` callback, a `Promise` executor. Deciding
otherwise needs to know what each callee does with the function it is handed. Storage
calls (`push`, `add`, `set`) are the one exception the rule spells out, because a
removal closure pushed onto a list is the shape that otherwise passes for free.

## 6. Verification

```bash
# the guard, its fixtures and the tree (240 tests)
npx vitest run test/temp-hygiene.test.ts

# the files this change touched, and two scenarios that import company.ts
npx vitest run test/main/gates.test.ts test/main/engines/claude-capacity.test.ts test/main/control-server.test.ts test/scenarios/s-crash.test.ts test/scripts/ephctl.test.ts test/shims/eph-recall.test.ts test/scenarios/s-livelock.test.ts test/scenarios/s-blackout.test.ts

# the tripwire trips, and only it
npx vitest run test/temp-hygiene.test.ts --sequence.hooks=list

# the Definition-of-Done gate
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs
```

The leak, before and after (PowerShell; an empty `TEMP` so no other run writes there):

```powershell
$t = "$env:TEMP\eph-proof"; New-Item -ItemType Directory -Force $t | Out-Null
$env:TEMP = $t; $env:TMP = $t
npx vitest run test/main/gates.test.ts; npx vitest run test/main/gates.test.ts
Get-ChildItem $t -Filter 'eph-prompts-*'   # nothing; before the fix, one per run
```

Measured 2026-10-02: two unfixed runs left `eph-prompts-31648` and
`eph-prompts-62548`; two fixed runs left the directory empty, 42/42 passing each time.
The scenario-home and rig measurements in §3.4 were taken the same way, with a short
`TEMP` (`%TEMP%\tbx-*`): under a long one git fails with *Filename too long* and the
run measures nothing. And in the real `%TEMP%`, the newest `eph-prompts-*` directory
after a full gate run of this tree predates the run (09:30Z, the gate began 09:37Z);
unfixed trees in other worktrees went on leaving them.

The Definition-of-Done gate, 2026-10-02, win32, run in this OneDrive worktree, each step
run whatever the one before returned:

| Run | Tree | Free at start | typecheck | lint | invariants | suite | check-coverage |
|---|---|---|---|---|---|---|---|
| 1 | `a1a7a25` (first version, rebased onto `9a21f2e`) | 2.11 GB | exit 0 | exit 0 | ok | 237 files; 4839 passed, 8 skipped | floors ok |
| 2 | `df64b3d` (final) | 1.75 GB | exit 0 | exit 0 | ok | 1 test failed of 4875, in `s-breaker.test.ts`: `writeFileAtomic` under `LedgerEndpoint.stallTaskOf`; free memory had fallen to 0.89 GB | no report written |
| 3 | `df64b3d` (final) | 2.01 GB | exit 0 | exit 0 | ok | 237 files; 4867 passed, 8 skipped; vitest exited 1 AFTER writing its report, on its own `coverage\.tmp` EPERM (the OneDrive race in DECISIONS-LOG 2026-09-07) | floors ok, on the report run 3 wrote (15:09:06) |

Run 2's failure did not recur: `s-breaker.test.ts` alone passed three times (14/14
each, at 1.30–1.52 GB free), and run 3 passed it within the full suite. Run 2 kept
only the tail of its output, so the error's message is not on record; it is recorded
as a failure under memory pressure that did not recur, not as explained. The two
intermediate commits were checked on their own outside OneDrive: each typechecks and
passes the base guard and every file it touches (259 tests).

After the rebase onto `main` at `9723c10` (below), on the final tip:

| Run | Tree | Free at start | typecheck | lint | invariants | suite | check-coverage |
|---|---|---|---|---|---|---|---|
| 4 | `4f1e5db` | 2.70 GB | exit 0 | exit 0 | ok | 2 tests failed of 4913, both in #65's `check-invariants.test.ts` CLI group (below) | no report written |
| 5 | `4f1e5db` | 2.00 GB | exit 0 | exit 0 | ok | 239 files; 4905 passed, 8 skipped; exit 0 | floors ok, on the report run 5 wrote (22:41:39) |

Run 4's failures were this worktree's, not the change's. One case ran the checker over
the repository and hit its 20 s child timeout mid-suite; alone, it passes. The other
copies the checker into a fixture tree and points `NODE_PATH` at the repository's
`node_modules`, which in this worktree held only vite's caches — packages
resolved from the main checkout by walking up — so the copy could not load
`typescript`: 19/20 twice, deterministically. With `node_modules` linked to the main
checkout's (lockfile matched, 328 packages, no mismatch) the file passed 20/20 twice,
and run 5 is the whole gate on that tree. CI installs its own packages.

### Rebased onto `main` at `9723c10`

While this was in flight, #61, #62, #63 and #64 — this branch's base — merged, then
#65 and #66. A trial merge with the first four, outside OneDrive, had already shown the
one interaction: #62 adds a writing child to `test/main/tmpdir.test.ts`, spawned with
`{ cwd: os.tmpdir() }` — the root itself as a working directory, where nothing is made
— and this guard read that as a bare use of the temp root. Neither branch could list it
first, because the premise test refuses an entry whose file names no such path.

The branch was then rebased onto `main` at `9723c10`. The three code commits applied
cleanly — company.ts and `s-crash.test.ts` over #61, `eph-recall.test.ts` over #63 — and
the docs commit conflicted only on the `DECISIONS-LOG.md` tail (both kept, `main`'s
first). On the rebased tree, without the entry, the guard reported
`tmpdir.test.ts` and nothing else: `main`'s other new code, #63's
`test/shims/importer.ts` and #65's rewritten CLI tests among it, keeps the stricter
rule as written. The guard commit carries the entry (§3.2); with it, 240/240.

## 7. What this still cannot see

What §1 asked for is closed: (a) for every spelling of the temp root in §3.2; (b) by
construction, for company.ts and the four rigs alike; (c) by refusal; (d) per
directory, by scope. These remain, recorded rather than closed because each needs a
different kind of analysis, or does not occur here:

| Residual | Why it is left |
|---|---|
| **Cadence.** A directory made per test but removed once — `beforeEach(() => { root = mkdtemp() })` with `afterAll(() => removeTempDir(root))`, a list reset by `temps = []` or `temps.length = 0` before its drain — removes only the last. A one-word edit of `home.test.ts` (`afterEach` → `afterAll`) leaks 11 of its 12 homes with the guard green. | It needs to know how often each hook runs, and that a variable's next value replaces the last. Every such pair in the tree today is matched. |
| **Hook scope.** A drain hook inside one `describe` empties a file-level list for that `describe`'s tests only; a maker used by tests elsewhere leaks there. A removal hook in a skipped suite never runs. | It needs to map hooks to the tests they apply to. Each of the seven describe-scoped drains in the tree empties a list declared inside the same `describe` (read 2026-10-02). |
| **Path-insensitivity.** A removal counts whether or not the branch around it is taken: after an early `return`, under an `if` that is never true, under an inverted condition on a push (`if (reuse !== undefined) temps.push(home)`). | Deciding it needs control flow, not a value graph. |
| **Red-path leaks.** A removal at the end of a test body, after assertions, does not run when an assertion fails: `control-server.test.ts` makes and removes three homes that way, and `agent-worktree.test.ts`'s `afterEach` removes its temps after closers that can throw. | The rule asks whether a removal runs, not whether it runs on failure; requiring `finally` or a hook for every directory is a policy change. These leaks are bounded by the global sweep (two hours) for `eph-*` names. |
| **Closures handed to calls.** A removal inside a callback counts whenever its enclosing code runs: `server.on('close', () => removeTempDir(home))` for an event that never fires, a `setTimeout(…).unref()` that never fires, a `process.on('exit')` handler vitest's fork kill may not run. | Deciding it needs to know what each callee does with a function. |
| **Lists partly emptied in a loop.** `for (const dir of temps.slice(1))`, a loop that `break`s. | The values are followed, not the iteration. |
| **A variable reassigned before its removal.** `let home = mkdtemp(); … home = other; removeTempDir(home)` credits the removal to both. | Flow-insensitive by design. The four directory variables in the tree that are assigned rather than declared (`gates.test.ts`, `home.test.ts`, two in `pin.ts`) are each removed before they are assigned again. |
| **Methods by name.** A class method runs when any property access of its name is called, so two classes' methods sharing a name share the verdict — as the rule's `inTest` does for every function. | A method call's object would need its type; plain functions are matched by symbol since §3.4. |
| **What other code makes.** The rule reads files under `test/` only. A directory production code creates on the temp root, or one a spawned program creates outside a directory the test made, or a sibling a test makes from one (`fs.cpSync(home, home + '-copy')`, `path.dirname(home)`), is not seen. | Production code never touches the temp root (only `spawn-env.ts` passes `TMPDIR` through); programs a test spawns write inside the directory the test gives them. |
| **Other spellings of the temp root.** A literal (`'/tmp/x'`), `os.tmpdir` held in a variable and called under another name, `const { tmpdir: t } = os` from an existing binding, `env.TMPDIR` read from a copy of `process.env`, Electron's `app.getPath('temp')`. | Seven files under `test/` spell a `'/tmp…'` literal, every one as data that is never created (`'/tmp/eph/events.sock'`, `'/tmp/repo'`); the eighth, `s-secrets.test.ts`, uses `'/tmp'` as the fallback of an mkdtemp prefix. Flagging literals would be seven allowlist entries saying "data". The other spellings do not occur in `test/`. |
| **Removal that does not finish.** `void fsp.rm(dir, { recursive: true })` never awaited; `try { removeTempDir(d) } catch {}` swallowing the failure; a helper that removes in a `finally` while an async callback it did not await still uses the directory. | Each is a removal that runs; whether it succeeds is `removeTempDir`'s contract (it throws after its budget), which these shapes defeat on purpose. None occurs in the tree. |
| **False positives, by decision.** A directory removed through an object's property, a list drained through a copy, a local remover helper, a cleanup closure the test does call, a prefix built outside the mkdtemp call (`const PREFIX = path.join(os.tmpdir(), 'eph-x-')`), a directory nested in one already removed recursively, class fields and array literals holding directories. | Each needs values followed through objects, parameters or containment. Each fault names a shape that passes; none occurs in the tree. |
| **The order company.ts relies on.** `afterAll(cleanupHomes)` is safe only while vitest runs after-hooks last-registered first, and isolates each file so that every scenario registers the hook. The tripwire catches a changed `sequence.hooks`; it would also fail, misleadingly, under `sequence.shuffle`, since it observes order across two tests; `isolate: false` is not tripwired. | Configuration changes nobody has proposed; the tripwire's name names the dependency. |

Noticed in passing, outside this change: `test/main/version-probe.test.ts` names its
directories `'eph probe-'`, with a space, which the global sweep's `eph-` prefix never
matches — harmless while the file removes them, but outside the backstop if it ever
does not.

This document supersedes these entries of §7 of
`docs/implementations/2026-10-02-temp-hygiene-requires-remover.md`:

- its first two bullets, which it handed to this change: the helper-made directory
  nobody removes (closed by construction, §3.4), the future `makeTempDir()` (closed by
  refusal, §3.4), the per-file removal check (closed, §3.3), and the temp directory
  made without `mkdtemp` in `gates.test.ts` (fixed, §3.1, and closed, §3.2);
- *in a file that reaches git, a temp root removed with `rmSync` inside a test body*:
  that root now has to reach `removeTempDir` like any other directory the file makes
  (§3.3), so position no longer has to tell it from a deliberate removal;
- the aliased `mkdtempSync` import (closed, §3.5).

Its other residuals stand as written there, `fs.rmSync.call(…)` and "two functions with
the same name share one verdict" included: §3.4 matches calls of plain functions by
symbol for the removal rule, but the raw-teardown rule's `inTest` still reads names.

## 8. Related docs

- `docs/implementations/2026-10-02-temp-hygiene-requires-remover.md` — the guard this
  extends, and why a git-running file must use `removeTempDir`.
- `docs/implementations/2026-09-01-flaky-temp-dir-teardown.md` — `removeTempDir` and
  the pin it waits out.
- `docs/TEST-STRATEGY.md` §2 — integration tests run on real fs and git in temp dirs,
  never mocked.
- `docs/ENGINEERING-STANDARDS.md` §6 — Definition of Done.
- `test/scenarios/company.ts`, `test/conformance/adapter-conformance.ts` — the two
  helpers that remove what they make from a module-level hook.
