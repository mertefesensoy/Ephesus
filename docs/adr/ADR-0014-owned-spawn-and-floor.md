# ADR-0014 — Own the process lifecycle (spawn, not attach); the floor as observability

**Status:** accepted · **Date:** 2026-08-26

## Context
Two ways to get agents: *attach* to terminal sessions the user already runs (tmux
pipe-pane — upstream's original MVP), or *spawn and own* every agent process. And one
standing question about the 2D floor: is it a gimmick?

## Decision — spawn, not attach
Ephesus spawns every agent itself via node-pty and owns the full lifecycle (spawn,
resize, interrupt, kill, resume). No tmux dependency.

Rationale: the company model requires owned lifecycles — identity injection at spawn,
env-scoped credentials (ADR-0010), hook wiring before first prompt, worktree isolation,
respawn-with-memory, and the Stop-hook loop all assume the harness created the process.
Attach mode was the right MVP for a *viewer*; Ephesus is an *employer*. Upstream itself
migrated from attach (SPEC.md) to owned spawn (README/HIVE) — we start where they
arrived.

## Decision — the floor is an observability surface, held to that standard
The Terraces (Pixi.js floor) stays, under one governing rule inherited and sharpened
from upstream: **every animation must convey real state faster than a text label
would** — walking to a station = which tool class is in use; envelope flight = a
Hermes delivery; waving = blocked on a gate; gathering in the Odeon = meeting in
session; the breaker's `looping` tint = tripped rung. Anything decorative-only is cut.
The floor renders *only* from event-plane data (ADR-0002) — it is a projection of
`log.jsonl`-adjacent state, never a second source of truth.

## Options considered
- **Attach (tmux) mode.** Zero-friction adoption for existing sessions, but forfeits
  everything above; also drags in a tmux dependency and its platform gaps. A read-only
  attach viewer could return someday as a minor feature; it is not the architecture.
- **No floor — panels and lists only.** Cheaper, and it would work. Rejected on product
  grounds: ambient glanceability (is the company busy? stuck? quiet?) is exactly what
  a spatial view gives and lists don't; it is also the emotional core that makes a
  company feel like one.
- **3D/isometric.** Cost with no informational gain.

## Consequences
- Ephesus must be good at lifecycle edge cases it can't defer to tmux: crash detection,
  ghost/archive states, session resume per engine adapter.
- The floor's honesty depends on hook fidelity; degraded engines get visibly simpler
  avatars (fewer stations) rather than invented motion.

## Prior art
Munder Difflin SPEC.md (attach MVP) → HIVE/README (owned spawn) migration; its
DESIGN.md principle "information through motion"; Stanford Generative Agents for the
spatial-agents lineage.
