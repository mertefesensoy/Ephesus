# GYM-009 — The single-committer tripwire reads the syntax tree, and proves it can see

**Status:** proposed · **Proposed:** 2026-10-02 · **Decided:** — ·
**Gate:** Architect approval **and a decision memo** — it alters a CI gate that
enforces invariant §4 (BUILD-PROMPT §3, ADR-0004), which ADR-0015's authority table
puts in its strictest class. No dependency is added. The memo's form in the build
phase is the Architect's call; GYM-006's gate decisions were recorded in
`docs/DECISIONS-LOG.md` (2026-09-02).

---

## Evidence

**The rule claims more than it checks, and nothing measures the gap.**
`src/main/git.ts:12` says a `git` call anywhere else "is a grep away, and CI greps for
it"; `docs/sdd/SDD.md:63` says "CI fails on a `git` call anywhere else". What CI runs
is one regex, `GIT_INVOCATION` (`scripts/check-invariants.cjs:56`): one of six
function names, an opening parenthesis, then `git` in quotes. Since PR #65 (recorded
as [GYM-010](./GYM-010-the-invariant-tripwires-read-the-whole-file.md)) it reads the
whole file instead of one line at a time. Four findings follow, each measured on
2026-10-02 and re-measured on `main` at `9723c10`, after #61–#66 had merged.

**1. An allowlist entry the rule never once saw passed for five weeks.** There are
twelve versions of `src/main/git.ts` on `main`. The first is `e878641` (2026-08-26),
the commit that wrote the rule beside it. The newest is `2366dc2` (2026-10-02, PR #62,
which moved the call to line 98). Every one gives **0** matches when the file is read
one line at a time, as the rule read it until #65, and 1 when it is read whole.
Prettier puts a long call's `'git'` on the line after its parenthesis. The other two
entries matched in every version (`scripts/arm-hooks.cjs` on 2 lines,
`scripts/check-attribution.cjs` on 1). #65 fixed the wrapping. It did not fix why the
blindness hid: **the git allowlist accepts an entry in which the rule finds nothing**,
on `main` today as before. `scripts/reachability.cjs:347-353` refuses exactly that for
its own allowlist ("names nothing unreachable any more"). With the same check, the
tree at `e878641` would have failed the day the rule was written.

**2. Read whole, the rule sees 7 of 25 shapes that start git. The one test that holds
it to an oracle shares its model.** The catalogue below has 25 modules that start git
and 6 that do not. Prettier 3.9.6 accepts each one unchanged under this repository's
`.prettierrc`, so the formatter half of `npm run lint` cannot keep any of them out.
Each was run through every candidate reader. The readers that exist in the tree were
lifted from their source text rather than retyped; the widened grep was written for
this comparison:

