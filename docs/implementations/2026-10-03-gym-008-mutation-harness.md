# A mutation round is a tool, not a scratch script (GYM-008)

**Date:** 2026-10-03 · **Branch:** `feature/gym-008-mutation-harness` (from `main` at
`6f6164d`) · **Commits:** `0468b6a` (the Architect's first answers, recorded before the
code), `8a6274b` (the tool, its tests, its own round and the two allowlist entries),
`6acf412` (the missing test the tool's first round found on itself), `ed03256` (the nine
findings of the first adversarial pass, closed), `b20f83b` (the kill rule decided after the
second), and the commit carrying this document.

---

## 1. Problem / motivation

A mutation round — plant one hand-aimed change in the code a package defends, run the
package's tests, put the file back — has been the third leg of this project's
verification bar since M8. It was never checked in. M8c alone ran eleven rounds, every
one driven by a script written into a session scratchpad and deleted with the session,
so the instrument was rebuilt from memory each time and its bugs recurred:

- **2026-09-09:** three M8b rounds reported perfect scores they had not earned. The
  suite's free-memory gate refused to start and exited 1, a red baseline made every
  mutant look killed, and a mutant from an earlier round was still in the tree. Each was
  caught only by a planted no-op control coming back "killed".
- **2026-10-02:** the first failure recurred, because a new scratch harness again scored
  by exit code: 14 of 28 runs executed zero tests and were reported as kills, three
  controls included. The same day OneDrive put a restored file back with the round's
  last mutant in it, seconds after its check had passed.

GYM-008, approved on 2026-09-10 and not built until now, makes the round a checked-in
tool with its spec checked in beside the tests, and turns the seven requirements those
failures produced, plus two more, into code paths with tests. M9-PLAN §6 then made it a
prerequisite: every M9 package owes a round from a checked-in `test/mutation/<package>.json`,
and that directory did not exist.

**The tool then repeated the history it was built to end.** Its 60 tests passed and two
rounds on itself came back clean, and an adversarial pass against hostile repositories
still made it issue nine kinds of verdict it had not earned (§3.6). They are closed here,
in the same package, because a measuring instrument that has not been refuted is the
scratch harness again with a filename.

## 2. What changed

| File | Change |
|---|---|
| `scripts/mutate.cjs` | **New.** Runs one round from one spec; the nine requirements and the nine refutation findings are its code paths; exit 0 OK, 1 survivors, 2 INVALID. |
| `test/scripts/mutate.test.ts` | **New.** 87 cases: spec validation, anchor counting, report reading and scoring, and the command line in process; and 29 cases that run the real command 31 times over a real git repository with a real nested vitest. |
| `test/mutation/gym-008.json` | **New.** The tool's own round: 43 mutants and a control against `scripts/mutate.cjs`. |
| `scripts/check-invariants.cjs` | `scripts/mutate.cjs` joins `GIT_ALLOWLIST` (Architect decision). |
| `test/temp-hygiene.test.ts` | `scripts/mutate.cjs` joins `GIT_DOORS`, which the guard's premise test demands of any script that starts git. |
| `docs/TEST-STRATEGY.md` | New §10, the mutation round: what it refuses, what it does not check, its eleven known limits and its trust boundary; a pointer from §2. |
| `docs/THREAT-MODEL.md` | New §6.9: the mutation round trusts the code it measures. |
| `docs/ENGINEERING-STANDARDS.md` | Definition of Done item 9: a gate- or rule-shaped change carries a round with a certified control. |
| `docs/gymnasium/LEDGER.md`, the GYM-008 proposal | Status `landed`; metric due 2026-10-17. |
| `docs/PROGRESS.md` | A note under M9 that its prerequisite landed; no box ticked. |
| `docs/DECISIONS-LOG.md` | The Architect's twenty-two answers and this change's mechanical choices. |

## 3. Implementation approach

### 3.1 The spec

