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
