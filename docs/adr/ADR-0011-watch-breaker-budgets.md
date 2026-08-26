# ADR-0011 — The Watch: circuit-breaker ladder and a durable cost ledger

**Status:** accepted · **Date:** 2026-08-26

## Context
Autonomous agents fail in characteristic ways: infinite loops (two agents politely
ping-ponging, a Stop-hook that keeps re-blocking), error storms (retrying a broken
command forever), and budget blowouts (an expensive model grinding on a doomed task).
Cost reporting must be trustworthy — upstream shipped a bug where the session counter
reset on restart and silently under-reported spend.

## Decision
**Circuit breaker — a three-step ladder, never a kill switch first:**

1. **Steer** — inject a corrective message into the agent's session ("you appear to be
   looping on X; step back and state your plan") and mark the avatar `looping`.
2. **Constrain** — tighten the agent's operating envelope: pause its Hermes inbox
   deliveries, lower its remaining budget, restrict it to read-only tools where the
   engine supports it.
3. **Stop** — graceful interrupt, then process stop; task returns to the ledger as
   `stalled` with the breaker report attached; Artemis decides reassignment.

Trip signals: repeated near-identical tool calls in a window, error-rate threshold,
hop-cap escalations recurring on the same conversation, budget burn-rate projection
crossing the task's remaining budget. Every trip and every rung transition is a log
event and appears in the next briefing (FR-11.3).

**Cost ledger — folded, durable, dual-figure:**
- Ground truth is the engine's own transcripts (adapter `TranscriptReader`), folded
  into an append-only SQLite ledger keyed by (agent, session, model, day).
- The UI always shows **session** and **cumulative** figures side by side; cumulative
  is computed from the ledger, never from an in-memory counter — an app restart cannot
  zero it (the upstream bug class is structurally excluded).
- Budgets are enforced pre-flight where possible (burn-rate projection) and post-hoc
  always; budget state feeds trip signal #4.

## Options considered
- **Hard kill on anomaly.** Destroys in-flight work and teaches the Architect to
  disable the breaker. The ladder preserves work and trust.
- **Watchdog timeouts only.** Time is the weakest signal — long-running legitimate
  builds look identical to hangs; behavioral signals (repetition, errors, burn rate)
  discriminate better.
- **Provider-side spend caps only.** Right as a backstop, but they're monthly-granular
  and can't attribute to agents/tasks.

## Consequences
- The breaker needs the event plane's tool-call stream (ADR-0002); on `pty-heuristic`
  engines its repetition signal is weaker — surfaced as reduced protection on the
  agent card.
- False trips are possible; rung 1 is deliberately cheap and non-destructive so the
  false-positive cost is one injected sentence.

## Prior art
Munder Difflin's breaker (steer/constrain/stop) and its 0.4.5 cost-ledger fix;
electrical breaker metaphor via Nygard's *Release It!*.
