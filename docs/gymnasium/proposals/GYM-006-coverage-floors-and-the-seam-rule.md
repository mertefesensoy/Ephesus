# GYM-006 — Coverage floors and the seam rule: a wiring seam with no test is a defect

**Status:** landed · **Proposed:** 2026-09-02 · **Decided:** 2026-09-02 (Architect:
the four M8.0 decisions — provider, gate shape, docs + ledger, red baseline — all
approved as recommended, via the asking-me-questions workflow)

## Evidence

- **The recurring defect of this codebase is a check that cannot fail.** Five
  distinct instances were found on 2026-09-01/02, each a correct measurement of
  the wrong thing: a closing-time scenario rig that copies production's handler
  minus the line that throws (MVP register D12, `docs/PROGRESS.md` M8.1); a
  contention probe whose child processes had all exited before it measured
  (`test/pin.ts` header); a mutation check that only dies off UTC
  (`docs/DECISIONS-LOG.md` 2026-09-01); a timeout margin computed against the
  wrong denominator, six measurements, four wrong (`vitest.config.mts`); and a
  test asserting a refusal its CI platform never makes (`test/pin.ts`).
- **The shape this gate exists to catch already happened once at full size.** The
  M6 close-out audit found 1,406 lines of Herald whose only importers were test
  files, behind three milestones of green suites and a written exit review
  (`docs/PROGRESS.md`, M6 audit; BUILD-PROMPT build state). Three smaller
  instances followed in M7: `effectivePolicy` with no caller, `onTriggerFired`
  appending a line and stopping, a briefing compiler with no incident branch.
- **There was no coverage tooling at all.** `vitest.config.mts` had no
  `coverage` block, `npm test` was a bare `vitest run`, and
  `npx vitest run --coverage` on vitest 4.1.11 fails with
  `MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'` — so the
  M8 plan's "v8 ships with vitest and adds no package" was itself wrong, and
  "improve coverage" had nothing to improve against.
- **`main`'s CI was red on a pre-existing test** (`test/main/which.test.ts`,
  the `%dp0%` shim case, Linux only, many runs). A gate added on a red baseline
  cannot show that its own red means anything.

## Proposal

One mechanism with two halves, and the rule they enforce written where the
Definition of Done lives:

1. **Reachability** — `scripts/reachability.cjs` walks the compiler's own module
   resolution from the three entry points electron-vite builds (main, preload,
   renderer) counting value imports only, and `scripts/check-invariants.cjs`
   fails on any `src/**` module the walk never touches unless an allowlist
   entry names the *decision* that made the gap deliberate. A stale entry
   fails too. Type-only modules have nothing to reach and are classified as
   such, not allowlisted.
2. **Coverage floors** — `@vitest/coverage-v8` (Architect-approved, pinned to
   vitest's exact version), `npm run test:coverage`, and
   `scripts/check-coverage.cjs` reading `scripts/coverage-floors.json`: a
   TOTAL map of every production file to one subsystem; per-PLATFORM floors
   recorded beside the condition they were measured in; a per-platform list of
   production modules no test reaches. Floors rise only by re-measurement
   (`--update`), fall only by a reviewed edit; `--update` never adds an untested
   module. A platform with no recorded floor fails (could-not-establish fails).
3. **CI** runs the suite once, under coverage, then the check; the emitted
   linux measurement is kept as an artifact so linux floors are recorded from
   the CI condition rather than from a Windows machine.
4. **Docs** — ENGINEERING-STANDARDS §6 gains item 7 (the seam rule; a package's
   evidence names its production call path or records that there is none);
   TEST-STRATEGY §2's coverage paragraph becomes the per-subsystem ratchet, with
   "overall line coverage is not a gate" kept; BUILD-PROMPT §4's TEST line and
   the `/goal` and `/build-package` skills carry the new Definition-of-Done
   command (the skill change AUTOMATION.md's policy routes through this
   proposal).
5. **The red baseline is fixed first**, as its own commit: `unwrapWindowsShim`
   normalises every separator of a Windows shim's path, not only doubled ones.

## Cost & risk

One dev dependency (15 packages by dry-run, `npm audit --omit=dev` unchanged at
0, the two high dev findings the pre-existing electron/extract-zip pair), two
scripts with their own test files, one JSON record, one CI step rewritten and
one artifact step added. Risks, each with what holds it:

- *The floors become a number game* — a metric that rises while the wiring
  stays untested. Held by three things the number alone lacks: the map is per
  subsystem with boot wiring as its own row, the untested-module list catches a
  new file no test reaches whatever the percentage does, and reachability is
  measured from the application's side, where coverage cannot see.
- *Floors measured on one machine fail on another.* Held by per-platform floors
  carrying their condition, and by a tolerance set from a measured run-to-run
  spread rather than assumed.
- *The tolerance hides a slow leak.* Held by the ratchet: every `--update`
  raises the floor to the new measurement, so the tolerance is a band under a
  rising line, not a fixed allowance.
- *The allowlist and the untested list go stale and quietly accept things.*
  Held by the checks failing on a stale entry (reachability) and by `--update`
  removing a now-tested file while refusing to add one.

## Success metric

Binary, measurable by **2026-09-16**:

1. **The gate bites.** A planted regression — one test file deleted from a
   covered subsystem, and one new `src/` module nothing imports — fails the CI
   code job by subsystem/file name. Recorded in the M8.0 implementation doc with
   the run.
2. **No false positives on green work.** Zero failures of either gate on a
   change that regressed nothing, across every M8 branch pushed in the window.
   A platform-jitter failure counts as a false positive and triggers a
   re-measured tolerance, never a lowered floor. Excluded by design: the M8.0
   branch's first CI run, red on "no coverage floors are recorded for platform
   linux" before those floors could be recorded from its own artifact — that
   is the could-not-establish path working, not a false positive.
3. **Every M8 package closed in the window** states its production call path
   (file and line) in `docs/PROGRESS.md` or records that there is none, and none
   lands a new allowlist or `untested` entry without a cited decision.

## Rollback

Revert the CI job to `npm test`; remove `scripts/reachability.cjs`,
`scripts/check-coverage.cjs`, `scripts/coverage-floors.json`, their tests, the
rule in `check-invariants.cjs`, the `coverage` block and the dependency; restore
ENGINEERING-STANDARDS §6 and TEST-STRATEGY §2 from history. The decisions the
allowlist and the untested list carry are worth keeping as DECISIONS-LOG prose
if that happens — they were true before the gate and stay true after it.
