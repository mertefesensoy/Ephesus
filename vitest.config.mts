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
     * FULL SUITE, default parallelism   12.3 s, 13.4 s   <- what CI runs
     * ```
     *
     * So the real headroom is about **2.2×**, not the ~3.4× the isolated number
     * implied. `signals the breaker at rung 1` and `honours the hard block cap`
     * are the two slowest; S-LIVELOCK's worst sits at 9.0–11.0 s, which is the
     * same band — the two files are not distinguishable, contrary to an earlier
     * claim made from isolated runs.
     *
     * 30 s stays. The suite is green under real parallelism across repeated
     * runs, and a ceiling nothing reaches in the condition CI actually uses is
     * not worth raising. But the ceiling IS reachable — three concurrent
     * scenario suites hit it 3/3 — so this is a live margin, not an unreachable
     * one. If the suite grows or a runner is slower than this machine, raise it
     * against a fresh measurement in the parallel condition, and do not quote an
     * isolated run as evidence.
     */
    testTimeout: 30_000,
    /** Teardown shells out to git too, and waits for it (see `test/tmpdir.ts`). */
    hookTimeout: 30_000
  }
})
