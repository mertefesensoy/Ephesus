# eph-usage is tested where coverage can see it, and PR #60 lands as the contributor's

Issue #10 asked for tests of `shims/eph-usage.mjs`, the statusline shim that is
ADR-0023's only observation point. A contributor delivered them in PR #60:
the shim's pure helpers exported, `main()` behind the guard the other shims
use, and an in-process test file. Review found the code right and six things
around it wanting. This change finishes PR #60 on its own branch — the
Architect's commits go on top of the contributor's, so their PR is the one
that merges — adding the tests review asked for, correcting the ADR the shim's
header cites, and ratcheting the `shims` coverage floors on both platforms.

## 1. Problem / motivation

**The shim was tested and invisible.** `test/main/engines/claude-usage-statusline.test.ts`
runs the shipped shim as a child process — JSON on stdin, `--dir`, an agent id —
which is how an engine runs it and the right way to test `main()`. But V8
coverage only counts code inside Vitest's own workers, so with eleven passing
spawn tests of the shim it measured 0 % on every metric and sat in the
`untested` list of `scripts/coverage-floors.json` on both platforms.
ENGINEERING-STANDARDS §6.7 treats an untested module as a defect, not a gap.

**PR #60 fixed the visibility, and review (2026-10-01) found:**

| Severity | Finding |
|---|---|
| major | Two of the seven commits did not typecheck. A literal `\n` put `import fs from 'node:fs'` inside the header comment (`TS2304` ×8 in CI on `60947ed`). Later commits repaired the head, but this repository merges with merge commits, so both would have landed red on `main` — against ENGINEERING-STANDARDS §1, "green at every commit". |
| minor | No test held that `usedPercent` is stored unrounded. The mutant `usedPercent: Math.round(used)` survived every shim test. |
| minor | The PR's Evidence section listed claims, not output. |
| nit | `windowOf`'s non-object arm — the first render of every session — was reached only by the spawn tests, so V8 still counted it uncovered. |
| nit | Teardown used `fs.rmSync` rather than `removeTempDir`, the one temp-directory remover. |
| nit | Nothing held the guard's own claim, that importing the shim runs nothing: `if (true)` survived. |

Separately, the shim's header cited ADR-0019 (the Recursive Improvement profile).
The decision it implements is ADR-0023.

## 2. What changed

| File | Change |
|---|---|
| `shims/eph-usage.mjs` | Six pure helpers exported and `main()` guarded, exactly as `eph-hook.mjs`, `eph-recall.mjs` and `eph-gh-token.mjs` do (contributor). The header now cites ADR-0023. |
| `test/shims/eph-usage.test.ts` | New. In-process tests of the six helpers (contributor), plus: an absent window, the unrounded percentage, an out-of-process test of the import guard, and `removeTempDir` teardown. |
| `scripts/coverage-floors.json` | Ratcheted by `check-coverage.cjs --update` — win32 from three local runs, linux from three CI push runs, all of one production tree, measured on a maintainer branch of this repository (§3). `shims/eph-usage.mjs` leaves `untested` on both platforms. |
| `docs/DECISIONS-LOG.md` | Three entries: why the guard is tested through an importer file; the `pacing-wakes` teardown flake CI hit along the way; and how #60 is finished on its own branch and merged. |
| `docs/implementations/2026-10-01-eph-usage-in-process-coverage.md` | This document. |

## 3. Implementation approach

### Making a shim importable without changing what it does

The pattern is the house one, unchanged: `export` on each pure helper, and
`main()` called only when `process.argv[1]` ends in `eph-usage.mjs` —
`process.argv[1] && process.argv[1].endsWith('eph-usage.mjs')`. That is a suffix
match, not an identity: a file named `x-eph-usage.mjs` that imported the shim
would run `main()`. All four shims match this way, and tightening them to a
basename comparison is recorded as a follow-up. Adding `export` has no runtime
effect. The guard is true on the production path:
`src/main/index.ts:1446` passes `path.join(appRoot, 'shims', 'eph-usage.mjs')`
to the adapter, and `usageStatusLine` (`src/main/engines/claude.ts:885-891`)
writes `node "<that path>" --dir "<dir>"` into the engine's settings, so the
engine starts a process whose `argv[1]` is the shim. The spawn suite proves it
from the other side: a guard that never fires fails eleven of its tests.

