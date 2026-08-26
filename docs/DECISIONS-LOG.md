# Decisions log

Minor mechanical choices made under BUILD-PROMPT §8.2 — smallest choice consistent
with existing patterns. One line each: date · choice · reason. Anything bigger goes
through the must-ask protocol (§8.3) or a Gymnasium proposal.

---

- 2026-08-26 · `.nvmrc` pins `20` (installed toolchain is Node 20.16.0; docs require 18+) · matches the machine CI and dev actually run on.
- 2026-08-26 · Toolchain sub-dependencies of the §10 pre-approved set installed without a memo: `vite` + `@vitejs/plugin-react` (required by electron-vite for React), `typescript-eslint` + `eslint-config-prettier` (required for ESLint to parse TS / not fight Prettier), `@types/node|react|react-dom` (type-only) · treated as "implied by the docs" (BUILD-PROMPT §7), flagged in the session report for Architect review.
- 2026-08-26 · Import-boundary lint implemented with core `no-restricted-imports` per-directory overrides instead of an extra plugin · zero new dependencies, same enforcement.
- 2026-08-26 · `postinstall` electron-rebuild deferred until `node-pty` lands in M0.3 · nothing native to rebuild before that.
- 2026-08-26 · Pixel fonts (Press Start 2P, Pixelify Sans, IBM Plex Mono) not yet bundled; token files declare the stacks with monospace fallback · font bundling owed by M0.4 floor/visual package.
- 2026-08-26 · `vite` pinned `^7` and `@vitejs/plugin-react` `^5` · electron-vite@5 peers on vite ≤7; npm's default pick (vite 8) is ERESOLVE-incompatible.
- 2026-08-26 · `@eslint/js` added as explicit devDependency · ESLint 10 no longer exposes it transitively; required by the flat-config recommended preset.
- 2026-08-26 · `electron` pinned to `^37` · electron ≥38 requires Node ≥22.12 at install time; this machine + `.nvmrc` + CI run Node 20. Revisit when Node is upgraded (flagged in session report).
- 2026-08-26 · Vitest config lives in `vitest.config.mts` (ESM) · vitest 4 cannot load a CJS-interpreted `.ts` config in a non-`"type": "module"` package.
- 2026-08-26 · `@xterm/addon-fit` installed alongside pre-approved `@xterm/xterm` · standard first-party companion for sizing the terminal to its panel; flagged for Architect review with the other toolchain implieds.
- 2026-08-26 · `scripts/patch-node-pty.cjs` runs in postinstall before electron-rebuild · two Windows build defects in node-pty 1.1.0: (a) winpty.gyp calls helper `.bat`s by bare name, which current Win11 builds no longer resolve from the cwd — patched to `.\`-prefixed; (b) its gyps demand Spectre-mitigated MSVC libs this machine's VS lacks (MSB8040) — patched to `SpectreMitigation: false`. Idempotent, Windows-only, no-ops elsewhere.
- 2026-08-26 · `src/shared/ipc.ts` must stay free of runtime deps (zod) because the sandboxed preload imports it and sandboxed preloads cannot require external modules · channel names/helpers live there; zod schemas live in the sibling schema modules imported only by main.
- 2026-08-26 · Vitest suites do not import `node-pty` (validators only) · node_modules build is Electron-ABI after electron-rebuild and cannot load under the Node test runner; PTY behavior is covered by the M1 conformance/E2E rigs per TEST-STRATEGY.
