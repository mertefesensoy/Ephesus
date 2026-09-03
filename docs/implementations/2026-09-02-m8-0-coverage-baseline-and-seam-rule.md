# M8.0 — The coverage baseline and the seam rule

## Problem / motivation

The tree was green at 3,210 tests while Closing Time had never once run in the
shipped app, the standup read the oldest 500 log entries, and the dock showed an
overnight run's first 300 events. Every one of those passed its tests. The
recurring defect is **a check that cannot fail**, and the M6 Herald is the
full-size specimen: 1,406 lines that only test files imported, invisible to a
suite, a live demo and an exit review alike, because the application and the
tests reach a module the same way — by importing it — and nothing ever asked
which of the two had.

M8 exists to make catching that structural rather than lucky. M8.0 is the setup:
there was no coverage tooling of any kind, and "improve coverage" had nothing to
improve against. This package establishes the baseline and writes the rule that
the rest of M8 is held to:

> **A wiring seam with no test is a defect, not a gap.**

Four decisions were the Architect's and were put to them before any code, with
the facts corrected first: the plan's "v8 ships with vitest, no new package" is
false on this toolchain (`vitest run --coverage` fails with
`MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'`). All four
recommendations were approved: the v8 provider pinned exact; floors *and* a
reachability tripwire; GYM-006 with the two document amendments as drafted; and
fixing the one pre-existing CI-red test inside this package.

## What changed