### What is tested where, and why it has to be split

| What | Where | Why there |
|---|---|---|
| The six helpers' branches | `test/shims/eph-usage.test.ts`, in-process | V8 sees them only here. |
| `main()`, stdin, fail-open, the report as the harness reads it | `test/main/engines/claude-usage-statusline.test.ts`, spawned | That is how an engine runs it; V8 cannot see it, by construction. |
| The import guard | `test/shims/eph-usage.test.ts`, one spawned process | "Importing runs nothing" is a property of a whole process — its stdin, its stdout and stderr, and the files it writes. |

The guard test writes an `importer.mjs` into a temp directory and runs it with a
status document on stdin, `--dir <reports>` and an agent id: everything `main()`
would act on. After the import settles, the importer records
`process.stdin.readableFlowing`, which stays `null` until something attaches a
reader or resumes the stream, and then reads stdin to the end itself. The test
asserts the guard's whole claim: exit 0, empty stdout and stderr, no reader
attached, the whole document still unread, and no report directory. The child
does not inherit `NODE_OPTIONS`, whose loaders and flags make Node write its own
warnings to stderr. An importer *file*, rather than `node -e`, matters because
under `-e` `process.argv[1]` is never a module path — it is undefined, or the
first script argument — so the comparison the guard really makes, a module path
that is not the shim's, would never be exercised. The importer reproduces the
argv a real importer has.

### How the PR is finished

PR #60's branch lives on the contributor's fork. The Architect's four commits go
on top of its head, `b437907`, by maintainer edit — the PR allows maintainers to
push — and nothing the contributor pushed is rewritten:

| Commit | What |
|---|---|
| `test:` | the absent window, the unrounded percentage, the import test, `removeTempDir` teardown |
| `docs(shims):` | the header cites ADR-0023 |
| `chore(coverage):` | the ratcheted floors (below) |
| `docs:` | DECISIONS-LOG and this document |

Two of the contributor's seven commits do not typecheck: `9352bf3` and `60947ed`
carry a test file whose `import fs` sits inside the header comment, and the next
two commits repair it. They cannot be removed without rewriting a branch that is
not ours, so **#60 is squash-merged**: one commit reaches `main`, and its tree
typechecks. That commit is authored by the PR's author with the Architect as
co-author, which `check-attribution.cjs` accepts — it refuses a co-author only
when it names a Claude or Anthropic identity, and on the first-parent chain only
a `[bot]` identity.

A different finish was built first. `fix/eph-usage-coverage-10` in this
repository re-applies the seven commits as five green ones, with the contributor
kept as author, and then carries the same maintainer changes; its tree differs
from this branch's only in this document and in DECISIONS-LOG. It was set aside so that the contributor's PR is the one
that merges, and it is kept, because the coverage runs below were measured on it.

### The ratchet

`check-coverage.cjs` raises a floor only from a full corroboration window — three
runs of one production tree, hashed over production files only — and only to the
window's per-metric minimum. So the production tree was finished first (the
header correction is its last change), and each measurement after it is a run of
the same tree, `bffbbf3bd541`: three local win32 runs recorded with `--update`,
and three linux CI push runs recorded with `--update --from <artifact>
--platform linux`, each recording committed and pushed so that the push itself
starts the next run — the procedure the linux floors were first raised by on
2026-09-07.

