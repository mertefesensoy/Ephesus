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
- 2026-08-26 · `pixi.js/unsafe-eval` imported in the floor module · Pixi's default shader codegen needs eval, which the strict CSP (ENGINEERING-STANDARDS §5) forbids; this official module swaps in eval-free paths — CSP stays strict.
- 2026-08-26 · `config:get` returns `{ config, warning }` (ConfigSnapshot) · an invalid `~/.ephesus/config.json` must surface visibly (BUILD-PROMPT §3.7); the file is never silently overwritten, the app runs on defaults with the warning shown in the status line.
- 2026-08-26 · `postinstall` now `electron-rebuild -f` (all native deps) · better-sqlite3 joined node-pty; rebuilding everything is simpler than maintaining a module whitelist.
- 2026-08-26 · `@types/better-sqlite3` added (type-only) · better-sqlite3 ships no types.
- 2026-08-26 · `EPH_HOME` env override for the harness home root · lets tests/E2E boot against a temp home (TEST-STRATEGY §4) without touching the real `~/.ephesus/`.
- 2026-08-26 · (M0 audit) `pty:ensure-dev-shell` is a temporary M0 channel · replaced by `agents.spawn` in M1; retire it when the claude adapter lands.
- 2026-08-26 · (M0 audit) `pty.kill` lives in the `pty:` group for M0 · SDD §5 homes `kill(id)` under `agents:`; folds into the agents group in M1 with the adapter lifecycle.
- 2026-08-26 · (M0 audit) `pty:exit:<id>` push event added beside `pty:data:<id>` · needed to make kill/exit outcomes visible; SDD §5 calls its event list abridged.
- 2026-08-26 · (M0 audit) Pixel-font bundling debt re-scoped: not delivered in M0.4 as originally logged · owed by the first M1 package that touches renderer chrome (M1.6 command bar) or earlier; awaiting Architect acknowledgment.
- 2026-08-26 · (Architect directive) MemPalace adopted as the Library's recall index and company archive · ADR-0016; docs updated across README, SDD §1.1/§2/§12, IMPLEMENTATION M4, BUILD-PROMPT §10; lands in M4, optional dependency with the FTS/grep degrade ladder intact.
- 2026-08-26 · (Architect directive) Floor art quality bar raised to Munder Difflin level · UI-DESIGN §7 rewritten (licensed tileset path + attribution rules + walk-cycle citizen bar); new package M1.5b in PROGRESS/BUILD-PROMPT; supersedes the "no licensed-asset dependency in v1" stance. Font debt folded into M1.5b (closes the pending acknowledgment above).
