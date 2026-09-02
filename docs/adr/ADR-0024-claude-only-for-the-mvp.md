# ADR-0024 — The MVP ships one engine, and says so

**Status:** accepted · **Date:** 2026-09-02
**Relates to:** [ADR-0009](ADR-0009-engine-adapters.md) — this SCOPES what ships;
it does not supersede or weaken the adapter seam. ADR-0009 already names Claude
Code the reference adapter and the only one that may gate a release, and
SRS FR-1.2 requires only the seam. **The normative documents already held this
position; the shipping surface disagreed with them.** This ADR makes the
surface honest, and is deliberately reversible.

## Context

Ephesus registers three engine adapters and advertises five engines. Measured on
2026-09-02, not inferred:

| claim | reality |
|---|---|
| `README.md:51` — "`codex`, `gemini`, `grok`, `opencode`, and friends — as fully-capable agents" | Adapters exist for **three**: `claude.ts`, `codex.ts`, `gemini.ts`. `grok` and `opencode` have **no adapter at all**. |
| A hire may declare any engine | The hire schema accepts any engine string, and both partial adapters are registered as spawnable. |
| A profile's autonomy reaches the engine | `grep -c autonomy` is **5** in `claude.ts` and **0** in both others. An `autonomous` grant is silently dropped. |
| An agent continues its own work (ADR-0013) | Without a Stop hook there is no continuation loop, so such an agent **stops after one turn**. |
| The floor shows what an agent is doing | With no hook stream the avatar asserts a confident `idle` forever; `AVATAR_STATES` has no `unknown`. |

Each of those is a silent wrong answer rather than a failure. A codex agent does
not error — it runs once, reports idle, ignores the autonomy it was granted, and
the Architect has no way to see that any of it happened. The activation screen
prints "on codex" with no warning.

Three of the MVP register's `blocks-mvp` findings and two of its cosmetic ones
are this single disagreement wearing different clothes.

## Decision

**For the MVP, Ephesus ships Claude Code and refuses the rest at the door.**

1. **Refuse, do not degrade.** A profile or hire declaring a non-reference engine
   is refused at profile load, naming the engine and the reason. The refusal is
   the feature: a company that silently runs at one turn per wake is worse than
   one that will not start.
2. **The README states what ships.** One engine, named, with the seam described
   as a seam rather than as breadth already delivered.
3. **The hook grade is renamed.** `pty-heuristic` names a mechanism that was
   never implemented — all fifteen occurrences are declarations, a breaker
   downgrade, or comments. It becomes `none`, which is what it is.
4. **The adapter seam stays exactly as ADR-0009 defines it.** The partial
   adapters stay in the tree, unregistered, as the conformance suite's second
   implementation.

## What this decision is NOT

**It is not permission to collapse the abstraction.** The strongest argument
against shipping one engine is that a single-engine system grows engine-specific
knowledge everywhere, and NFR-12 exists to prevent exactly that. Keeping
`codex.ts` and `gemini.ts` in the tree and in the conformance suite is what keeps
the seam honest — a suite with one implementation only proves that implementation
compiles. **If a later change makes the conformance suite pass by special-casing
Claude, this decision has been misread.**

**It is not a claim that the other adapters are close.** They lack autonomy
plumbing, a continuation loop, a notification path and trust handling. Finishing
them is four work packages, not four patches.

## Consequences

- The activation preview and profile loader gain a refusal path with a stated
  reason. That path needs a test in both directions — a reference engine loads,
  a non-reference one is refused and says why.
- **The conformance suite gains an autonomy case.** Its absence is precisely why
  the silent drop went unnoticed for two milestones, and adding it is the part of
  this decision that prevents a recurrence rather than merely documenting one.
- The Watch panel's claim that codex and gemini are "blind to repetition,
  error-rate" — implying burn-rate still protects them — comes out; it folds
  transcript rows those adapters never produce.
- Artemis is currently hired on `engines.list()[0]?.id`. Under a single
  registered engine that is harmless, which is exactly why it must be named
  explicitly now: reordering three adjacent registration lines would otherwise
  put the orchestrator on a refused engine.

## Revisiting

Reopen when a second engine is wanted as a **product** rather than as a
demonstration of the seam. The bar is the conformance suite passing for that
engine on autonomy, notification and trust — not "it spawns". Until then the
seam's value is that the second implementation exists to test against, and the
MVP's value is that what it says it does is what it does.
