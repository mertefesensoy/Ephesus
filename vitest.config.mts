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
     * FULL SUITE, default parallelism, n=5, machine otherwise quiet:
     *   10.3  11.6  12.3  13.4  17.3  s   <- the condition CI runs
     * ```
     *
     * Worst observed 17.3 s, so headroom is about **1.7×** — not the ~3.4× the
     * isolated number implied, and not the 2.2× an earlier n=2 of this same
     * condition implied. `signals the breaker at rung 1` and `honours the hard
     * block cap` are the two slowest; S-LIVELOCK's worst is in the same band, so
     * the two files are not distinguishable.
     *
     * **The worst has risen with every increase in sample size** — 13.4 s at
     * n=2, 17.3 s at n=5 — which is what a tail looks like and is the reason the
     * numbers above are a range rather than a figure. Do not quote one of them.
     *
     * 30 s stays, for now and on thinner grounds than this comment first
     * claimed: the suite is green under real parallelism across five full runs,
     * and no test has come near the ceiling in the condition CI uses. But 1.7×
     * is not comfortable, the ceiling is demonstrably reachable (three
     * concurrent scenario suites hit it 3/3), and n=5 cannot rule out a worse
     * tail. If a sample ever exceeds ~20 s, or the suite grows, raise this —
     * against a fresh measurement in the PARALLEL condition, never an isolated
     * run, and report the range and the sample count rather than the worst.
     */
    testTimeout: 30_000,
    /** Teardown shells out to git too, and waits for it (see `test/tmpdir.ts`). */
    hookTimeout: 30_000
  }
})