Those runs were taken on the maintainer branch, not on #60: upstream CI makes push
runs only for this repository's own branches, and a `pull_request` run measures a
synthetic merge commit rather than a commit on any branch. The window keys on the
production tree, and #60's production tree after its header commit is that same
`bffbbf3bd541`; the commits the record names (`30835f2`, `adaa6e8`, `2feed06`)
are on the maintainer branch, which is why it is kept.

All six runs measured the same `shims` figures, so the floors rose to them:

| `shims` | lines | branches | functions | statements |
|---|---|---|---|---|
| before, both platforms | 47.62 | 41.5 | 46.3 | 47.26 |
| after, both platforms | 55.59 | 54.47 | 57.41 | 56.84 |

`--update` ratchets every row whose window minimum exceeds its floor, not only
the row that motivated the run, and ten rows had drifted above their floors since
they were last raised on 2026-09-07 (main's own CI printed "--update ratchets it"
for each). Those rose too: 34 metrics on win32 and 35 on linux, in `boot`,
`engines`, `agora`, `library`, `odeon`, `harbor`, `watch`, `company`, `home` and
`panels`, each to the same three-run minimum. Raising only `shims` would have
meant editing the file by hand, which is the one way the record is not supposed
to change. No floor fell, and five rows' file counts, stale since the floors were
last measured on 2026-09-07, were refreshed.

## 4. Mathematical / statistical details

**Seconds to milliseconds.** `resetsAt = round(s × 1000)`, because
`usageReportSchema` requires an integer (`src/shared/pacing.ts:33`). A test of
this needs an input whose product is not already an integer: `123.456 × 1000`
is exactly `123456` in IEEE-754 doubles, so the original input could not tell
`round` from `floor`, `ceil` or no rounding at all. `123.4567` and `123.4562`
straddle the half: `round` gives `123457` and `123456`; `floor` and `trunc`
fail the first, `ceil` the second, and no rounding fails both.

**Display rounding.** `part` prints `round(p)`. `12.6` separates `round` (13)
from `floor` (12); `12.4` separates it from `ceil` (13).

**The stored percentage.** Pacing compares `usedPercent` with its thresholds —
`slow` at ≥ 90 and `hold` at ≥ 97 by default (`src/shared/pacing.ts:142-143`) —
and projects `usedPercent / elapsedFraction`. If the shim stored
`round(96.5) = 97`, a company at 96.5 % would hold instead of slow. `96.5` is
the input that makes that mutant fail.

