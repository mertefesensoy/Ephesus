# The invariant tripwires see what Prettier wraps

**Date:** 2026-10-02 · **Branch:** `fix/invariants-see-wrapped-calls` (from `main` at
`cab9e1b`) · **Commits:** `1971a28` (the fix and its tests), `fa0aeaf` (a parameter no
caller varied, removed), and the commit carrying this document.

---

## 1. Problem / motivation

ADR-0004 gives the running app exactly one committer, `src/main/git.ts`, because
concurrent `git` processes corrupt `.git/index.lock`. Its own header says what makes the
claim checkable: *"a `git` call anywhere else is a grep away, and CI greps for it."* The
grep is the single-committer rule in `scripts/check-invariants.cjs`:

```js
const GIT_INVOCATION = /(execFile|execFileSync|exec|execSync|spawn|spawnSync)\s*\(\s*['"`]git['"`]/
```

and it was tested **one line at a time** (`text.split('\n').forEach(…)`). The `\s*`
between the parenthesis and the `'git'` can only span a line break when it is handed the
text the line break is in, so a call whose `'git'` sits on the next line never matched.
That is exactly what Prettier writes for a call too long for one line, and it is the
shape of the one call in `src/main/git.ts`.

**Measured** with the checker's own regex, lifted from its source rather than retyped:

| File | Per-line matches (as checked) | Whole-file matches | Line the call starts |
|---|---|---|---|
| `src/main/git.ts` (allowlisted) | **0** | 1 | 69 |
| `scripts/arm-hooks.cjs` (allowlisted) | 2 | 2 | 13, 20 |
| `scripts/check-attribution.cjs` (allowlisted) | 1 | 1 | 99 |
| `test/scripts/check-attribution.test.ts` (rule does not apply to `test/`) | 2 | 3 | 80, 255, 294 |
| every other file under `src/`, `shims/`, `scripts/` | 0 | 0 | — |

The `git.ts` row holds for **every version of the file**: all eleven commits that touch
it, from `e878641` (2026-08-26, which wrote the rule beside it) to `d7d02ba`
(2026-09-10), measure 0 per line and 1 whole-file. The allowlist entry naming `git.ts`
was never exercised once in five weeks, and the rule's eyesight ended at calls short
enough to fit on one line.

**The consequence, demonstrated rather than argued.** A Prettier-formatted git call
appended to `src/main/agora.ts`, which is a real, reachable module, so reachability adds
no noise of its own. `prettier --check` accepts the planted file, so `npm run lint`
would too:

```text
=== plant: wrapped — appended at line 614; prettier --check would PASS
  614 | export function probeGit(cwd: string): void {
  615 |   execFile(
  616 |     'git',
  617 |     ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=dirty'],
  618 |     { cwd, windowsHide: true },
  619 |     () => undefined
  620 |   )
  621 | }
main's checker:  exit 0  > invariants ok (src, shims, scripts, test; reachability 189/199 …)
this branch:     exit 1  > src\main\agora.ts:615  git is invoked outside src/main/git.ts — ADR-0004 allows exactly one committer

=== plant: one-line — `execFile('git', ['status'], { cwd }, () => undefined)` at line 615
main's checker:  exit 1  > src\main\agora.ts:615  git is invoked outside src/main/git.ts — …
this branch:     exit 1  > src\main\agora.ts:615  git is invoked outside src/main/git.ts — …
```

Each plant was restored by writing back the original bytes, and the file was checked
against `HEAD`'s blob by hash and by `git status`.

## 2. What changed

| File | Change |
|---|---|
| `scripts/check-invariants.cjs` | The git, truncating-write and ledger-rewrite rules match the whole file text and report the line each match starts on (`matchLines`). The four per-line rules are untouched. The scan is exposed as `fileFailures(rel, text, gitAllowlist?)` and `invariantFailures(gitAllowlist?)` behind a `require.main === module` guard, the shape `reachability.cjs`, `check-coverage.cjs` and `check-attribution.cjs` already have, with `main()` returning the exit status. The CLI's output on this tree is byte-identical to `main`'s. |
| `test/scripts/check-invariants.test.ts` | **New.** 20 cases, listed in §3.4. |
| `docs/DECISIONS-LOG.md` | One entry: the fix, and why it is a log entry rather than a Gymnasium ledger row (§5.1). |
| `docs/implementations/2026-10-02-invariants-see-wrapped-calls.md` | This document. |

## 3. Implementation approach

### 3.1 Which rules shared the blind spot

The task was to check every rule in the per-line loop for the same defect, so each was
measured against the thing that actually decides line layout in this repository.
`npm run lint` runs `prettier --check .` over `src/`, `shims/`, `scripts/` and `test/`,
so the only multi-line shapes that can land there are the ones Prettier writes, plus the
inside of template literals and comments, which it never reflows. The repository's own
Prettier (3.9.6, `.prettierrc`: `printWidth: 100`, no semicolons, single quotes) was
handed one over-long line per construct, by
`prettier.format(line, { ...resolveConfig('src/main/…'), parser: 'typescript' })`, and
each rule (its regex lifted from the checker's source) was run over the output both
ways:

| Rule | What Prettier did to a long line | Per-line / whole-file matches after formatting | Shares the blind spot? |
|---|---|---|---|
| `GIT_INVOCATION` | `execFile(` ⏎ `'git',` ⏎ … — every argument on its own line; same for `spawn`. When the last argument is an object it can hug, Prettier keeps `'git'` on the call's line instead (`execFileSync('git', […], {` ⏎ …), which is why the rule caught some long calls and not others | **0** / 1, and **0** / 1; 1 / 1 for the hugged one | **Yes.** It is `git.ts`'s shape. |
| `TRUNCATING_LOG_WRITE` `/writeFileSync\s*\([^)]*\b(log\.jsonl\|cost_ledger\|costLedger)\b/` | `fs.writeFileSync(` ⏎ `path.join(home, 'agora', 'log.jsonl'),` ⏎ … | **0** / 1 | **Yes.** The path moves to the line after the parenthesis. |
| `LEDGER_REWRITE` `/(UPDATE\|DELETE\s+FROM)\s+cost_ledger\b/i` | Nothing: Prettier does not format SQL inside a template literal | — | **Yes, by hand.** `src/main/db.ts` already wraps its SQL at clause boundaries (`SELECT …` ⏎ `FROM cost_ledger …`, lines 126–127), so a `DELETE` ⏎ `FROM cost_ledger` or an `UPDATE` ⏎ `cost_ledger` is the house style applied to a forbidden statement. |
| `RENDERER_CLOCK` (floor models) | Wrapped the surrounding call; `Date.now()`, `new Date(`, `setInterval(`, `requestAnimationFrame(` each stayed whole on one line | 1 / 1 for each | No |
| `RENDERER_SEND` `/\bwebContents\s*\.\s*send\s*\(/` | Wrapped the arguments; in a broken member chain the group `.webContents.send(…)` stayed on one line | 1 / 1, 1 / 1 | No |
| `ENV_SECRET_READ` | Broke after the `=`, never inside `process.env.X` or `process.env['X']` | 2 / 2, 1 / 1 | No |
| `SECRET_SHAPED` | A credential is one string-literal token; Prettier never splits a string | — | No |

Outside the loop, the engine-probe check in section 6 also reads per line
(`/\bversionProbe\s*:/`), but Prettier never separates a property key from its colon,
and its own comment already says that collapsing a declaration onto one line evades
nothing. It does not share the defect.

So the three rules that span tokens a formatter or an author puts on different lines now
read the whole file. The four that hunt for spans the formatter keeps whole stay per
line, which also keeps the clock rule's comment-line skip, a per-line idea, exactly as
it was. Those four can still be split by a comment placed inside the expression or by
unformatted code; the first is deliberate evasion of the kind no grep resists, and lint
rejects the second before it can land.

### 3.2 The change

```js
function matchLines(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const starts = [...text.matchAll(new RegExp(pattern.source, flags))].map(
    (match) => text.slice(0, match.index).split('\n').length
  )
  return [...new Set(starts)]
}
```

`fileFailures` runs the three whole-file rules first, then the unchanged per-line loop.
Failure text is unchanged: `<file>:<line>  <why>`. Two matches starting on one line are
reported once, which keeps the old loop's granularity of one failure per offending line.
The messages are word-for-word the old ones, and so is the CLI: on this tree, main's
checker and this one print the identical `invariants ok (…)` line and exit 0.

### 3.3 Why the checker had to become importable

`check-invariants.cjs` was a top-level script whose only output was its exit status
over the real repository, so nothing could feed it a case it must fail without writing
into the tree. The scan is now two functions behind a `require.main === module` guard,
the pattern four sibling scripts already follow. `main()` composes the per-file rules,
`reachabilityFailures()` and the engine-provenance check, which moved verbatim into
`provenanceFailures()`. `git diff -w` shows only the function's opening and closing, and
an early `return` where its `else` was. Requiring the module runs nothing, which a test
asserts.

### 3.4 The tests, and what each can tell apart

| Case | Proves |
|---|---|
| a git call Prettier has wrapped fails, on the line the call starts | the defect, on the formatter's own output (line 4, not the `'git'` line 5) |
| a one-line git call still fails | nothing the old rule caught is lost |
| every call in a file is named, each line once | all matches, not the first; two calls on one line are one failure; a template-literal `` `git` `` call wrapped |
| `test/` is left alone | TEST-STRATEGY §6's real-git integration tests stay legal |
| real `git.ts`: **wraps** its git call | the premise, checked: at least one call's `'git'` is on a later line than the call, and that call's line alone does not match the rule |
| real `git.ts`: **is seen** | the same text at any other path fails, on exactly the lines the syntax tree gives |
| real `git.ts`: **is allowed** | at its own path every rule passes, so the allowlist entry is exercised |
| this repository, git allowlist emptied | the rule names every git call the **TypeScript syntax tree** finds in `src/`, `shims/`, `scripts/`, at the line the call starts, and nothing else; not vacuous, because `git.ts` must be among them |
| this repository, allowlist as written | no git failure, so the allowlist matches the paths the walk produces on this platform |
| a `writeFileSync` with its log path on the next line fails | the truncating-write blind spot |
| ledger SQL with verb and table on different lines fails | the ledger blind spot, for `DELETE` ⏎ `FROM cost_ledger` and `UPDATE` ⏎ `cost_ledger` |
| one-line forms still fail; `INSERT INTO cost_ledger`, `UPDATE cost_fold_cursor`, appends and other files pass | no false positive on the writes that are legal |
| four per-line cases | the clock rule (comment skip, `FloorCanvas.tsx` exemption), the bridge, the environment rule (`EPH_*` exemption, `watch/`), secrets in `test/`; the move into `fileFailures` changed none of them |
| the CLI exits 0 over this repository | `main()` and the guard are wired as CI runs them |
| the CLI exits 1 and names a wrapped call **in a fixture tree** | a copy of `scripts/` is run inside a temp tree, resolving `typescript` through `NODE_PATH`, so the walk, the platform-separator allowlist and the `test/` exclusion are exercised end to end with no mock |
| requiring the module runs nothing | the guard |
| the fixtures are what Prettier writes | `prettier.check` on every wrapped fixture, so these are lint-clean shapes and not contrived ones |

Two choices keep the cases honest:

- **The syntax tree is the oracle for real files.** `gitCalls()` walks a
  `ts.createSourceFile` tree for calls to the six functions whose first argument is the
  literal `git`, and returns the line of the callee and the line of the `'git'`. No line
  number is hard-coded, which mattered at once: PR #62 moved `git.ts`'s call from line 69
  to 98. The oracle shares no code with the regex, **but it asks the regex's own question**
  (one of six names, called with the literal `'git'`). Agreement therefore proves the
  regex reads every call of that shape wherever the line breaks fall. It proves nothing
  about shapes outside the question: a shell string, a path, an alias. GYM-009's
  catalogue found the oracle blind to 16 shapes, all of them among the regex's own misses.
  The first version of this document said the two "agree only by both being right", and
  that overclaimed (corrected after review, §5.3).
- **Nothing is mocked.** Real files are read from disk and the CLI is run as a process.
  The fixture tree is a real temp directory, removed with `removeTempDir`.

## 4. Mathematical / statistical details

**Line of a match.** For a match starting at character offset *i*,
line(*i*) = 1 + |{ *j* < *i* : text[*j*] = `\n` }|, so the reported line is the one the
match **starts** on (the callee, not the `'git'`). Counting `\n` alone gives the same
answer for a CRLF file, and `\s` spans `\r\n`. Both were probed on `git.ts` converted to
CRLF: line 69 at a foreign path, nothing at its own.

**The change can only fail more files, never fewer.** Let *P* be the set of per-line
matches in a file and *W* the whole-text matches (leftmost, non-overlapping).

1. Every per-line match is a substring of the text, so *P* ≠ ∅ ⇒ the pattern matches
   the text ⇒ *W* ≠ ∅. A file the old loop failed still fails, and the allowlist is
   per-file and unchanged.
2. A one-line match starts on the line the old loop reported, with the same message.
   A match in *P* can only be missed by *W* if an earlier whole-text match overlaps it.
   For the git and ledger rules that cannot happen: an earlier match ends at the closing
   quote after `git`, or at `cost_ledger`, and no match can start inside those tokens.
   For the truncating-write rule it needs a `writeFileSync(` nested inside another
   `writeFileSync`'s arguments, before any `)`. Even then the file still fails, at the
   outer call's line.

So on any tree, the set of failing files grows monotonically. This tree's output is
unchanged because the only file that newly matches, `git.ts`, is allowlisted.

**Mutation scoring.** A run is **INVALID** if it wrote no JSON report, executed zero
tests, or ran a set of test files other than the two listed. It is **KILLED** if any
test or any test file failed. It is **SURVIVED** only if it was green with the
baseline's test count (32). The round is certified only if the control survives.

## 5. Design decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| Whole-file for the three rules that span tokens; per-line for the four that do not | Everything whole-file | The task asked that the other rules be kept unless they share the problem, and the measurement says they do not. The clock rule's comment skip is a per-line idea that would need re-deriving for whole-text matching, for no detection gain. |
| Report the line the match **starts** on | The line of the `'git'` | The start is the call a reader goes to. For a one-line call the two are the same line, so old messages are reproduced exactly. |
| One failure per line | One per match | The old loop's granularity. Two calls on one line are one place to fix. |
| Export functions behind `require.main` | An environment variable or CLI argument naming the root | A new input to a CI gate is a new way to point it somewhere else. The guard is the sibling scripts' existing pattern. |
| Test the CLI by running a copy of `scripts/` in a fixture tree | A `root` parameter on `invariantFailures` | The first version had one. No test passed anything but this repository's root, so a mutant ignoring it could not be killed. The parameter was removed in `fa0aeaf` instead of being kept as a seam nothing exercises. |
| Syntax-tree oracle | Hard-coded line 69 | Line 69 is already 98 on PR #62's branch. |
| No dead-allowlist failure in the gate | Fail an allowlist entry that matches nothing, as `reachability.cjs` does | That is a new failure mode, which is an altered gate, which is a Gymnasium proposal (§5.2). The test suite now holds the rule's eyesight against the syntax tree instead. |

### 5.1 A DECISIONS-LOG entry, not a Gymnasium ledger row

ENGINEERING-STANDARDS §3 calls an *altered* CI gate without a ledger entry a defect. The
question is whether a fix that restores a gate's documented behaviour is an alteration.
The repository's precedent is **split**, and both sides are recorded:

- **Ledger.** GYM-005 (2026-08-28) was a fix that also restored a check's documented
  intent: ADRs are append-only, so additions are legal. But it *loosened* the check, so
  that additions passed, and it changed how CI fetches history (`fetch-depth: 0`, the
  merge base, `set -e`). Whether it held depended on CI's environment, so it carried a
  standing metric that a probe could not settle. On the other side of the line are new
  gates and new costs: GYM-006 (new gates), GYM-007 (a three-run ratchet cost), the
  NUL-byte check RAISED instead of written (2026-08-31), and M6.10's floor-clock rule,
  faulted on 2026-09-02 for having no entry.
- **Log.** Fixes that make a rule match what it already claims to, proven by planted
  probes in both directions: the voice-SDK lint false positive (2026-08-29) and the
  `test/` scope correction (2026-08-27).

This fix is the second kind:

- no rule is added, no allowlist entry changes, nothing is loosened;
- it can only fail more files (§4), its correctness does not depend on CI's environment,
  and the behaviour it restores is the one this log recorded on 2026-08-26 (M2.1:
  "`scripts/check-invariants.cjs` fails CI on a `git` call anywhere else");
- the probe in §1 is the whole measurement, so a ledger row would have nothing left to
  measure.

If the Architect reads §3 as covering any edit to a gate script, the row is owed and this
document is its evidence.

### 5.2 Found, recorded, not done here

An adversarial pass on the git rule, looking for shapes it should catch and does not,
found blind spots that have nothing to do with wrapping. **None of them occurs in the
tree today** (each was grepped for):

- a shell-string command, `execSync('git rev-parse HEAD')` — the regex wants a quote
  right after `git`;
- the binary by path, `spawn('/usr/bin/git', …)` or `Git.exe`;
- indirection: `promisify(execFile)('git', …)`, a renamed import, a `const` holding
  `'git'`;
- source files with extensions the walk skips (`.mts`, `.cts`, `.jsx`), which no rule
  reads at all; `reachability.cjs`'s walk does include them;
- an allowlist entry that matches nothing passes silently, which is how this one stayed
  dead for five weeks. `reachability.cjs` already fails a stale entry.

Two more shapes, a comment between `(` and `'git'` and an optional call
`execFile?.('git')`, are seen by the syntax tree and not by the regex. If one appeared
in the real tree, the "allowlist emptied" case would fail on the disagreement. The
syntax-tree derivation of git's entry points on branch `fix/temp-hygiene-requires-remover`
already handles aliases, paths and `shell: true`, and is the obvious base for a stronger
rule. Every item above changes what the gate refuses, so it belongs in an `/improve`
proposal and not in this fix. That proposal is GYM-009 (status *proposed*, on branch
`docs/gym-009-git-tripwire-syntax-tree`). It builds on this change and does not cover it.

### 5.3 After review

The design review posted on the PR (2026-10-02, at `91e4f55`) found one blocker and
three smaller defects. The three are fixed:

- **The `test/` exemption no longer depends on the path separator.** The first version
  read the search directory back out of `rel` (`slashed(rel).split('/')[0]`). The walk
  it replaced had used its own loop variable. CI runs ubuntu, so the only mutant that
  could catch a wrong parse there (#11 in §6) died on win32 alone. Now
  `fileFailures(searchDir, rel, text)` takes the directory from the walk. A case passes
  `src` with a `test/` path and expects the app rules, so a parse fails it on every
  platform.
- **The CLI cases no longer inherit the caller's environment.** The three spawned
  children get `process.env` minus `NODE_OPTIONS`, and a 20 s timeout under vitest's 30 s.
  This follows `test/shims/eph-usage.test.ts` and the 2026-10-01 log entry. To
  demonstrate it, a `--require` module that writes to stderr stood in for a debugging
  terminal's bootloader. Under it the bare CLI writes `bootloader: attached` to stderr,
  which the old `stderr === ''` cases would have read as the checker's, and the test
  file passes 20 of 20.
- **The syntax-tree comparison now explains a disagreement.** A line only the rule
  names is a comment or string quoting a git call. A line only the tree names is a
  blind spot in the gate (GYM-009).

The oracle's overclaim is corrected in §3.4. The blocker is §5.1's question, whether
this change needed a Gymnasium ledger row. That is a ruling for the Architect, and the
outcome is recorded with the DECISIONS-LOG entry.

## 6. Verification

```bash
node scripts/check-invariants.cjs
```

```bash
npx vitest run test/scripts/check-invariants.test.ts test/shared/secret-shapes.test.ts
```

**The required gate**, `npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs`:

| Where, tree | typecheck | lint | invariants | test:coverage | check-coverage |
|---|---|---|---|---|---|
| OneDrive worktree, the `1971a28` tree (2.31 GB free) | ok | ok | ok | 238 files, 4660 passed, 8 skipped; **exit 1** from `EPERM … rmdir coverage\.tmp` after the report was written | ok on that run's report (11:58:58) |
| OneDrive worktree, the `fa0aeaf` tree (1.61 GB free) | ok | ok | ok | 238 files, 4660 passed, 8 skipped; same `EPERM` | ok on that run's report (12:05:50) |
| detached worktree outside OneDrive at `fa0aeaf` (2.68 GB free) | ok | ok | ok | 238 files, 4660 passed, 8 skipped, exit 0 | ok, **chain exit 0** |

The `EPERM` is the v8 provider losing its scratch-directory `rmdir` to OneDrive's file
handle. It was recorded in DECISIONS-LOG on 2026-09-07 and 2026-09-10, it comes after
every test has passed, and outside OneDrive the same tree's chain exits 0. The run for
this document's own commit is in its commit message.

**Mutation round** (§4 scoring). It ran from a scratch harness, because GYM-008's
`scripts/mutate.cjs` is approved but not built. The harness implements that proposal's
nine requirements:

- a declared no-op control;
- a green baseline before the first mutant;
- zero tests, or the wrong files, scored INVALID;
- every round file hashed before and after every run and after each restore;
- byte-exact writes;
- a committed tree restored with `git checkout --` and checked with `git status`;
- the files that ran, reported;
- every anchor matching exactly once;
- survivors stopping the round.

It ran in a detached worktree outside OneDrive at `fa0aeaf`, against
`test/scripts/check-invariants.test.ts` and `test/shared/secret-shapes.test.ts` (the two
files that load the checker), 32 tests at baseline. Free memory stayed between 2.23 and
3.05 GB, so no run waited.

| # | Mutant (in `scripts/check-invariants.cjs`) | Verdict | Killed by |
|---|---|---|---|
| 0 | **control:** edit a comment | **survived** — round certified | — |
| 1 | git rule per line again | killed | wrapped call; many calls; real `git.ts` seen; repository vs syntax tree; CLI in a fixture tree |
| 2 | truncating-write rule per line again | killed | the wrapped `writeFileSync` |
| 3 | ledger rule per line again | killed | the wrapped SQL |
| 4 | `git.ts` removed from the allowlist | killed | `git.ts` allowed; allowlist as written; CLI over this repository |
| 5 | allowlist ignored | killed | the same, and the fixture-tree CLI (its copies of `arm-hooks.cjs`, `check-attribution.cjs`) |
| 6 | report the line the match **ends** on | killed | 7 cases (the `'git'` line is not the call's) |
| 7 | line number off by one | killed | 9 cases |
| 8 | first match only | killed | many calls; repository vs syntax tree (`arm-hooks.cjs` has two); the SQL fixture (two statements); the one-line forms |
| 9 | no per-line de-duplication | killed | many calls (two on line 4) |
| 10 | `test/` held to the app rules | killed | 5 cases |
| 11 | scope read with raw separators | killed **on win32** | 5 cases. On linux `path.sep` is `/` and this mutant is equivalent: the `slashed()` it removes exists for Windows. **Review found this a defect, not a footnote.** CI runs ubuntu, so the rule deciding the `test/` exemption was tested on one platform only. The parse is gone (§5.3), and with it this mutant. |
| 12 | allowlist not passed through the walk | killed | repository vs syntax tree |
| 13 | CLI skips the per-file rules | killed | the fixture-tree CLI only |
| 14 | CLI exits 0 on failure | killed | the fixture-tree CLI only |
| 15 | guard runs `main()` on `require` | killed | the test file fails at import (`process.exit unexpectedly called`); the other file still ran 12 tests, so the run is valid |
| 16 | guard never runs | killed | both CLI cases |
| 17 | the checker not exempt from itself | killed | the self-exemption case; CLI over this repository (the checker's own comment at line 140 quotes a `webContents.send` call, so the exemption is load-bearing) |
| 18 | clock rule reads comments | killed | clock case; CLI over this repository |
| 19 | `webContents.send` allowlist ignored | killed | bridge case; CLI over this repository |
| 20 | `EPH_*` not exempt | killed | environment case; CLI over this repository |
| 21 | secrets checked in app dirs only | killed | the `test/` secret case |
| 22 | ledger rule case-sensitive | killed | the lower-case one-line form |

**22 of 22 killed, 0 survived, 0 invalid.** Mutants 13 and 14 are each killed by exactly
one case, the fixture-tree CLI run. That is the case that replaced the removed `root`
parameter, and without it both would survive. A clean round on mutants the author aimed
proves the tests are wired to what the author imagined. The adversarial pass in §5.2 is
what looked past that.

## 7. Related docs

- [ADR-0004 — the Agora's single committer](../adr/ADR-0004-agora-single-committer.md)
- [ENGINEERING-STANDARDS](../ENGINEERING-STANDARDS.md) §3 (process changes through the
  Gymnasium), §5 (grep-able tripwires in CI)
- [TEST-STRATEGY](../TEST-STRATEGY.md) §2, §6 (real git in temp dirs, which is why
  `test/` is exempt), §8
- [DECISIONS-LOG](../DECISIONS-LOG.md): 2026-08-26 (M2.1, the rule), 2026-08-27 (the
  script allowlist; the `test/` scope), 2026-08-29 (the lint false positive), 2026-09-02
  (a changed CI gate gets a ledger entry), 2026-09-07 and 2026-09-10 (the coverage
  `EPERM`), and this change's entry
- [GYM-005](../gymnasium/proposals/GYM-005-adr-append-only-check-fix.md) — the gate fix
  that did take a ledger row, and why
- [GYM-008](../gymnasium/proposals/GYM-008-a-mutation-round-is-a-tool-not-a-scratch-script.md)
  — the mutation tool this round's harness stands in for

## Appendix — the round's spec

Kept here because the harness that ran it is not checked in (GYM-008 is where it will
be). Each mutant replaces its `find`, which matched exactly once, in the pristine
`scripts/check-invariants.cjs` at `fa0aeaf`. The tests are run as
`vitest run <tests> --reporter=json --outputFile=<absolute path>`.

```json
{
  "target": "scripts/check-invariants.cjs",
  "tests": ["test/scripts/check-invariants.test.ts", "test/shared/secret-shapes.test.ts"],
  "mutants": [
    { "id": "control-comment-edit", "control": true,
      "find": " * once, in order.\n",
      "replace": " * once, in order. (Edited by the round's control: changes no behaviour.)\n" },
    { "id": "git-rule-per-line-again",
      "find": "      for (const line of matchLines(text, GIT_INVOCATION)) {",
      "replace": "      for (const line of text.split('\\n').flatMap((l, i) => (GIT_INVOCATION.test(l) ? [i + 1] : []))) {" },
    { "id": "write-rule-per-line-again",
      "find": "    for (const line of matchLines(text, TRUNCATING_LOG_WRITE)) {",
      "replace": "    for (const line of text.split('\\n').flatMap((l, i) => (TRUNCATING_LOG_WRITE.test(l) ? [i + 1] : []))) {" },
    { "id": "ledger-rule-per-line-again",
      "find": "    for (const line of matchLines(text, LEDGER_REWRITE)) {",
      "replace": "    for (const line of text.split('\\n').flatMap((l, i) => (LEDGER_REWRITE.test(l) ? [i + 1] : []))) {" },
    { "id": "git-ts-leaves-the-allowlist",
      "find": "  path.join('src', 'main', 'git.ts'),\n", "replace": "" },
    { "id": "allowlist-ignored",
      "find": "    if (!gitAllowlist.has(rel)) {", "replace": "    if (true) {" },
    { "id": "reports-the-line-the-match-ends",
      "find": "    (match) => text.slice(0, match.index).split('\\n').length",
      "replace": "    (match) => text.slice(0, match.index + match[0].length).split('\\n').length" },
    { "id": "line-off-by-one",
      "find": "    (match) => text.slice(0, match.index).split('\\n').length",
      "replace": "    (match) => text.slice(0, match.index).split('\\n').length - 1" },
    { "id": "first-match-only",
      "find": "  return [...new Set(starts)]", "replace": "  return [...new Set(starts)].slice(0, 1)" },
    { "id": "no-dedupe",
      "find": "  return [...new Set(starts)]", "replace": "  return starts" },
    { "id": "test-dir-held-to-app-rules",
      "find": "  const appRules = !SECRET_RULES_ONLY.includes(slashed(rel).split('/')[0])",
      "replace": "  const appRules = true" },
    { "id": "scope-read-with-raw-separators",
      "find": "  const appRules = !SECRET_RULES_ONLY.includes(slashed(rel).split('/')[0])",
      "replace": "  const appRules = !SECRET_RULES_ONLY.includes(rel.split('/')[0])" },
    { "id": "allowlist-not-passed-through",
      "find": "      failures.push(...fileFailures(rel, fs.readFileSync(file, 'utf8'), gitAllowlist))",
      "replace": "      failures.push(...fileFailures(rel, fs.readFileSync(file, 'utf8')))" },
    { "id": "cli-skips-the-file-rules",
      "find": "  const failures = [...invariantFailures(), ...reachabilityFailures(), ...provenanceFailures()]",
      "replace": "  const failures = [...reachabilityFailures(), ...provenanceFailures()]" },
    { "id": "cli-exits-0-on-failure",
      "find": "    console.error('')\n    return 1", "replace": "    console.error('')\n    return 0" },
    { "id": "guard-runs-on-require",
      "find": "if (require.main === module) process.exit(main())", "replace": "if (true) process.exit(main())" },
    { "id": "guard-never-runs",
      "find": "if (require.main === module) process.exit(main())", "replace": "if (false) process.exit(main())" },
    { "id": "checker-not-exempt-from-itself",
      "find": "    if (rel === SELF) return\n", "replace": "" },
    { "id": "clock-rule-reads-comments",
      "find": "    if (appRules && floorModel && !IS_COMMENT.test(line)) {",
      "replace": "    if (appRules && floorModel) {" },
    { "id": "send-allowlist-ignored",
      "find": "    if (appRules && RENDERER_SEND.test(line) && !RENDERER_SEND_ALLOWLIST.has(rel)) {",
      "replace": "    if (appRules && RENDERER_SEND.test(line)) {" },
    { "id": "harness-env-not-exempt",
      "find": "        if (SECRET_NAMED.test(match[0]) && !HARNESS_ENV.test(match[0])) {",
      "replace": "        if (SECRET_NAMED.test(match[0])) {" },
    { "id": "secrets-checked-in-app-dirs-only",
      "find": "    if (SECRET_SHAPED.test(line)) {",
      "replace": "    if (appRules && SECRET_SHAPED.test(line)) {" },
    { "id": "ledger-rule-case-sensitive",
      "find": "const LEDGER_REWRITE = /(UPDATE|DELETE\\s+FROM)\\s+cost_ledger\\b/i",
      "replace": "const LEDGER_REWRITE = /(UPDATE|DELETE\\s+FROM)\\s+cost_ledger\\b/" }
  ]
}
```
