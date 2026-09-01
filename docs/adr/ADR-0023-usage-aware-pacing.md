# ADR-0023 — Pace the company against the account's usage window, not a fixed budget

**Status:** accepted · **Date:** 2026-09-01
**Supersedes:** the budget clause of [ADR-0011](ADR-0011-watch-breaker-budgets.md)
— specifically *"Budgets are enforced pre-flight where possible (burn-rate
projection) and post-hoc always; budget state feeds trip signal #4."* Everything
else in ADR-0011 — the ladder, the durable folded ledger, the dual figure —
stands unchanged and this decision depends on it.

## Context

ADR-0011 gave every agent a daily token ceiling (`registry.agents[id].budget.dailyTokens`)
and fed both the ceiling and a *projection* toward it to the breaker.

That is a fixed number in a system with no fixed lifetime. Ephesus is meant to
run for days; any constant is either too small to survive the day or too large
to mean anything. Both halves of that were observed on 2026-09-01:

- ceilings of 200k–500k were blown 4–7× within minutes;
- raised to 10M–20M, all four agents still reached `projected-breach` inside
  twenty minutes and the breaker throttled two of them to rung 2.

A governor that fires on ordinary work is one the Architect switches off, and
ADR-0011 says so itself about false trips.

Two further facts came out of measuring the run rather than arguing about it
(numbers in `docs/implementations/2026-09-01-usage-aware-pacing.md`):

1. **91.4 %** of Artemis's 24.47M-token day was re-reading context that already
   existed when a wake began — `context_at_wake_start × api_calls_in_wake`. A
   token budget is therefore measuring how many times an agent re-read itself,
   which is why raising the ceiling fifty-fold changed nothing.
2. **The wake is the unit of spend.** 39 % of the day (9.54M) went to stop-hook
   re-wakes carrying about a kilobyte of new information each, at a mean 561k
   tokens per wake.

Meanwhile there *is* a signal that moves with what the Architect actually pays,
and that **resets**: the account's rolling 5-hour and 7-day usage limits. It was
established by experiment — not assumed — that the engine hands these to a
configured `statusLine` command as
`rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`, and that it
omits them until after the first API response. A live capture is recorded in the
implementation doc.

## Decision

**1. The company is paced by the account's usage window.**
A statusline shim (`shims/eph-usage.mjs`), installed into the same settings file
the hook shim already uses, writes each observation to `<home>/usage.json`. The
Watch reads it and computes a company-wide pace — `full`, `slow`, or `hold` —
from three rules, worst window winning (`src/shared/pacing.ts`):

- a window whose `resets_at` has passed exerts no pressure at all (*"if the
  weekly limit is reset it will march forward"* — the Architect);
- at or above `slowAtPercent` (default **90**, the Architect's stated rule) the
  company slows; at or above `holdAtPercent` (default 97) it holds until the
  reset, which is a **known instant** and therefore a bounded pause;
- below those, a window being spent faster than it elapses still slows the
  company — projected as `used% / elapsed_fraction`, and only once
  `minElapsedFraction` of the window has actually elapsed.

**2. The pace throttles WAKES, because the wake is what the harness issues.**
Both wake paths — `Hermes.wakeCheck` (inbox) and `Hermes.decideOnStop`
(stop-hook) — consult the pace and share one per-agent gap. A deferred wake
leaves the mail exactly where it is; nothing is consumed, so the same message
still earns its wake once the pace allows one.

**3. A wall-clock cap per wake, independent of tokens.**
`WakeClock` bounds a single wake in real time (default 10 min) and ends an
overrun with the engine's own cancel key. Every other governor in the Watch
counts tokens and is blind to a slow, cheap, stuck turn.

**4. The per-agent ceiling is demoted to a runaway backstop.**
`budget.dailyTokens` stays, and `breached` still feeds trip signal #4. But
`projected-breach` no longer trips the breaker: forecasting now belongs to the
pacer, which forecasts against a real resetting window instead of a constant.

**5. Pacing is a governor, not an interlock.** No signal, a stale reading, or a
harness assembled without the shim all mean `full`. The company behaves exactly
as it did before, and the backstop in (4) is what covers a runaway.

## Options considered

- **Keep tuning `dailyTokens`.** Rejected by evidence: two settings three orders
  of magnitude apart both failed, in opposite directions, on the same day.
- **Read `/api/oauth/usage` directly.** The endpoint exists (it is a string in
  the CLI binary and is almost certainly what `/usage` calls), but reaching it
  needs the OAuth token in `~/.credentials.json`. The harness must not read the
  Architect's credential store, and an undocumented endpoint is not a contract.
  The statusline is a *supported* extension point we already install into.
- **Parse `rateLimits` out of transcripts.** The field exists in the transcript
  schema but only on `request_retry` error records, and is `null` in every one
  across the whole local corpus. It is populated from a 429 — that is, only
  once it is already too late.
- **Cap by wall-clock alone.** Time is the weakest discriminator (ADR-0011 says
  so). It is adopted here as a *second, independent* limit, not as the governor.
- **Throttle tokens rather than wakes.** The harness cannot spend a fraction of
  an API call. The wake is the only quantum it actually controls.

## Consequences

- Pacing depends on an engine that renders a status line and reports limits.
  Engines that do not (and API-key accounts, which have no subscription window)
  pace at `full` and are governed only by the backstop — a visible product tier,
  in the same shape as ADR-0009's optional `transcripts`.
- A `hold` stops new wakes company-wide until a reset. It is bounded and its end
  is known, and it is surfaced as a degradation with the reset time, but the
  company genuinely does less work while it holds. That is the intent.
- Every observation costs one short-lived process per status render. The shim is
  fail-open and time-bounded, because it sits on the agent's critical path.
- `usage.json` is written by agents and read by the harness, so it is a shared
  file: atomic (temp+rename) and schema'd with `schemaVersion` (invariants §4,
  §9).

## Prior art

The pace-vs-elapsed comparison is the same shape as ADR-0011's own burn-rate
projection, moved onto an input that resets. Rate-limit-aware client backoff is
standard practice; what is unusual here is that the limit belongs to the human
who owns the account, so the harness reads it rather than discovering it from a
429.