**The ratchet.** For each subsystem `s`, platform `p` and metric `m`, over the
window's runs `r₁…r₃`: `floor′(s,p,m) = min(r₁, r₂, r₃)` when that exceeds
`floor(s,p,m)`, otherwise the floor is unchanged. A later run fails when its
figure is below `floor − 0.25` (`tolerance`), or more than `5` points above it
(`ratchetLag` — the stale-record rule PR #60's CI hit).

**The mutation round.** Each mutant replaces or inserts one expression in
`shims/eph-usage.mjs`, runs this file and the spawn suite (46 tests), and is
restored; the file's hash is checked afterwards. Condition: Windows_NT
10.0.26200, node v20.16.0, run on the maintainer branch at `ff56a7a`, whose shim
(sha256 `3edd4b4b697e…`) and test file are byte-identical to the ones this change
ends with. A no-op control stayed green, 46 of 46. The last three mutants are
planted rather than edited: each leaves the guard intact and adds one statement
at module scope, which is what the import test's stdin and stderr assertions
exist to catch. The first 26 were run under vitest and all killed. The 27th, a
synchronous `fs.readFileSync(0)`, cannot be scored that way: it blocks the
in-process import, so the vitest run never finishes. It was scored by replaying
the import test in plain node against a mutated copy of the shim. The unmutated
shim passes every check; the mutant fails only the whole-document check, which is
the assertion added to catch it.

| Expression | Mutant | Killed by |
|---|---|---|
| `windowOf` :109 `Math.round(resets * 1000)` | rounding dropped; `floor`; `ceil` | this file |
| :109 `usedPercent: used` | `Math.round(used)` | this file (96.5) — survived before this change |
| :107 `used < 0` | `used <= 0` | this file (the 0 % case) |
| :107 `!Number.isFinite(used)` | dropped | this file |
| :108 `resets <= 0` | `resets < 0` | this file and the spawn suite |
| :104 non-object guard | dropped; `raw === null` dropped | this file and the spawn suite |
| `part` :130 `Math.round` | `ceil`; `floor` | this file (and the spawn suite, for `floor`) |
| `writeAtomic` :124-125 temp + rename | write in place | this file (the inode check) |
| :122 `mkdirSync(dir, { recursive: true })` | not recursive; removed | this file (and the spawn suite) |
| `parseArgs` :42 `i + 1 < argv.length` | dropped | this file |
| `reportName` :65-67 | `=== null` for `!agentId`; cap 101; no dot-run collapse | this file (and the spawn suite) |
| :66 sanitiser | lets `/` and `\` through | the spawn suite only |
| `sessionCostOf` :145 `usd < 0` | `usd <= 0` | this file (the exact-zero cost) |
| :145 `!Number.isFinite(usd)` | dropped | this file |
| guard :212 | `if (false)` | the spawn suite (11 tests) |
| guard :212 | `if (true)` | this file (the importer) — survived before this change |
| guard :212 | `if (process.argv[1])` | this file (the importer) |
| module scope, guard intact | a stray `readStdin()` | this file (the importer's `readableFlowing` check) |
| module scope, guard intact | a stray `process.stderr.write(…)` | this file (the importer's stderr check) |
| module scope, guard intact | a stray `fs.readFileSync(0)` | this file (the whole-document check), replayed in plain node |

## 5. Design decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| Finish #60 on its own branch, by maintainer edit | Re-apply the commits, folded, on a maintainer branch | That was built first and gives a clean history, but it supersedes the contributor's PR. The fix is theirs, so their PR is the one that merges (the Architect's decision). |
| The same | Force-push a cleaned history to the fork | It rewrites a branch someone else pushed. |
| Squash-merge #60 | A merge commit | A merge commit would land `9352bf3` and `60947ed`, which do not typecheck, on `main` (ENGINEERING-STANDARDS §1). |
| Measure the floors on an upstream branch of the same production tree | Measure from #60's `pull_request` runs | A `pull_request` run measures a synthetic merge commit, so the record would name a commit on no branch. |
| Test the guard from an importer file | `node -e "await import(…)"` | Under `-e`, `argv[1]` is never a module path, so the comparison the guard really makes is never exercised; the importer reproduces a real importer's argv. |
| `96.5` for the stored percentage | Any non-integer | 96.5 is where rounding crosses the default hold threshold, so the test names the consequence, not just the arithmetic. |
| Correct the header's ADR here | A separate PR | It is the file under change, and review checks a load-bearing file's edits against the ADRs its header names. |
| Let `--update` raise every drifted row | Hand-edit only the `shims` rows | A hand edit is the one way the record must not change; the other rows' rises are measured the same way and corroborated the same way. |
| Leave `eph-hook`, `eph-recall` and `eph-gh-token`'s guards untested here, and all four guards as suffix matches | Fix all four, or tighten them to a basename match | One issue per PR; both are recorded as one follow-up in DECISIONS-LOG. |

## 6. Verification

```bash
npm run typecheck
npm run lint
node scripts/check-invariants.cjs
npm run test:coverage
node scripts/check-coverage.cjs
```

**Every commit on #60's branch.** The contributor's seven, from CI where it ran
and from the same trees on the maintainer branch where it did not; the
Architect's four, checked on Windows_NT 10.0.26200 (node v20.16.0) with
`tsc --noEmit -p tsconfig.node.json` (the project that holds `shims/` and
`test/`), ESLint and Prettier on the changed files, and the shim tests:

| Commit | Author | Typecheck | Evidence |
|---|---|---|---|
| `6562d49` | contributor | green | the same tree as the maintainer branch's `68b83ab`, checked locally |
| `cbe9cb6` | contributor | green | CI run 36027164626 failed only the stale-floor step |
| `3b2d51e` | contributor | green | the same tree as the maintainer branch's `1e1fbb4`, checked locally |
| `9352bf3` | contributor | **red** | its test file has no live `import fs`; the same file as at `60947ed` |
| `60947ed` | contributor | **red** | CI run 36589970581: `TS2304` ×8 |
| `fc4ccad` | contributor | green | checked locally |
| `b437907` | contributor | green | CI run 36601477521 failed only the stale-floor step |
| the four above | Architect | green | checked locally before the push |

**The full suite, before and after:**

| Run | Condition | Files | Tests | `shims` lines / branches / functions / statements |
|---|---|---|---|---|
| main @ `bb3e016`, CI push run 34981836416 | ubuntu-24.04, node v20.20.2 | 236 | 4602 passed, 15 skipped | 47.62 / 41.5 / 46.3 / 47.26, `eph-usage.mjs` untested |
| three CI push runs of tree `bffbbf3bd541`, maintainer branch | ubuntu-24.04, node v20.20.2 | 237 | 4633 passed, 15 skipped | 55.59 / 54.47 / 57.41 / 56.84 |
| three local runs of tree `bffbbf3bd541` | Windows_NT 10.0.26200, node v20.16.0 | 237 | 4640 passed, 8 skipped | 55.59 / 54.47 / 57.41 / 56.84 |

The skipped counts differ by platform because some tests are gated to one OS;
the totals agree (4648). After the ratchet, `node scripts/check-coverage.cjs`
without `--update` exits 0 against the last win32 report and against the last
linux artifact. #60's own CI runs on its head as `pull_request` runs, on the same
production tree.

**One unrelated failure, reported rather than absorbed.** The first attempt of CI
run 36924116592, on the maintainer branch, failed one test in
`test/main/pacing-wakes.test.ts`, a teardown race: `ENOTEMPTY` removing a temp
Agora's `.git` after `agora.drained()`. This change touches neither that file,
`src/`, nor `test/tmpdir.ts`, and the same test passed on the same tree in every
other run listed above. It emitted no measurement, so the run recorded in its
place is the rerun. The race, its evidence and the two suspects in its teardown
are recorded in DECISIONS-LOG (2026-10-01, "FOUND BY CI — RECORDED, NOT FIXED,
OUT OF SCOPE"), so the next red is recognised rather than re-diagnosed.

## 7. Related docs

- [ADR-0023](../adr/ADR-0023-usage-aware-pacing.md) — usage-aware pacing; the shim is its observation point
- [ENGINEERING-STANDARDS](../ENGINEERING-STANDARDS.md) — §1 (green at every commit), §2 (evidence), §6.7 (the seam rule)
- [TEST-STRATEGY](../TEST-STRATEGY.md) — §2, the per-subsystem ratchet
- [Usage-aware pacing](2026-09-01-usage-aware-pacing.md) — where the shim and the spawn suite were built
- [The temp-directory teardown](2026-09-01-flaky-temp-dir-teardown.md) — why `removeTempDir` is the one remover
- [DECISIONS-LOG](../DECISIONS-LOG.md) — the 2026-10-01 entries on testing the guard and on the `pacing-wakes` teardown flake, and the 2026-10-02 entry on how #60 is finished and merged
- Issue [#10](https://github.com/mertefesensoy/Ephesus/issues/10), PR [#60](https://github.com/mertefesensoy/Ephesus/pull/60), and the maintainer branch [`fix/eph-usage-coverage-10`](https://github.com/mertefesensoy/Ephesus/tree/fix/eph-usage-coverage-10) where the coverage runs were measured
