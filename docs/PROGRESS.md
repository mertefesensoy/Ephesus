# Ephesus — Build Progress

Tracks work-package completion per BUILD-PROMPT §5. Every tick carries a one-line
evidence note. The next session resumes at the first unchecked box.

---

## M0 — Skeleton

- [x] **M0.1 Scaffold** — electron-vite + React + TS; three tsconfig projects
      (node/preload/web); `dev|build|typecheck|lint|test` wired; Vitest; ESLint +
      Prettier zero-warning; import-boundary lint rules; CI self-armed.
      *Evidence: `npm run typecheck && npm run lint && npm test` all green (1/1 test);
      renderer→electron import provably rejected by `no-restricted-imports`;
      `npm run dev` boots Electron 37, renderer shows the skeleton shell with zero
      console errors (verified in browser against the vite dev URL).*
- [ ] **M0.2 Preload bridge** — typed `window.eph` skeleton with `config:get`
      round-trip; validator pattern in `src/shared/`.
- [ ] **M0.3 PTY vertical** — `PtyManager` spawns one hardcoded shell; bytes over
      per-id IPC to xterm.js panel; write/resize/kill.
- [ ] **M0.4 Floor vertical** — Pixi canvas, one terrace room (UI-DESIGN §5 tokens),
      one avatar walking between two points at §6 timings; pauses when hidden.
- [ ] **M0.5 App state** — better-sqlite3 store for window bounds; harness home at
      `~/.ephesus/` per SDD §2 (directories + `config.json`).
- [ ] **M0 exit review** — `npm run dev` shows floor + live interactive terminal;
      CI green; evidence recorded here.

## M1 — One real agent, both planes

- [ ] M1.1 Engine adapter interface (ADR-0009)
- [ ] M1.2 Fake engine (`test/fakes/fake-engine`)
- [ ] M1.3 Hook server (UDS / named pipe, per-spawn token)
- [ ] M1.4 Claude Code adapter
- [ ] M1.5 Avatar state machine (SDD §6)
- [ ] M1.6 Command bar
- [ ] M1.7 Conformance suite v1
- [ ] M1 exit review — UC-03 demo with real `claude`; conformance green

## M2 — The Agora + Hermes

- [ ] Package list derived at milestone start (BUILD-PROMPT §5)
- [ ] M2 exit — scripted two-agent collaboration unattended; S-BLACKOUT, S-LIVELOCK,
      S-BOUNCE, S-WAKE, S-STOPLOOP pass

## M3 — Artemis + the Watch

- [ ] Package list derived at milestone start
- [ ] M3 exit — UC-02 + UC-08 demos; S-GATE, S-BREAKER, S-LEDGER, S-SECRETS pass

## M4 — The Library + engine breadth

- [ ] Package list derived at milestone start
- [ ] M4 exit — respawn-with-memory; recall smoke test; two extra engines conform

## M5 — The Odeon + Gymnasium v1

- [ ] Package list derived at milestone start
- [ ] M5 exit — S-DECKGATE, S-MEMO, S-BRIEF, S-MEETING, S-GYM pass; real retro report

## M6 — The Herald

- [ ] Package list derived at milestone start
- [ ] M6 exit — SRS §6.2 + §6.5 live; S-FAILOVER scripted pass

## M7 — The Harbor + missions

- [ ] Package list derived at milestone start
- [ ] M7 exit — one-hour company test (SRS §6.1) on a real repo; S-PROFILE pass