`test/mutation/<package>.json`, `schemaVersion: 1`: `package`; `about`, the sentence the
round defends; `tests`, repository paths; `mutants`, each `{ id, file, find, replace,
why, control? }`. `specProblems()` refuses unknown keys, so a misspelt `control` is a
refusal rather than a spec that quietly has none; a `replace` equal to its `find`; a path
that is absolute, back-slashed, steps through `.`/`..`, or has a part beginning `-`
(vitest would read it as an option); `find` or `replace` text in malformed Unicode (a
lone surrogate is encoded as U+FFFD and would match text nobody wrote); a duplicate id;
and a spec with no control. The validator lives in the script (Architect decision; §5).

### 3.2 What a run means — read from the report, scored over the baseline's tests

Every run is `node <vitest.mjs> run <tests…> --reporter=json --outputFile=<absolute path
under %TEMP%>`. The output path is absolute because vitest resolves a relative one
against its own root. `filesOf()` reads the report into one entry per file — its
repository path, status, message and tests — and `classify()` scores that, together with
vitest's exit status, whether `--timeout` ended the run, and the set of tests that passed
at the baseline. Every shape below was produced by running vitest 4.1.11 on a fixture
(win32, node v20.16.0) before the rule that reads it was written:

| What happened | Report | Exit | Verdict |
|---|---|---|---|
| every test passed | `success: true` | 0 | pass |
| a test that passed at the baseline failed | that test `failed` | 1 | **kill** (test) |
| only a test the mutant switched on failed, or a hook threw around passing tests | a test or the file `failed` | 1 | **INVALID** |
| a module the test imports does not parse | 0 tests, the file `failed`, `Parse failure: …` | 1 | **kill** (file), named as one |
| global setup **throws** — what `test/global-setup.ts` does | a report holding **no file** | 1 | **INVALID**, retried |
| global setup **exits** | no report at all | 1 | **INVALID**, retried |
| the code under test kills the worker | `success: true`, the file `passed`, its test **`pending`** | 1 | **INVALID** |
| an unhandled rejection | `success: true`, every test `passed` | 1 | **INVALID** (a red baseline) |
| every test in a listed file skipped (`describe.skip`) | `success: true`, no test `passed` | 0 | **INVALID** at the baseline |
| a test that passed at the baseline skipped under the mutant | `success: true` | 0 | **INVALID** |
| a listed file did not run, or an unlisted one did | the file set differs from the listed set | — | **INVALID**, not retried |
| `--timeout` ended the run | none | — | **INVALID**, not retried |

Two exit-1 rows are kills and six are not, and the report's `success` flag is wrong in
two of the five. Neither the exit code nor the report alone separates them; the rule is
the report first, then the exit status, then the tests the baseline proved can pass.

### 3.3 A round, in order

1. Parse and validate the spec; find the repository root with `git rev-parse
   --show-toplevel` from the spec's directory.
2. The whole working tree must be clean — `git status --porcelain --untracked-files=all`
   empty; ignored files are not shown and not judged.
3. Every round file — the spec, the tests, each mutated file — must be a regular file,
   inside the repository by its real path (`fs.realpathSync.native`), with one hard
   link; tracked (`git ls-files -v`); holding the bytes git indexed (`git hash-object`
   against `git ls-files -s`); and carrying no `assume-unchanged` or `skip-worktree` flag.
4. Every anchor must match its file exactly once.
5. (`--check` stops here.) Cache every round file's bytes and hash them.
6. Baseline: one run, which must pass with at least one passing test in every listed
   file; afterwards no round file may hash differently and nothing else in the tree may
   have changed. Its passing tests — keyed by file, full name and place among same-named
   tests — are the set every later run is scored over.
7. For each mutant, in spec order: build the mutated bytes from the **cached** bytes,
   write them, run; then the target must still hold exactly the mutant, no other round
   file may hash differently, and nothing outside the round's files may have changed.
   Restore with `git checkout --`; every round file must hash as at the start and `git
   status` on them must be empty. A fault and a failed restore are reported together, the
   restore second.
8. A control that fails voids the round. A real mutant is killed when a test that passed
   at the baseline fails, or a listed file cannot load; any other failure is INVALID; one
   that passes is a survivor. Survivors print the triage question and the round exits 1.

