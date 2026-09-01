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
     * per round trip. `honours the hard block cap` measures ~8.8 s running
     * ALONE on an idle machine; under the parallel workers a full run uses, the
     * same work takes longer still, and those two files were the whole of the
     * suite's timeout flake.
     *
     * A timeout is here to catch a HANG, not to fail work that is merely slow.
     * 30 s keeps that job — a genuinely stuck test still fails, just later —
     * while leaving honest headroom on a loaded Windows machine.
     */
    testTimeout: 30_000,
    /** Teardown shells out to git too, and waits for it (see `test/tmpdir.ts`). */
    hookTimeout: 30_000
  }
})