| File | Change |
|---|---|
| `src/main/which.ts` | `unwrapWindowsShim` normalises every separator of the shim's path, not only doubled ones. The `%dp0%` test had failed on every Linux CI run and passed on every Windows machine: a `.cmd` is a Windows artifact whatever host reads it, and on POSIX its backslashes had been left as filename characters. The test stays unguarded so the unwrap is proven on both platforms. |
| `package.json`, `package-lock.json` | `@vitest/coverage-v8` at **exact** `4.1.11` (its peer range is vitest's exact version); the `test:coverage` script. |
| `vitest.config.mts` | The `coverage` block: v8, `include` over every production file so a module no test imports appears at zero, `json-summary` for the checker. No `thresholds` — the record lives in one file with its condition. |
| `scripts/reachability.cjs` | The import-graph walk from the three electron-vite entry points, counting value edges only; the allowlist that carries a *decision* per gap; type-only classification. |
| `scripts/check-invariants.cjs` | Rule 5: runs the walk, so one CI command still covers every tripwire; the ok line reports reached / by-decision / type-only counts. |
| `scripts/check-coverage.cjs` | The per-subsystem ratchet: total map, per-platform floors with condition (commit, ref, tree hash), untested-module record, `--seed` / `--update` / `--emit` / `--from`, stale-report and report-equals-tree refusals, the stale-floor rule. |
| `scripts/coverage-floors.json` | **The record** (schema 2). Subsystem map, tolerance and ratchet lag with their reasons, one block per measured platform. The only place a coverage figure is written down. |
| `test/scripts/reachability.test.ts` | 19 cases: a fixture project with one file per edge kind — the value barrel included — and the rule run over this repository with an empty allowlist so the test proves it bites on the real tree, plus a floor on the universe size so a classifier that hid the tree would fail. |
| `test/scripts/check-coverage.test.ts` | 37 cases over real files, a real summary and a real floors file in a temp directory, one per bypass and weakness the refutation pass found; the committed map checked for totality against the real tree. |
| `.github/workflows/ci.yml` | The suite runs once, under coverage; the check follows; the emitted linux measurement is uploaded as an artifact. |
| `.gitignore` | `coverage/`. |
| `docs/ENGINEERING-STANDARDS.md` | §6 item 7 — the seam rule, as approved. |
| `docs/TEST-STRATEGY.md` | §2's coverage paragraph — the per-subsystem ratchet, as approved; "overall line coverage is not a gate" kept. |
| `docs/gymnasium/proposals/GYM-006-…`, `docs/gymnasium/LEDGER.md` | The ledger entry ENGINEERING-STANDARDS §3 requires for a changed CI gate. |
| `docs/AUTOMATION.md`, `BUILD-PROMPT.md`, `docs/M8-GOAL.md`, `docs/PROGRESS.md`, `docs/DECISIONS-LOG.md` | The CI table, the approved-dependency list and build state, the handover, the tick, the minor decisions. |

## Implementation approach

### Two halves, because the defect has two sides

Coverage answers *does any test reach this module?* Reachability answers *can
the application load it?* The Herald passes the first and fails the second; a
scenario rig that copies production's handler passes neither for the real
handler while staying green. Each half is blind where the other sees, so the
rule is enforced by both, and the third thing — *is it called, with the right
arguments, at the right moment?* — stays a human obligation that the rule makes
explicit: a package's evidence names its production call path, file and line,
or records that there is none.

### Reachability: the compiler's resolution, value edges only

`reachability.cjs` reads each file with the TypeScript parser and follows only
what survives compilation: `import x from`, a bare `import './fx'`,
`export * from`, `export { x } from`, and a literal dynamic `import()`. `import
type`, `export type`, and `import { type A, type B }` are not edges — counting
them would have made the Herald "reachable" the moment something borrowed one of
its interfaces. Specifiers resolve through `ts.resolveModuleName` with the
repository's `bundler` resolution, so a `.css`, an asset URL or a package simply
does not resolve into `src/` and is skipped. The walk starts at the three
programs electron-vite builds: `src/main/index.ts`, `src/preload/index.ts`,
`src/renderer/src/main.tsx`.

Two classifications keep the answer honest rather than merely strict:

- **Type-only modules** — files whose every top-level statement the compiler
  provably erases (interfaces, type aliases, ambient declarations, `import
  type`, `export type`, the empty `export {}`) — have no module to load and are
  reported as *type-only, nothing to reach*. Six such files exist today
  (`engines/types.ts` and the five `*-view.ts` contracts). The rule is
  deliberately conservative: ANY import in value syntax makes a file runtime,
  even when the binding is a type the compiler would elide. The first draft
  inferred "bindings in a file with no other runtime statement can only be
  types", and the refutation pass broke it with `import { x } from './x';
  export { x }` — a value barrel under `isolatedModules` that was classified
  type-only, hidden from the gate, and never traversed, so its target read as
  unreachable. A file misread as runtime shows up and gets a decision; a file
  misread as type-only vanishes. Only the first is a mistake you can see. The
  walk now also traverses every module it reaches, type-only or not, so a
  classification can never stop it again.
- **The allowlist names files and carries a decision.** Eight entries today:
  the seven Herald modules one by one (M6.9 deferred indefinitely by the
  Architect, 2026-08-30) and `src/shared/contrast.ts` (the CI token gate, in
  `src/shared` by its own header's design). A directory entry was refuted the
  same day: it would have accepted the next file dropped beside the seven and
  read as live while a single one of them stayed unreachable. An entry that
  stops naming an unreachable file — wired, or deleted — fails the check, so
  the record cannot outlive the gap.
- **Could-not-establish fails.** A missing entry point, a module that cannot
  be read, or a universe with no runtime module in it is a failure line, never
  an empty answer.

Two things the walk cannot see are stated in its header and in its failure
text so nobody mistakes the answer: a value import whose bindings are used only
in type positions is dropped by esbuild and is counted here; a dynamic import
whose specifier is not a literal (a template, `import.meta.glob`) is not
followed, so a module loaded only that way reads as unreachable — the safe
direction. Reachability is the floor of wiring, not proof of it.

### Coverage: a per-subsystem ratchet with its condition attached

`check-coverage.cjs` reads vitest's `json-summary` report and folds every file
into the subsystem the map assigns it to. The map is **total on purpose**: a
file that belongs to nowhere fails, a member that names nothing fails, and the
map is checked over the union of the report and the tree so a type-only module
(absent from the report) still has to belong somewhere. Boot wiring
(`index.ts`, `ipc.ts`, the preload, `main.tsx`/`App.tsx`) is its own row, so
SDD §1.1's "index.ts holds no logic of its own" becomes a number later packages
move, and the Herald is its own row so its zero cannot hide inside a larger
average.

Floors are recorded **per platform**, each block stamped with the commit, the
CI ref, a git-free hash of the production tree, node version, OS and command
it was measured under, because `process.platform` branches, OS-gated tests and
timing-dependent paths move the figure between machines — the exact property
that produced six disagreeing timeout margins on 2026-09-02. The tree hash is
there because `.git/HEAD` cannot see a dirty working tree, and the first
draft's record named a commit whose tree it had not measured. A run on a
platform with no block **fails**: it cannot claim "no regression" with nothing
to compare against. The first record on a platform is an explicit verb,
`--seed`; `--update` refuses to start a block, because the refutation pass
showed that deleting a block by hand and running `--update` re-recorded
lowered floors and new untested modules with exit 0. The table is still
printed and the measurement can be `--emit`ted, which is how the linux floors
are seeded from CI's own condition rather than guessed from Windows.

The record and the report are held to the tree. Every floor metric must be a
number (a hand-deleted key had silently disabled its metric through `NaN`); a
report older than the newest production file is refused; the report and the
tree must be the same set of files in both directions; an emitted artifact is
validated and must cover exactly the map's subsystems. A refused or no-op
`--update` writes nothing and moves no stamp, so the condition beside a figure
is always the condition that produced it. And a floor more than `ratchetLag`
points **below** reality fails as stale: floors rise only when somebody
ratchets them, and without this a package's gained coverage could be lost again
with no failure anywhere.

The **untested list** is the coverage-side Herald catch: a production file none
of whose functions any test enters (or, with no functions, none of whose lines
any test runs). The first draft asked only about lines, and a bare `import`
marks a module's top-level lines covered — which let `src/main/config.ts`, one
line of ten and no function ever entered, pass as tested. Known cases are
recorded per platform. `--update` removes a file the moment a test enters it
and never adds one; a new untested module is a failure even under `--update`,
and adding it to the record is a hand edit — the review point.

### Why the record is a JSON file beside the checker, not vitest thresholds

Vitest's `coverage.thresholds` would have put the numbers into
`vitest.config.mts`, a second record with no room for the condition, and its
`autoUpdate` rewrites that file in place. The seam rule needs one record that
carries its own condition, that a test can read and write in a temp directory,
and whose changes are a reviewable diff. `scripts/coverage-floors.json` is that,
and `scripts/check-coverage.cjs` is the only writer.

### CI runs the suite once

V8 coverage uses the engine's native counters; nothing is instrumented, so the
suite under coverage runs the same code as without it. The Test step therefore
became `npm run test:coverage` rather than a second run, and the check follows
it. The emitted measurement is uploaded as an artifact on every run, pass or
fail, so a floor can be recorded from the CI condition with
`--update --from <artifact> --platform linux`.

## Mathematical / statistical details

**Per-subsystem percentage.** For metric *m* (lines, branches, functions,
statements) and subsystem *S*, the figure is the pooled ratio, not the mean of
file percentages:

> pct(S, m) = 100 × Σ_{f∈S} covered(f, m) ⁄ Σ_{f∈S} total(f, m)

rounded to two decimals; a subsystem with total 0 reads 100. Pooling weights a
2,000-line file 100× a 20-line one, which is what "how much of this subsystem is
exercised" means; a mean of file percentages would let a covered one-liner
cancel an uncovered module.

**The floor test.** A subsystem fails when measured < floor − tolerance, per
metric. The tolerance is one number for the file with its reason beside it; the
value is set from the observed run-to-run spread of the same tree on the same
platform (n = 2 at this baseline: two full `npm run test:coverage` runs, the
seeding run and a second one checked against it), recorded in
`toleranceReason`, not assumed. Because `--update` raises every floor to the
latest measurement, the tolerance is a band under a rising line rather than a
fixed allowance that could be spent one commit at a time.

**Assignment rank.** An exact-file member ranks +∞; a directory member ranks by
its length. The highest rank wins; two claims at the same rank are a map error,
reported once (the tied members all count as hit, so the duplicate is not also
reported as "names nothing").

**Stale.** A subsystem also fails when measured − floor > ratchetLag (5 points
at the baseline, reason recorded beside it): the record has been left behind by
more than a package's worth of coverage and must be ratcheted before anything
else lands, or the gain is not protected.

**Untested.** untested(f) ⇔ (functions.total(f) > 0 ∧ functions.covered(f) = 0)
∨ (lines.total(f) > 0 ∧ lines.covered(f) = 0 ∧ functions.covered(f) = 0). A
type-only module (0/0 on both) is neither. Comparisons of measured against floor
are made on values rounded to two decimals, so a figure exactly at the tolerance
edge is not a floating-point regression (0.28 − 0.25 is not 0.03 in binary).

## Design decisions

- **Reachability lives in `check-invariants.cjs`'s command, in its own module.**
  One CI command still covers every tripwire (the DoD line does not grow), but
  the walk needs the compiler's resolution rather than a regex and is tested as
  a module through `createRequire`, the `check-attribution.cjs` pattern.
- **`contrast.ts` is allowlisted, not moved.** Its header states the decision
  (one arithmetic shared by the token test and future design tooling); moving it
  to `test/` would have been a silent reversal of that decision inside a package
  about recording decisions.
- **The dependency is pinned exact, not caret.** `@vitest/coverage-v8`'s peer is
  `vitest: 4.1.11`, not a range; a caret bump of one without the other fails at
  install. Bumping vitest now means bumping both, and the pin says so.
- **The shim fix is a code change, not a test guard.** Guarding the test to
  Windows would have gone green by removing the unwrap's only CI coverage —
  precisely the shape of instance 5 in the register. Normalising every
  separator makes the function correct on the host that reads the shim and
  keeps the test as evidence on both.
- **`--update` fails on a new untested module even though it wrote the file.**
  The alternative — refusing to write — would have coupled the ratchet to the
  gap; this way a package can raise its floors and still be told, by name, that
  it shipped a module nothing reaches.
- **The floors file carries `schemaVersion` and is validated in the script,
  not in `src/shared/`.** ENGINEERING-STANDARDS §3's validator rule enumerates
  the app's data files; this is repository tooling with no application caller,
  and a `src/shared` validator for it would itself have tripped the new
  reachability gate — the rule catching its own exception is the right outcome.
- **What is stated as owed, not built:** export-level dead code (M3's
  `effectivePolicy`, reachable by module and called by nothing) is invisible to
  both halves. A language-service reference walk would catch it and is a
  package of its own, not a paragraph.

## What the baseline says

The figures are in `scripts/coverage-floors.json` and nowhere else; what follows
is what they mean, which a number alone does not say.

- **The rule's first target is the wiring.** Boot — `index.ts`, `ipc.ts`, the
  preload, `main.tsx`, `App.tsx` — is the least-covered row by a wide margin,
  with four of its five files reached by no test at all. That is the seam the
  rest of M8 drives tests through, and this row is how each package shows it
  did.
- **None of the four mechanisms TEST-STRATEGY names meets its own ≥ 90 % branch
  target.** The distances vary; the file shows each. The target stays a target;
  the floor is what is measured, so a package cannot claim the target by
  quoting the floor.
- **Twenty-four production modules are entered by no test on Windows**, most
  of them renderer panels the M6.1 harness never covered (thirteen), plus the
  boot files, the native-module wrappers (`db.ts`, `library-fts-sqlite.ts`,
  `pty.ts` — kept out of vitest by the M0 constraint that native modules are
  Electron-ABI), the cipher seam, one shim, one floor-art module, and
  `src/main/config.ts`, which the first draft's line-based rule had passed as
  tested because a bare import runs its top-level lines. Each is now a named
  entry that a package removes by writing the test, or that stays as a
  recorded gap.
- **The run-to-run spread was zero at n = 2** on the same tree and platform,
  which is the measurement the tolerance rests on, recorded beside it in
  `toleranceReason`.
- **The Herald measures high and is unreachable** — the two halves disagreeing
  is the point: coverage alone would have called it healthy.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
npx vitest run test/scripts/reachability.test.ts test/scripts/check-coverage.test.ts test/main/which.test.ts
node scripts/check-attribution.cjs
```

Evidence of the gates biting, each mutation applied, observed, and reverted
against a green baseline (the mutation rule: break the thing, confirm red, put
it back):

- Reachability: removing the Herald allowlist entry fails
  `check-invariants.cjs` naming all seven files; adding a stray `src/orphan.ts`
  fails naming it; a stale allowlist entry fails naming the entry; the test
  file's real-tree case asserts the first of these on every run.
- Coverage: the checker's own suite drives a regression past tolerance, a new
  untested module, an unassigned file, a stale member, a missing platform and a
  missing report, each to a failure line by name; `--update` is shown never to
  lower a floor and never to add an untested module.
- The shim: the `%dp0%` case is the CI proof, on the platform where it failed.

### Refuted, then fixed

Before the package closed, three independent refuters were asked to make each
gate pass when it should fail, with probes rather than opinions. The first
draft lost on three counts and a dozen weaknesses (the full list is the
DECISIONS-LOG entry of the same day): the value-barrel misclassification, the
directory allowlist that accepted new files, the deleted metric key that
disabled its metric, the deleted platform block that turned `--update` into a
re-seed, the re-stamped condition on a refused update, the report about deleted
files that passed, the stale report that could be recorded, the artifact from a
different map, the tolerance's false "under one line" claim, and the import-only
module that was not "untested". Each has a fixture case in the two test files
that fails against the first draft, and the scripts were rewritten rather than
patched. One finding stands and is the Architect's: `main` has no branch
protection, PR #6 was merged over a red code job, and until required checks are
enabled every CI gate here is advisory.

The CI evidence for this branch — the first run failing by design on "no
coverage floors are recorded for platform linux" with the measurement uploaded
and every earlier step green (the Linux proof of the shim fix among them), and
the run after the linux floors were recorded from that artifact, green on all
three jobs — is cited by run id in `docs/PROGRESS.md` under M8.0, and nowhere
else. That first red is the could-not-establish path working; GYM-006's
false-positive metric excludes it by name.

## Related docs

- `docs/ENGINEERING-STANDARDS.md` §6.7 — the rule
- `docs/TEST-STRATEGY.md` §2 — the ratchet
- `docs/gymnasium/proposals/GYM-006-coverage-floors-and-the-seam-rule.md` — the ledger entry
- `docs/adr/ADR-0024-claude-only-for-the-mvp.md` — why `codex.ts`/`gemini.ts` will need an allowlist entry at M8.11
- `docs/PROGRESS.md` — the M8 plan and the M8.0 evidence
- `test/pin.ts` — the worked example of could-not-establish failing
