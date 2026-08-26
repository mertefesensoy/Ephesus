# ADR-0002 — Two data planes: terminal (PTY) and event (hooks)

**Status:** accepted · **Date:** 2026-08-26

## Context
The UI needs two different truths about every agent: the *exact* byte stream the CLI
produced (the Architect must be able to trust the terminal absolutely), and *structured*
lifecycle state (which tool is running, when a turn started/stopped) to drive avatars,
routing, budgets, and the autonomy loop. Parsing structure out of terminal bytes is
fragile (ANSI, spinners, provider redesigns); rendering a terminal out of events is
impossible.

## Decision
Two independent planes feeding one renderer:

- **Terminal plane.** Main-process `PtyManager` spawns each engine in node-pty and
  streams bytes over per-id IPC channels to xterm.js. Bytes are never interpreted for
  semantics.
- **Event plane.** Each engine's hook mechanism runs a tiny shim CLI that tags the hook
  JSON with the agent id and POSTs it to a local socket owned by the main process
  (`eph-hook` for Claude Code; per-engine shims elsewhere). Events drive the avatar
  state machine, Hermes wakeups, telemetry spans, and the circuit breaker.

Where an engine has no hook mechanism, its adapter MAY register a PTY-output heuristic
parser as a *degraded* event source, visibly flagged as such (FR-2.3).

## Options considered
- **Events only** — no authentic terminal; unacceptable for an expert operator.
- **PTY parsing only** — fragile, breaks silently on engine updates; was explicitly the
  failure mode upstream replaced with hooks.
- **Engine APIs/SDKs instead of CLIs** — see ADR-0009; rejected as the primary path.

## Consequences
- The floor can lie only by omission (missing events), never by invention; the terminal
  never lies. Debugging always has ground truth.
- Every new engine costs a shim + state mapping; this is the engine adapter conformance
  surface tested in the test strategy.
- The hook socket is a privileged local endpoint: it authenticates callers by filesystem
  permissions (socket file mode 0600, per-spawn token in the payload).

## Prior art
Munder Difflin SPEC.md §2 ("the load-bearing design decision"); its evolution from
tmux `pipe-pane` attach to owned PTYs validated the plane split independently of the
attach-vs-spawn question (ADR-0014).
