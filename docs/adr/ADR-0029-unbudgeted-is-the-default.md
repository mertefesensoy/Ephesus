# ADR-0029 — Unbudgeted is the default

**Status:** accepted · **Date:** 2026-09-06 · **Supersedes:** ADR-0011's default, not its
mechanism · **Relates to:** ADR-0023 (the wall-clock wake cap that survives this)

## Context

Every hire shipped with a per-day token ceiling, and the orchestrator carried a hardcoded one. On
2026-09-06, across a single MUSAHIT run, **four of five agents breached and two were rung-3
stopped** — including Artemis, at 102% of forty million, mid-run, with five incidents unrouted.

The numbers were not the problem, and raising them did not fix it. The ceilings had already been
raised once that morning on the Architect's decision (ci-babysitter 20M → 60M, health-watcher
10M → 25M) with the figures in front of them; both hires breached again within the hour, and
Artemis — untouched at 40M — breached too.

Three things compound:

- **A rung-3 stop blocks respawn.** The agent is gone until a human clears the stop.
- **Activation is all-or-nothing** (`profiles.ts`, deliberate: "a half-activated crew is worse
  than none"). One stopped hire refuses the whole company.
- **The stop outlives its condition.** Nothing re-evaluates it when the window rolls or the
  ceiling is raised, so the Architect must clear it by hand, having been shown a
  `budget: breached` that may no longer be true.

The result is that a spend limit intended as a runaway backstop became the most reliable way to
stop the company doing its job. `ARTEMIS_DAILY_TOKENS`'s own docblock had predicted the failure in
the other direction after the 2026-09-01 run — "two million was not a limit that shaped behaviour;
it was a limit that fired immediately and permanently, which is the same as having no signal at
all" — and then argued that the answer was a bigger number. Forty million produced the same
outcome five days later. A ceiling that fires on ordinary work is not a ladder; it is the same
failure with more digits.

## Decision

**A hire with no declared budget is unbudgeted, and no shipped profile declares one.** The
orchestrator is unbudgeted unless the Architect names a figure.

Nothing in the mechanism changes. `budgetFor` already returned
`{ state: 'unbudgeted', because: 'no-budget' }` for a null ceiling, the hire schema already made
`budget` optional and said so in its own docblock — *"an unbudgeted hire is legal and shows as
`unbudgeted`, rather than as a zero the Watch would treat as an immediate breach"* — and the spawn
path already resolved `request.budget?.dailyTokens ?? rosterBudget?.(agentId) ?? null`. Unbudgeted
was always reachable and always legal. **It is the default that moved, not the capability.**

`ARTEMIS_DAILY_TOKENS` stays exported at 40,000,000 for an Architect who wants a ceiling, because
ADR-0011 is right that the ladder needs one to be a ladder. What changed is that the harness stops
choosing it for them.

## What this does NOT remove

This is the part that decides whether the decision is defensible, so it is stated plainly rather
than left to be inferred.

The burn-rate signal is **trip signal #4 of four** (`shared/breaker.ts`), and it fires only on
`budget === 'breached'`. An unbudgeted agent cannot trip that one. Everything else is untouched:

- **Repeated near-identical tool calls** — same tool AND same argument fingerprint in a window.
  An agent reading twenty different files is working; one reading the same file twenty times is
  stuck, and that is still caught.
- **Hop-cap escalations** on one conversation (trip signal #3).
- **Pathology** reported through the event plane (ADR-0013, rung 1).
- **ADR-0023's wall-clock wake cap** — ten minutes, measured, and the only governor that bounds a
  slow expensive turn rather than a token count. It interrupts the turn and leaves the agent
  hired.
- **The cost ledger itself**, which keeps folding real spend into `db.sqlite` and reporting it in
  the Watch. Removing the ceiling does not stop the counting, and an Architect can still see every
  figure that produced this decision.

So the loop detector, the stall detector and the turn-length bound all survive. What is gone is a
number that fired on ordinary work.

## Consequences

**A runaway now costs real money before a human notices.** That is the trade, and it is the
Architect's to make — which is why this ADR exists rather than a quiet default flip. The
compensating controls above are behavioural rather than financial: they catch an agent that is
stuck, not one that is expensively productive.

**Every spend figure remains visible.** `watch.budgets()` reports `unbudgeted` with the real
totals, so "no ceiling" never means "no number". An Architect watching a run sees exactly what they
saw when they made this call.

**Restoring a ceiling is one line**, per hire, in the file the Architect already reads before
activating — `"budget": { "dailyTokens": N }`. The path back is deliberately as short as the path
here.

**The three compounding problems above are NOT fixed by this**, only defused for the budget
signal. A rung-3 stop from any other signal still blocks respawn, still takes the whole activation
down, and still outlives its condition. Those are worth a Gymnasium proposal on their own, and this
ADR should not be read as having answered them.

## Alternatives considered

**Raise the ceilings again.** Tried the same morning, on the Architect's decision, with the figures
in front of them. Both raised hires breached again within the hour. A number chosen without
measurement is a guess, and the measurement now available says the work costs more than any figure
anyone has guessed so far.

**Make the breaker re-evaluate a stop when its condition expires.** The right fix for one of the
three compounding problems, and genuinely worth doing — but it addresses the stop's *stickiness*,
not the fact that the ceiling fires on ordinary work. It is a Gymnasium proposal, not this
decision.

**Let the activation proceed without a stopped hire.** Rejected: `profiles.ts` argues the
all-or-nothing rule well, and weakening a documented safety property to work around a budget is the
wrong lever.

**Budget the company rather than each agent.** The most interesting option and the one this ADR
does not take, because there is no ledger shape for it today and inventing one under time pressure
is how the original per-agent numbers got chosen. Recorded as the direction rather than deferred
silently.