The round's files are watched by their hashes and everything else by `git status`, and
the two never overlap. That is deliberate: two checks over the same ground are two checks
that cannot disagree, and a mutant deleting either would survive every test.

### 3.4 What was written and taken out again

Reviewing the first draft for guards no deterministic test could reach removed three:

- **A hash check before each mutant** ("changed between runs"). Building each mutant from
  the bytes cached at the start makes it redundant: a write landing before the mutant is
  written is overwritten by it, and one landing after is caught when the run ends.
- **A read-back after writing the mutant.** If the write did not land, the post-run
  comparison of the target against the mutant fails anyway.
- **A SIGINT handler that restored the file.** Windows cannot deliver a SIGINT a test
  can send. The round instead prints, before its first mutant, that an interrupted round
  leaves its mutant in the file, that `git status` shows it and `git checkout --`
  restores it — and the clean-tree rule makes the next round refuse to start until then.

And one mutant left the spec for the same reason: `R7-files-as-given` printed the listed
files instead of the files that ran. Once the two sets must be equal, they can differ only
in order, and no test can tell them apart.

### 3.5 The tests

The unit cases feed `specProblems`, `occurrences`/`mutate`, `filesOf`/`classify` (with
the report shapes of §3.2) and `parseArgs`/`main`. The integration cases run `node
scripts/mutate.cjs` over a temp git repository holding a module, its test, a global setup
that refuses the way the real one does, a tracked file outside the round, and a spec. The
fixture's test reads a `marker` a mutant can export and acts on it — writes a round file,
rewrites the mutated file, leaves a test file behind, writes the outside file, hangs — so
each refusal is reached by a real run rather than a stub. The nested vitest resolves from
this repository's `node_modules` (the fixture has none), and its config imports nothing
so a temp directory can load it. The fixture carries `.gitattributes` `* -text`, because
this machine's system git config sets `core.autocrlf=true` and a restore that rewrote
line endings would — correctly — be INVALID. The three cases the proposal names are each
a test: `refuses a spec with no control`, `refuses an anchor matching zero times`, `calls
a suite that refuses to start INVALID, never a kill`.

### 3.6 What the refutation pass broke, and how each closed

An independent pass tried 22 attacks across 18 fixture rounds against the tool at
`6acf412`. Every finding below was then reproduced against that commit in this session
before anything was changed, and every fix was the Architect's choice (DECISIONS-LOG
2026-10-03).

| Finding | What the tool did at `6acf412` | Closed by |
|---|---|---|
| `describe.skip` in a listed file | a baseline PASS with no test executed, then a survivor | a listed file must hold a test that passed at the baseline |
| the mutant kills the worker | SURVIVED — the test was left `pending` in a report saying `success` | the baseline's passing tests must each pass or fail; a non-zero exit with no failure is INVALID |
| an unhandled rejection | baseline PASS and ROUND OK while plain vitest exits 1 | a non-zero exit with no failure is INVALID |
| a test path `--testNamePattern=…` | vitest skipped every test; SURVIVED | a path part beginning `-` is refused |
| a mutant leaves a test file behind | the next mutant "killed" by the residue; ROUND OK, tree dirty | nothing outside the round may change during a run |
| a mutant writes a tracked non-round file | ROUND OK, tree dirty | the same |
| a hard-linked round file | the first mutant written stayed in the file outside the repository | one hard link |
| a junction on a round file's path | the mutant was written outside the repository while the suite ran | the real path must be inside the repository |
| `assume-unchanged` hiding an edit | the restore destroyed the uncommitted work | bytes must match the index blob; no index flag |
| `skip-worktree` | the restore failed and left the mutant, invisible to `git status` | no index flag |
| an anchor holding a lone surrogate | matched U+FFFD, text the author never wrote | malformed Unicode is refused |
| a run that hits `--timeout` | read as "the free-memory gate", retried at up to 3 × 900 s | INVALID with its own reason, not retried |

### 3.7 The second refutation pass, and what was decided

