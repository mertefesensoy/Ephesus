import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer harness (M6.1). React components are rendered to static markup
  // with `react-dom/server` — already a dependency — so the shipped panel body
  // is what a test reads, with no DOM library added to the tree. `automatic`
  // matches tsconfig.web's `jsx: react-jsx`, so a test transforms the same way
  // the app does.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx']
  }
})
