import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer harness (M6.1). React components are rendered to static markup
  // with `react-dom/server` — already a dependency — so the shipped panel body
  // is what a test reads, with no DOM library added to the tree. `automatic`
  // matches tsconfig.web's `jsx: react-jsx`, so a test transforms the same way
  // the app does.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    /**
     * Coverage (M8.0, the seam rule — ENGINEERING-STANDARDS §6.7). Off unless
     * asked for (`npm run test:coverage`); the provider is `@vitest/coverage-v8`,
     * an Architect-approved dev dependency pinned to vitest's exact version
     * because its peer range is exact. V8's native counters mean the suite runs
     * the same code it runs without coverage — nothing is instrumented — so a
     * coverage run is a test run, and CI does one run, not two.
     *
     * `include` lists every production file, so a module NO test imports shows
     * up at zero rather than vanishing from the report: that absence is the M6
     * Herald shape, and the whole point is to see it. The floors and the
     * untested-module record live in `scripts/coverage-floors.json`, checked by
     * `scripts/check-coverage.cjs` — deliberately not vitest's own `thresholds`,
     * which would make this file a second record of numbers whose condition it
     * cannot carry.
     */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'shims/**/*.mjs'],
      exclude: ['**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage'
    },
    /**
     * Vitest's 5 s default is a performance assertion this suite never meant to
     * make. TEST-STRATEGY §2 puts the integration tests on **real fs and real
     * git in temp dirs**, so a scenario spends most of its time waiting on git
     * child processes — and the loop-shaped ones (S-LIVELOCK's ping-pong to the
     * hop cap, S-STOPLOOP's continuations to the block cap) pay that cost once
     * per round trip. Those two files were the whole of the suite's timeout
     * flake.
     *
     * A timeout is here to catch a HANG, not to fail work that is merely slow.
     * 30 s keeps that job — a genuinely stuck test still fails, just later —
     * while leaving honest headroom on a loaded Windows machine.
     *
     * ## The margin, measured rather than assumed (2026-09-02)
     *
     * This once cited "~8.8 s running ALONE on an idle machine" and said the
     * same work "takes longer still" under parallel workers without saying how
     * much. It is a lot more, and the isolated figure flatters the margin badly
     * enough to mislead: four people measuring this number carefully produced
     * five different answers, because a per-test cost depends on the CONDITION
     * and every one of us sampled a convenient one.
     *
     * Slowest single test, `--reporter=verbose`, same machine:
     *
     * ```text
     * isolated, warm repeat   ~3.1 s      (flatters: nothing contends)
     * isolated, cold shell    ~11 s
     * FULL SUITE, default parallelism, machine otherwise quiet, n=12, slowest
     * test WITHIN s-stoploop/s-livelock (see the note on that restriction):
     *
     *   10.2  10.3  10.3  10.9  11.0  11.6
     *   11.6  11.9  12.3  12.4  13.4  17.3   s   <- the condition CI runs
     * ```
     *
     * A body of 10.2–13.4 s and **one excursion at 17.3 s**, not reproduced in
     * the seven runs that followed it. Headroom is 1.7× against that excursion
     * and 2.2× against the body — a spread worth stating as two numbers, since
     * quoting either alone misrepresents it.
     *
     * `signals the breaker at rung 1` and `honours the hard block cap` are the
     * two slowest; S-LIVELOCK's worst is in the same band, so the two files are
     * not distinguishable.
     *
     * **Restrict the metric to those two files.** "Slowest test in the suite"
     * has a ~10.3 s floor that is not about load at all: `tmpdir.test.ts`'s
     * `still throws when nothing is going to release the directory` pins a
     * directory and waits out the whole `TEMP_REMOVE_BUDGET_MS` by design, and
     * measures 10.25–10.39 s regardless of what else is running. Any sample at
     * ~10.3 s taken that way is that test, not evidence about anything.
     *
     * 30 s stays. Twelve full parallel runs, all green, nothing within 12 s of
     * the ceiling. The earlier worry that the worst kept climbing with n did not
     * survive more sampling — it rose 13.4 → 17.3 between n=2 and n=5 and then
     * stopped, which is one excursion rather than a tail. If a sample ever
     * exceeds ~20 s, or the suite grows, raise this — against a fresh
     * measurement in the PARALLEL condition, never an isolated run, and report
     * the range with its sample count rather than the worst.
     */
    testTimeout: 30_000,
    /** Teardown shells out to git too, and waits for it (see `test/tmpdir.ts`). */
    hookTimeout: 30_000
  }
})