| # | Shape (each a whole module) | before #65, per line | `main` today, whole file | widened grep | hygiene derivation | this proposal (prototype) |
|---|---|---|---|---|---|---|
| 1 | `execFile('git', …)` on one line | ✓ | ✓ | ✓ | ✓ | ✓ |
| 2 | the same call wrapped by Prettier — `git.ts`'s shape | – | ✓ | ✓ | ✓ | ✓ |
| 3 | namespace import, `cp.execFile('git', …)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 4 | default import, `cp.spawnSync('git', …)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5 | inline `require('node:child_process').execFileSync('git', …)` | ✓ | ✓ | ✓ | **–** | ✓ |
| 6 | `execFile` taken from `await import('node:child_process')` | ✓ | ✓ | ✓ | **–** | ✓ |
| 7 | node-pty, `pty.spawn('git', …)` | ✓ | ✓ | ✓ | **–** | ✓ |
| 8 | a shell string, `execSync('git rev-parse HEAD')` | – | – | ✓ | ✓ | ✓ |
| 9 | `spawn('git log --oneline -1', { shell: true })` | – | – | ✓ | ✓ | ✓ |
| 10 | a template with a substitution, `` execSync(`git log -1 ${ref}`) `` | – | – | ✓ | ✓ | ✓ |
| 11 | the binary by path, `spawn('/usr/bin/git', …)` | – | – | ✓ | ✓ | ✓ |
| 12 | a Windows path, `'C:\\Program Files\\Git\\cmd\\Git.exe'` | – | – | ✓ | ✓ | ✓ |
| 13 | bare `'git.exe'` | – | – | ✓ | ✓ | ✓ |
| 14 | a renamed import, `import { execFile as run }` | – | – | – | ✓ | ✓ |
| 15 | `const { execFileSync: run } = require('node:child_process')` | – | – | – | ✓ | ✓ |
| 16 | `const run = promisify(execFile)`, then `run('git', …)` | – | – | – | ✓ | ✓ |
| 17 | `promisify(execFile)('git', …)`, inline | – | – | – | – | ✓ |
| 18 | `const GIT = 'git'`, then `execFile(GIT, …)` | – | – | – | – | ✓ |
| 19 | a comment inside the call, `execFile(/* … */ 'git', …)` | – | – | – | ✓ | ✓ |
| 20 | an optional call, `execFile?.('git', …)` | – | – | – | ✓ | ✓ |
| 21 | element access, `cp['execFile']('git', …)` | – | – | – | – | ✓ |
| 22 | runs a git-starting script, `execFileSync(process.execPath, [path.join('scripts', 'arm-hooks.cjs')])` | – | – | – | ✓ | ✓ |
| 23 | a shell wrapper, `spawn('sh', ['-c', 'git status'])` | – | – | – | – | residual |
| 24 | git mid-command-line, `execSync('cd agora && git init')` | – | – | – | – | residual |
| 25 | a program from a resolver, `execFile(which('git'), …)` | – | – | – | – | residual |
| | **shapes seen, of 25** | **6** | **7** | **13** | **16** | **22** |
| F1–F6 | **start no git:** a comment quoting a call · a message string quoting one · the Stoa's `'git'` source kind · `import { ExecGitRunner } from './git'` · `/^git (\S+)/.exec('git status')` · a grant `'Bash(git push origin HEAD)'` passed to another program | fails F1, F2 | fails F1, F2 | fails F1, F2, F5 | none | none |

Rows 8–18 cover the shapes §5.2 of #65's implementation record names, each with its
common variants. Rows 19–22 were found beyond that list, and rows
23–25 are proposed as residual. The "widened grep" is one dependency-free pattern
written to reach rows 8–13:

```text
/\b(?:execFile|execFileSync|exec|execSync|spawn|spawnSync)\s*\(\s*['"`](?:[^'"`\n]*[\\/])?git(?:\.exe)?(?=['"`\s])/i
```

Conditions: win32, node 20.16.0, typescript 6.0.3, Prettier 3.9.6 with the config
resolved for `src/main/agora.ts`. The per-line column is the rule at `cab9e1b`. The
whole-file column is `main` at `9723c10`, whose regex is byte-identical to the one in
#65's head. The derivation is `test/temp-hygiene.test.ts` as #64 merged it,
byte-identical to that PR's head `9a21f2e`. `fix/temp-hygiene-blind-spots`
(`4537c20`; stacked on #64, not pushed) changes the same test file, and its derivation
gives identical verdicts on all 31 probes. The harness and the prototype are scratch
files and are not committed. The package turns the catalogue into test cases.

- **#65's test oracle shares the regex's model.** `gitCalls`
  (`test/scripts/check-invariants.test.ts:159-204` on `main`) sees 9 shapes: rows 1–7,
  19 and 20. Every shape it misses, the regex misses too, because a callee name
  plus a literal `'git'` is the regex's model in a syntax tree. So the case "with the
  git allowlist emptied, names every git call the syntax tree finds, and nothing else"
  agrees with the rule because the two are blind to the same things. Agreement here is
  not corroboration.
- **The hygiene derivation is the right base, but it is not a superset of the regex.**
  `readHygiene` (`test/temp-hygiene.test.ts:361-633`, from #64) resolves names through
  the file's own bindings, so it sees 16 with no false positive. It misses rows 5–7,
  which the regex sees: it binds only `child_process`, and only through a static
  import or a named `require`. Its own record says the same about `await import()`
  ([`2026-10-02-temp-hygiene-requires-remover.md`](../../implementations/2026-10-02-temp-hygiene-requires-remover.md)
  §7). Rows 17, 18 and 21 are missed by every reader that exists today. Adopted
  unchanged, the derivation would trade some of the regex's reach for its own.

**3. Now that #64 has merged, the stronger observer gives the wrong remedy.**
`execSync('git rev-parse HEAD')`, the usual Node idiom for reading HEAD, was added to
`src/main/agents.ts`, which already imports `child_process`, in a copy of `main`'s
tree at `9723c10`:

- `node scripts/check-invariants.cjs`, CI's own step, printed **`invariants ok`** and
  exited 0;
- #64's premise test (`test/temp-hygiene.test.ts:1511-1521`) fails, because
  `agents.ts` becomes a door. That was evaluated with the test's own `doorsOf` over its
  own file selection. Its message (`:808-813`) tells the author to
  **"Update GIT_DOORS"**.

The one observer that sees the second committer tells its author to register it.

**4. The walk skips three module extensions.** `walk()`
(`scripts/check-invariants.cjs:111`) keeps `.ts .tsx .mjs .cjs .js`. A `.mts`, `.cts`
or `.jsx` file under `src/`, `shims/`, `scripts/` or `test/` is therefore read by no
rule: not the git rule, and not the secret-shape rule. `reachability.cjs:124` reads all
eight extensions. The repository already has a `.mts` file (`vitest.config.mts`, at
the root, outside the scanned directories).

**What the tree holds today.** Checked on `main` at `9723c10` two ways: by grep, and
by the syntax tree of all 219 modules under `src/`, `shims/` and `scripts/` (0 parse
diagnostics). The same checks on `cab9e1b`, earlier the same day, gave the same
answers, with `git.ts`'s call at line 69.

- git is started at exactly four call sites, all of them allowlisted:
  `src/main/git.ts:98`, `scripts/arm-hooks.cjs:13` and `:20`, and
  `scripts/check-attribution.cjs:99`. The whole-file regex, the hygiene derivation and
  the prototype all report those four.
- **None of the shapes in finding 2 occurs.** No process start is handed a command
  line, a path to git or `git.exe`. `promisify` appears nowhere. All eight
  `child_process` importers use plain named bindings: no rename, no namespace, no
  default import. The only constants holding `'git'` are the Stoa's source-kind labels
  (`src/shared/stoa.ts:40`, `:312`; `src/main/stoa.ts:194`), and no call receives
  them. No `.mts`, `.cts` or `.jsx` file exists under the four scanned directories.
- **Ten process starts exist, found by binding.** Five name their program in source:
  `'git'` four times, and `'gh'` through `GH_BINARY`. **Five take it at run time:**
  - `src/main/agents.ts:211`: the engine version probe;
  - `src/main/index.ts:2306`: the engine auth probe;
  - `src/main/library-mempalace.ts:361`: `options.command`, defaulting to the MemPalace
    binary;
  - `src/main/pty.ts:102`: the engine binary from the spawn plan;
  - `src/main/recall-probe.ts:81`: `shell: true` over the `EPH_RECALL` command line.

  No per-file reader, grep or tree, can say what these five run.

**What a syntax tree costs here.**

- **Nothing to install.** `node scripts/check-invariants.cjs` already loads
  `typescript`, at `reachability.cjs:71`. A copy of `main`'s two scripts run with no
  reachable `node_modules` stops with `Cannot find module 'typescript'`, so the CLI is
  not dependency-free today and has nothing to lose there.
- **About half a second locally.** Parsing all 219 modules took 0.41–0.60 s over
  three cold runs on win32. On the same machine the whole CLI took 3.4–16.9 s,
  depending on memory pressure; the slow runs had under 1 GB free. In CI, the
  "Invariant tripwires" step took 2 s on each of the last three `main` runs
  (`37053191234`, `37052298236`, `37009074924`).

---

## Proposal

Move the git rule from a regex to a reading of the syntax tree. Build it from the
hygiene derivation, widen it wherever the regex already sees more, and make the gate
prove that it can see.

**Files**

| File | What |
|---|---|
| `scripts/git-starts.cjs` | **new.** `gitStarts(rel, text)` returns every place a module starts git, as `{ line, how }`. Pure. It requires `typescript`, as `reachability.cjs` already does. |
| `scripts/check-invariants.cjs` | The git rule calls `gitStarts`. `walk()` reads every module extension. An allowlist entry the rule cannot see fails. The summary line reports what the rule read and what it could not. |
| `test/scripts/check-invariants.test.ts` | The finding-2 catalogue as named cases, plus the stale-entry, parse-failure, extension and superset cases. |
| `src/main/git.ts:7-12`, `docs/sdd/SDD.md:63` | Say what "a `git` call" now means, and point at the residual list below. |
| `docs/DECISIONS-LOG.md`, `docs/implementations/<date>-<slug>.md` | The record. |

**Mechanism**

1. **Where git starts, read from the tree.** `gitStarts` lifts the git half of
   `readHygiene`:
   - a name is resolved through the file's own bindings: renames, namespace and
     default imports, `require` destructuring, and a `promisify` held in a `const`;
   - a program is git if it is git by name, by path, or as `git.exe`, in any case
     (`GIT_PROGRAM`);
   - a command line counts if it starts with git, which is what `exec`, `execSync`
     and `shell: true` run (`GIT_COMMAND`);
   - a runner's arguments count if they name a git-starting script, with the scripts
     taken from `GIT_ALLOWLIST`.

   Comments, strings and import specifiers are never calls, which removes the regex's
   two false-positive classes (F1, F2). The script kind follows the file extension, as
   in `reachability.cjs:140-153`, so a `.jsx` file parses as JSX. A module the tree
   cannot parse cleanly fails rather than passes, as `reachability.cjs` fails a module
   it cannot read: "no git start found" in a broken tree is a check that cannot fail.
2. **Three additions, so the tree never sees less than the regex.**
   - **(a) Keep the regex's reach.** A call *named* like one of the six runners, on any
     receiver, whose first argument resolves to the git *program* is a git start. That
     covers rows 5–7 and 21. A command line counts only for a runner bound to
     `child_process`, so F5's `RegExp.exec('git status')` stays clean.
   - **(b) Inline `promisify`.** Read `promisify(runner)(…)` when it is called directly
     (row 17).
   - **(c) Same-file `const`.** Read a program held in a `const` in the same file, one
     hop (row 18).

   A throwaway prototype of exactly this, not committed, sees 22 of 25 shapes and 0 of
   the 6 non-git probes. On today's tree with the allowlist emptied, it finds exactly
   the four call sites listed under "What the tree holds today".
3. **Every module extension.** `walk()` reads the same set as reachability
   (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`), for every rule.
4. **An allowlist entry must be exercised.** An entry whose file starts no git fails,
   worded after `reachability.cjs:351`: the entry names a file in which the rule finds
   no git start, so remove it, or the rule has stopped seeing its call.
5. **Say what was read.** The summary line names the git starts the rule saw and the
   process starts whose program it could not read, for example
   `single committer: 4 git starts, all allowlisted; 5 process starts take their program at run time and were not read`.
   Every run then shows where the rule's sight ends, as the waivers in
   `test/fixtures/engine-output/PROVENANCE.json` do for engine probes.

**The cases**

- Each catalogue row is a case, planted in a module that is not allowlisted: under
  `src/`, or under `scripts/` for the `.cjs` shapes. It must fail on the line its call
  starts.
- A module that does not parse must fail, naming the file.
- Each residual row is a case pinned as passing and labelled residual, so widening the
  rule later shows up as a changed test.
- The six non-git probes must pass.
- **Superset.** On the real tree and on every fixture, every whole-file
  `GIT_INVOCATION` match must lie inside a call that `gitStarts` reports. Once the
  regex leaves the gate it stays in the test as the independent lower-bound oracle, so
  the tree reader is never checked only against itself.

Before the package closes, the rule gets an adversarial refutation pass, as the
seam-rule gates did (`docs/DECISIONS-LOG.md`, 2026-09-02). It uses the three lenses
from #64's record (§9.3): make it pass when it should fail, make it fail when it should
pass, and make it report something it did not measure. Each confirmed bypass becomes a
catalogue row, or a residual row with its reason. The pass also records what it tried
that held.

### Why the tree, and not a wider grep

The question is what each reader can see, and what it costs to keep trusted.
`check-invariants.cjs:91-92` already says what happens otherwise: "a tripwire nobody
trusts gets deleted".

| Option | Shapes seen (of 25) | Non-git probes failed (of 6) | On today's tree, and why not |
|---|---|---|---|
| Keep `main`'s whole-file regex (#65) | 7 | 2 | Reports the 4 allowlisted calls. Blind to rows 8–22. |
| Widen the grep: path prefix, `git.exe`, any case, a command line | 13 | 3 (adds F5) | Reports the 4 allowlisted calls. Each shape it adds brings a false-positive class with it, and it still cannot see a binding. |
| Ban the token `'git'` (or a path to it) outside the allowlist. Every route needs the name, so this is the only grep that sees a `const` or an alias | 19 | 4 (F1–F4) | **Fails at 10 places in 7 files**: the `./git` imports (`agora.ts:8`, `index.ts:24`), the three Stoa labels, a grant message, and four comments, two of them in the checker itself. It still fails at 6 places in 5 files if it skips comments. It also loses the shell strings, rows 8–10. |
| Ban the precursor idioms instead: renamed runner imports, `promisify(execFile)`, a `const` holding git | at most 18 with the widened grep, by construction | not measured | Forbids those idioms for every program, `gh` and the MemPalace binary included. A rename pattern written as text already misfires: `spawn\s*:` matches `readonly spawn: SpawnRequest` (`src/shared/profile-activation.ts:239`). |
| Adopt the hygiene derivation unchanged | 16 | 0 | Reports the 4 allowlisted calls, but loses rows 5–7, which the regex sees today. |
| **The tree: the hygiene derivation plus (a)–(c)** | **22** | **0** | **Reports the 4 allowlisted calls.** |
| Type-aware data flow (`ts.Program`) to follow the run-time programs | not measured | not measured | Needs a type-checked program over the whole tree, and still has no answer for an environment variable or a config value. Rejected; the five sites are recorded as residual. |
| Wrap `child_process` at run time in main | not measured | not measured | Patches Node core, fails in front of the Architect instead of in CI, and cannot see `scripts/` or `shims/`. Rejected. |
| Restrict who may import `child_process` (ESLint `no-restricted-imports`) | not measured | not measured | Pins which files may start any process at all, but cannot see a git call added to the eight files that already import it, `index.ts` and `agents.ts` among them. A complement, not a replacement; a separate proposal if wanted. |

"Not measured" means the option was rejected on its cost, not on its reach.

**A grep has a hard ceiling here.** A renamed import, a `promisify`d runner and a
`const` each put a different identifier where the runner or program was. A pattern
that sees through them has to match the token `'git'` itself, and outside the
allowlist that token appears, as data or prose, at ten places today. The tree reads
what a call runs. Keeping the gate dependency-free is not a reason to stay with the
grep, because the CLI already requires `typescript`.

**Order.** Both changes this builds on are on `main`:

- #65 (GYM-010), for whole-file matching, the importable `fileFailures`, the test
  file and its fixture-tree CLI case;
- #64, for the derivation being lifted.

The package can start on approval. If `fix/temp-hygiene-blind-spots` lands first, the
lift follows the version on `main`. #62 moved `git.ts`'s call from line 69 to 98 while
this was being written, which is why no case hard-codes a line.

**Not in this package.**

- **One derivation for both guards.** Pointing #64's guard at `gitStarts` so one
  derivation serves both is the natural next step. It changes a second guard's
  verdicts and needs its own measurement, so it is a follow-up.
- **Stale checks on the checker's other allowlists.** These are not proposed.
  `ui-bridge.ts` and `FloorCanvas.tsx` are exercised today (`ui-bridge.ts:126`;
  `FloorCanvas.tsx:531`, `:535`, `:577`). `ENV_SECRET_ALLOWED_DIRS` is ADR-0010's
  policy scope, not a record of a call: nothing under `watch/` or `herald/` reads the
  environment at all.

---

## Cost & risk

**Effort:** one work package. Roughly 100 lines lifted from the derivation, 40 for
the three additions, 40 in the checker and 250 of table-driven tests. On top of that
come the record and a mutation round with a certified control. The round uses
`scripts/mutate.cjs` if GYM-008 has landed. Otherwise it follows GYM-008's nine
requirements by hand, as the 2026-10-02 rounds on both source branches did.

**Blast radius**

- **Extensions.** Every rule's file set gains three extensions. No such file exists
  today, so no output changes.
- **The git rule.** Its verdict on today's tree is unchanged: 4 starts, all allowlisted
  (measured).
- **CI time.** Roughly half a second more on a step that takes about 2 s. That figure
  was measured on win32; linux was not measured.

**What could regress**

- **A false-positive class the catalogue missed.** The construction bounds it: a
  comment, a string and an import specifier are never calls. The six probes bound it
  too, and the partial rollback below contains it. The window metric counts it.
- **A file that does not parse.** `ts.createSourceFile` never throws, and a broken file
  yields a partial tree, which could hide a call. Mechanism 1 makes such a file fail
  by name. CI also runs typecheck and lint before the tripwire
  (`.github/workflows/ci.yml:84`, `:87`, then `:90`), so a syntax error usually fails
  an earlier step first.
- **Two derivations drift.** Until the follow-up, `readHygiene` and `gitStarts` answer
  one question twice. The disagreement is recorded and goes one way only: the gate
  sees more.
- **The oracle loses its independence.** The superset case keeps the regex as an
  observer that shares no code with the tree reader.

**What it still cannot see.** These are recorded in the module's header and in the
test's residual cases:

- **A shell wrapper** (`sh -c`, `cmd /c`), **git mid-command-line**, and **a program
  from a resolver** (`which('git')`). Today a shell is requested at two sites
  (`index.ts:2306`, on win32 only, and `recall-probe.ts:81`), and neither has a literal
  command. `exec` and `execSync` are not imported anywhere.
- **A program chosen at run time:** the five sites listed under "What the tree holds
  today". A per-file reader cannot follow `spec.versionProbe.command` across modules.
  The summary line counts these sites on every run instead of passing over them in
  silence. The M9 plan (`docs/M9-PLAN.md`, #66) gives a native engine under
  `src/engine/` a `shell` tool. That is one more start whose command line is chosen at
  run time, and the summary line is where it will show.
- **Deliberate evasion:** computed names, `eval`, a program assembled from pieces. A
  tripwire is for the honest mistake; review is for the rest.

`docs/THREAT-MODEL.md` §5 lists runtime controls only and has no row for this
build-time check, so nothing there changes. That was checked, as ENGINEERING-STANDARDS
§5 asks of a changed rule.

---

## Success metric

Measured when the package lands and again 14 days later. All three parts must hold.

1. **Reach.** All 25 in-scope cases fail the CLI by file and line. They are the 22
   in-scope catalogue rows, plus a git call in a `.mts`, a `.cts` and a `.jsx` file.
   Before #65 the gate failed 6 of them, and `main` today fails 7. The 3 residual rows
   are pinned as passing.
2. **No new noise.**
   - The 6 non-git probes pass; the regex fails 2 of them today.
   - On the real tree with `GIT_ALLOWLIST` emptied, the rule reports exactly the call
     sites the whole-file regex reports (4, in 3 files), and the superset case holds.
   - **Zero** CI runs, on `main` or on any PR in the 14 days after landing, fail on
     this rule for a call that starts no git. The count comes from the run logs.
3. **No dead entry.** A case removes the git call from an allowlisted file and requires
   exit 1 naming the entry. The summary line reports how many git starts the rule found
   in allowlisted files.

**The metric FAILS** if any of these happens:

- an in-scope case passes;
- a false positive reaches CI within the window;
- an allowlisted file with no git start passes the CLI.

A regression in the window is recorded as `regressed` and rolled back as below.

Guard, not goal: the "Invariant tripwires" CI step stays under 5 s (about 2 s today).

---

## Rollback

Revert the package's commits. The gate goes back to the whole-file regex of #65
(GYM-010), so the wrapping blind spot does not return.
`scripts/git-starts.cjs` has no other consumer, and nothing is persisted: no schema,
no data, no dependency.

A partial rollback is the more likely case. If one addition produces a false-positive
class, remove that addition and move its catalogue rows to the residual cases with the
reason. That is a one-row test change per shape, and the ledger records the withdrawn
part.

---

## Related

- [`ADR-0004`](../../adr/ADR-0004-agora-single-committer.md): the single committer the
  rule enforces; BUILD-PROMPT §3, invariant 4
- [`ENGINEERING-STANDARDS`](../../ENGINEERING-STANDARDS.md) §3 (an altered CI gate goes
  through the Gymnasium), §5 (tripwires, and the threat-model check), §6.7 (an
  allowlist entry carries its decision)
- `scripts/reachability.cjs`: the stale-entry check (`:347-353`), the extension set
  (`:124`) and the `typescript` load (`:71`) this proposal reuses
- [`2026-10-02-invariants-see-wrapped-calls.md`](../../implementations/2026-10-02-invariants-see-wrapped-calls.md)
  §5.2: the list this proposal measures (#65)
- [`2026-10-02-temp-hygiene-requires-remover.md`](../../implementations/2026-10-02-temp-hygiene-requires-remover.md)
  §4.2, §7 and §9.2–9.3: the derivation, its own blind spots, and its two mutation
  rounds (#64)
- `docs/DECISIONS-LOG.md`:
  - 2026-08-26 (M2.1, the rule);
  - 2026-08-27 (the scripts allowlist; the `test/` scope);
  - 2026-09-02 (GYM-006; the seam-rule gates refuted before close);
  - 2026-10-02 (the gate fix, ledger row GYM-010).
- [`GYM-010`](./GYM-010-the-invariant-tripwires-read-the-whole-file.md): the whole-file
  read this proposal builds on, decided separately
- [`GYM-005`](./GYM-005-adr-append-only-check-fix.md): a gate fix that took a ledger
  row
- [`GYM-006`](./GYM-006-coverage-floors-and-the-seam-rule.md): a gate whose allowlist
  entries carry decisions and fail when stale
- [`GYM-008`](./GYM-008-a-mutation-round-is-a-tool-not-a-scratch-script.md): the
  mutation tool the verification round uses
- [`ADR-0015`](../../adr/ADR-0015-gymnasium-self-improvement.md): the loop this
  proposal is filed under
