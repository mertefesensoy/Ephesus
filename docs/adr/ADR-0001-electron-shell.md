# ADR-0001 — Electron + React + TypeScript application shell

**Status:** accepted · **Date:** 2026-08-26

## Context
Ephesus needs: real PTYs (native addon), a GPU-accelerated 2D canvas, a full terminal
emulator, local sockets, filesystem/git access, microphone/audio for voice, and
cross-platform packaging — in one desktop app maintained by effectively one architect
plus agent labor.

## Decision
Electron with a React + TypeScript renderer, built with electron-vite. Main process owns
all privileged capability (PTYs, fs, git, sockets, secrets, audio device policy);
renderer is sandboxed with `contextIsolation` and talks only through a typed
`contextBridge` API. Pixi.js for the floor canvas, xterm.js for terminals, node-pty for
process control, better-sqlite3 for durable local state.

## Options considered
- **Tauri (Rust shell).** Smaller binaries, lower memory. Rejected for v1: the PTY +
  xterm + node ecosystem integration that this product lives on is first-class in
  Electron and DIY in Tauri; the team's leverage (agent CLIs writing TypeScript) favors
  one language end-to-end. Revisit if footprint becomes a real complaint (recorded as a
  potential superseding ADR).
- **Headless daemon + web dashboard.** Best remote story, but loses native PTY fidelity
  in the browser, complicates mic capture and local socket hooks, and adds an
  auth/serving surface we don't want to own. Remote command is instead handled by the
  Harbor bridge (FR-10.2).
- **Pure TUI.** Fastest to build; no floor, no slide decks, hostile to voice. The floor
  and the Odeon are the product.

## Consequences
- One language (TypeScript) across main, preload, renderer, and hook shims.
- We accept Electron's memory footprint; NFR-1/NFR-4 budgets are set with it in mind.
- Renderer never touches Node APIs; every capability is an explicit, reviewable IPC
  surface (helps NFR-8 and makes the permission story auditable).

## Prior art
Munder Difflin ships this exact stack at 15+ concurrent agents; adopting it wholesale
removes an entire class of platform risk.