A second independent pass against `ed03256` found eleven more ways in. Nine were reproduced
in this session against that commit (F1–F5, F7–F10); F6 and F11 need a repository written
to deceive the round and were not. The Architect chose to **record all eleven as known
limits** (TEST-STRATEGY §10) and track them in issue #70 rather than close them here,
to **state the trust boundary** in TEST-STRATEGY §10 and THREAT-MODEL §6.9, and to change
one rule: **a kill needs a test that passed at the baseline to fail, or a listed file
that cannot load** (`b20f83b`). Before it, any failing test counted, including one a
mutant switched on that never passed. No third pass.

| Finding | Reproduced at `ed03256` |
|---|---|
| F1 a snapshot written into an ignored directory | `M1 killed`, `ROUND OK`, `!! __snapshots__/` left |
| F2 a same-named test stands in | `M1 SURVIVED` after `1 passed, 1 not run` |
| F3 one file reported twice (`projects`) | `baseline: PASS — 2 files, 1 passed: add.test.mjs, add.test.mjs`, `M1 SURVIVED` |
| F4 a test that commits | `ROUND OK`; four commits on the branch afterwards |
| F5 a submodule with `ignore = dirty` | `ROUND OK`; `?? state.txt` left inside it |
| F7 a clean filter hides an edit | status clean before; INVALID; the edit gone afterwards |
| F8 `text=auto` under `core.autocrlf=true` | status clean before; INVALID; the file rewritten to CRLF, status still clean |
| F9 a per-repository fsmonitor hook | `ROUND OK`; status `[]` with the hook, ` M other.txt` without it |
| F10 vitest `retry: 2` | `M1 SURVIVED` for a mutant whose first call fails |

The first pass also raised four points the Architect chose to leave as they are and document
in TEST-STRATEGY §10: `--check` exits 0 as a ROUND OK does; nothing verifies that a
control is a no-op; a listed test file may itself be mutated; and the nested vitest
inherits the author's environment.

## 4. Mathematical / statistical details

- **Anchor count.** `occurrences(h, n)` counts start offsets `i` with `h[i..i+|n|) = n`,
  advancing by one byte, so overlapping occurrences count: `occurrences("aaa", "aa") = 2`.
  A mutant is applicable iff the count is exactly 1. Counting non-overlapping matches
  would call `"aa"` in `"aaa"` unique while two different edits are possible.
- **Identity of a test.** `file › fullName #k`, where `k` is the test's place among the
  tests of that name in that file, so two same-named tests cannot stand in for each
  other. With `B` the set of tests that passed at the baseline and `P` the set that
  passed in a mutant run with no failure, the run is a pass iff `B ⊆ P`; otherwise it is
  INVALID. A failing test or file is a kill whatever `P` is.
- **Identity of a file.** SHA-256 of its bytes. With `C` the cached hash of each round
  file at the start and `M` the hash of the mutated bytes, a run's verdict stands iff,
  after the run, `hash(target) = M`, `hash(f) = C(f)` for every other round file `f`,
  and `git status` shows no path outside the round's files; and after the restore
  `hash(f) = C(f)` for every `f` and `git status` on them is empty.
- **Exit status.** With `R` the real mutants, `K ⊆ R` the killed ones and `c` the
  control: exit 0 iff `c` survived and `K = R`; exit 1 iff `c` survived and `K ⊂ R`;
  exit 2 whenever any run, check or restore could not be scored, `c` was killed, or the
  harness crashed. No score is printed as a percentage, by design (ENGINEERING-STANDARDS
  §6 item 9).

## 5. Design decisions

Asked through the questions workflow and recorded in DECISIONS-LOG on 2026-10-03:

1. **GYM-008 first** — chosen over starting M9 at M9.0, reconciling the ledger and
   reviewing PR #68 (which merged elsewhere while this session was reading). It does not
   lift the hold on the M9 build.
2. **The plan as presented**, including the Definition-of-Done item going in §6 where the
   proposal said §5 (§5 is the security section).
3. **The allowlist entries** — a deviation from the proposal's "no gate changes",
   recorded as one. Rejected: dropping requirement 6, and a separate ledger row first.
4. **Rounds run in place, every round file hashed.** Rejected: the tool making its own
   worktree outside OneDrive (it would own a junction-removal hazard); refusing OneDrive
   paths.
5. **The validator stays in the script** — the reading of invariant 9 for a development
   file only a script reads, as `coverage-floors.json` already is. Rejected: a validator
   in `src/shared/` behind a TypeScript runner, which is a new dependency.
6. **The metric is measured 2026-10-17**, two weeks after landing as it states.
7. **The session's `node_modules` is a junction** to a worktree whose 353 installed
   packages match this lockfile exactly — the condition of every figure below. One
   ordering slip, stated rather than left to be found: the junction was made and the
   session's first baseline (typecheck, lint, invariants on `6f6164d`) ran on it before
   this answer was written into DECISIONS-LOG in `0468b6a`.
8. **Every refutation finding closed here**, before landing. Rejected: closing only the
   wrong-verdict findings now; landing as it stood.
9. **Scored over the tests that passed at the baseline.** Rejected: refusing any skip,
   todo or `.only` (this suite's platform-gated skips would bar those files); requiring
   only one passing test per run.
10. **A report with no failure from a non-zero exit is INVALID.** Rejected: a kill when
    only the mutant causes it (a dead worker is also the out-of-memory signature); a
    reporter of the tool's own.
11. **The whole tree, and exactly the listed files.** Rejected: round files only;
    reporting extra test files without refusing them.
12. **Real path, one hard link, the indexed bytes, no index flag.** Rejected: the path
    and link checks alone.
13. **A timeout is INVALID and not retried.** Rejected: a kill; retrying.
14. **Dash-led path parts and malformed Unicode refused.**
15. **Four limits documented, not changed** (§3.6).
16. **The second pass's eleven findings recorded as known limits**, tracked as issue #70,
    opened with text the Architect approved. Rejected: closing the cheap ones now; isolating
    every mutant in its own worktree; a Gymnasium proposal; the session report only.
17. **The trust boundary stated in TEST-STRATEGY §10 and THREAT-MODEL §6.9.**
18. **A kill needs a test that passed at the baseline, or a file that cannot load**, made
    now with a fourth round. Rejected: any failing test; landing as round 3 left it.
19. **No third refutation pass.**
20. **The gate and the rounds wait for free memory** rather than run on a starved machine.

Rejected by the proposal itself and kept rejected: a generator (Stryker or similar) —
the rounds that paid were aimed by hand, and a generator mostly produces equivalent
mutants — and a CI job: a round rewrites source files and is an author's evidence.

Mechanical choices made under BUILD-PROMPT §8.2 are in DECISIONS-LOG under the same date
and were put to the Architect at the task report: the report-first scoring and the
retryable no-file report; the cached-bytes build and the three guards taken out; and a
fault reported together with a failed restore, with a crash read as INVALID.

## 6. Verification

All on win32 (Windows 11, 10.0.26200), node v20.16.0, git 2.53.0.windows.2, the licensed
art pack **absent** (a fresh worktree; it moves `terraces` coverage and the test count,
not this tool). Electron 37 is the pinned app runtime and is not exercised: the tool and
its tests run under plain node.

**The gate**, `npm run typecheck && npm run lint && node scripts/check-invariants.cjs &&
npm run test:coverage && node scripts/check-coverage.cjs`, run from a detached worktree
under `%TEMP%`:

- at `8a6274b`: exit 0 — invariants ok (reachability 189/199), **240 test files, 4978
  passed, 8 skipped**, coverage floors ok (17 subsystems on win32, 19 untested modules,
  all recorded). In the OneDrive worktree the same tree passed every test and then
  exited 1 on the recorded `coverage\.tmp` EPERM (DECISIONS-LOG 2026-09-07).
- at `6acf412`: exit 0 — invariants ok (189/199), **240 test files, 4979 passed, 8
  skipped** (the one more is the ignored-file case), coverage floors ok.
- at `ed03256`: first run **red** — 16 tests in 14 files this change does not touch, every
  one a 30 s hook or test timeout in a git-heavy suite, with free memory at 0.40 GB while
  other applications held it (DECISIONS-LOG 2026-10-03). By the Architect's choice the
  rerun waited until free memory had held 3 GB for a minute: exit 0 — invariants ok
  (189/199), **240 test files, 5001 passed, 8 skipped** (the 22 more are this rework's
  cases), coverage floors ok (17 subsystems, 19 untested modules, all recorded).

**The premise test demands the `GIT_DOORS` entry.** With the line removed, `knows every
module outside test/ that git can start through` fails, naming `scripts/mutate.cjs`; the
file was restored byte-identical (hash `677b78e61bf465d6…` before and after).

**Round 1 — the tool on itself**, `node scripts/mutate.cjs test/mutation/gym-008.json` at
`8a6274b`, 13 min 4 s: baseline PASS (1 file, 59 tests); control survived; **24 of 25
real mutants killed; `R6-untracked-allowed` SURVIVED; exit 1, ROUND HAS SURVIVORS.**

- The survivor was triaged as the question asks. Reachable from outside: a round file
  `.gitignore` hides is untracked and invisible to `git status`, so with the `ls-files`
  question deleted nothing refused it. A test was missing, and `6acf412` adds it.
- `R5-text-mode` died as a *file* kill — the spec's replacement carried a literal CR and
  LF, so the mutant did not parse and attacked the parser rather than the byte-exact
  sentence. The tool reported it as a file kill, which is what made the spec bug
  visible; the text is corrected in `6acf412`.
- The retry path ran for real: `R9-no-triage`'s first run met the suite's free-memory
  refusal, was reported as one, and was retried after 30 s rather than scored.

That round is GYM-008's metric 3 met on its first use: a round reported a survivor and
stopped, and the survivor was a missing test.

**Round 2** at `6acf412`, 12 min 36 s: baseline PASS (1 file, 60 tests); control
survived; **25 of 25 real mutants killed, each by a failing test; ROUND OK, exit 0**; the
round's worktree clean afterwards.

**The refutation pass** (§3.6) then beat that tool nine ways. Each was reproduced against
`6acf412` in this session, by a script that builds the fixture and runs the committed
tool, before any fix was written: `describe.skip` → `M1 SURVIVED` after a baseline PASS;
a killed worker → `X-kill SURVIVED`; an unhandled rejection → `ROUND OK`, exit 0; a dash
path → `M1 SURVIVED`; a left-behind test file → `B-equivalent killed … ran a different
file set` and `ROUND OK` with `?? more/` in the tree; a write to `other.mjs` → `ROUND OK`
with ` M other.mjs`; a hard link → the control's text left in the outside file;
`assume-unchanged` → INVALID with the uncommitted line gone; a lone surrogate → the
anchor matched. On win32 a junction leaves `git status` clean, and the real-path check
alone refuses it: `lib/mod.mjs resolves to …\outside\mod.mjs, outside the repository`.

**Round 3** at `ed03256`, 39 mutants and a control, started once free memory had held
3 GB for 30 s, 42 min 42 s: baseline PASS (1 file, 82 passed); `control-comment`
SURVIVED — certifies the round; **39 of 39 real mutants killed, each by at least one
failing test; ROUND OK, exit 0**; no refusal to start and no retry; the round's worktree
clean afterwards and no `eph-mutate-*` directory left in `%TEMP%`. An earlier start of
this round was stopped by hand in its baseline, before any mutant was written, when free
memory fell to 0.40 GB (DECISIONS-LOG 2026-10-03).

| Sentence | Mutants (all killed in round 3) |
|---|---|
| 1 a control certifies the round | `R1-no-control`, `R1-misspelt-key`, `R1-control-kill-ignored` |
| 2 green baseline | `R2-red-baseline` |
| 3 the report, read over the baseline's tests | `R3-zero-files-not-retried`, `R3-refusal-scored-as-kill`, `R3-missing-file-ignored`, `R3-extra-file-allowed`, `R3-file-kill-dropped`, `R3-exit-ignored`, `R3-skipped-file-defends`, `R3-unfinished-ignored`, `R3-invalid-run-scored`, `R3-no-retry`, `R3-timeout-unread`, `R3-timeout-retried` |
| 4 every file watched, round files by hash and the rest by status | `R4-others-unwatched`, `R4-target-unwatched`, `R4-tree-unwatched`, `R4-baseline-hash-unwatched`, `R4-baseline-tree-unwatched`, `R4-second-fault-hidden` |
| 5 byte-exact | `R5-text-mode` |
| 6 what git holds, where git holds it | `R6-tree-not-checked`, `R6-untracked-allowed`, `R6-link-escape`, `R6-hard-link`, `R6-index-bytes`, `R6-index-flags`, `R6-restore-not-git` |
| 8 anchors, paths and text refused before anything runs | `R8-precheck-zero`, `R8-mutate-zero`, `R8-overlap`, `R8-dash-path`, `R8-malformed-find`, `R8-malformed-replace` |
| 9 a survivor stops | `R9-survivor-exit-ok`, `R9-no-triage` |
| a crash is INVALID | `C-crash-exits-1` |

**Second refutation pass** at `ed03256`: eleven findings, nine reproduced in this session (§3.7).

**The gate at `d8e457d`** (the documentation commit; its `scripts/` and `test/` are byte-identical to `b20f83b`, checked with `git diff --quiet`), started once free memory had held 3 GB for a minute: exit 0 — invariants ok (189/199), **240 test files, 5006 passed, 8 skipped** (the five more are the kill-rule cases), coverage floors ok (17 subsystems, 19 untested modules, all recorded).

**Round 4** at `d8e457d` (code byte-identical to `b20f83b`), 43 mutants and a control, started once free memory had held 3 GB for 30 s, 57 min 55 s: baseline PASS (1 file, 87 passed); `control-comment` SURVIVED — certifies the round; **43 of 43 real mutants killed, each by at least one failing test, among them the four aimed at the kill rule** (`R3-any-failure-kills`, `R3-hook-failure-kills`, `R3-unexplained-unnamed`, `R2-baseline-test-fail-dropped`) and the moved `R3-file-kill-dropped`; **ROUND OK, exit 0**; no refusal to start and no retry; the worktree clean afterwards and no `eph-mutate-*` directory left.

## 7. Related docs

- [GYM-008](../gymnasium/proposals/GYM-008-a-mutation-round-is-a-tool-not-a-scratch-script.md)
  — the proposal, and its ledger row
- [TEST-STRATEGY §10](../TEST-STRATEGY.md) — the round's definition
- [ENGINEERING-STANDARDS §6](../ENGINEERING-STANDARDS.md) — Definition of Done item 9
- [M9-PLAN §6](../M9-PLAN.md) — why M9 needed this first
- [DECISIONS-LOG](../DECISIONS-LOG.md): 2026-09-09 (the three unearned M8b rounds),
  2026-10-02 (the zero-test kills and the OneDrive replay), and 2026-10-03 (this change)
- [`2026-10-02-invariants-see-wrapped-calls.md`](./2026-10-02-invariants-see-wrapped-calls.md),
  appendix — the scratch harness's spec shape this one extends

## Not proven

- **Every claim above is win32 only**, node v20.16.0, art pack absent. Nothing here was
  run on linux or macOS, and CI has not run this branch. On linux a junction is a
  symlink, which git sees as a link where a directory was, so the clean-tree check
  refuses it before the real-path check is reached; the test asserts the refusal either
  way, and only win32 has been seen to take the real-path branch.
- **A write landing after a round's last restore is outside what any round can see.**
  TEST-STRATEGY §10 says so; the defence is running outside a synced folder.
- **Building each mutant from the cached bytes** (§3.3, step 7) is untested: only a
  write timed between two runs distinguishes it from reading the file, and no
  deterministic test can place one there. It is not in the round for that reason.
- **The `git status` half of the restore check** is not in the round. It is requirement
  6's second check over the round's files, which their hashes already cover except for a
  change git sees and bytes do not (a mode bit), and no test makes one on win32.
- **The eleven known limits of TEST-STRATEGY §10 are open**, by decision; F6 and F11 were
  not reproduced in this session.
- **GYM-008's metrics 1 and 3 are measured on 2026-10-17**, over the rounds run until
  then; metric 2 is met at landing (the three named cases are tests).
