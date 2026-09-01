# Dollars in the ledger: wiring the engine's own cost figures into `cost_usd`

**Date:** 2026-09-01 · **Branch:** `feature/usage-aware-pacing`
**Closes:** the item [2026-09-01-usage-aware-pacing.md §9](2026-09-01-usage-aware-pacing.md)
recorded as owed.
**No new ADR.** This does not change a decision — it *implements* one.
[ADR-0011](../adr/ADR-0011-watch-breaker-budgets.md) already specifies the ledger
as `cost_ledger(agent, session, model, day, in_tokens, out_tokens, **cost_usd**,
source)`. That column has been null since M3 for a stated reason ("the engine
reports no per-message cost … a guessed price is worse than an honest *not
reported*"). The reason turns out to be half wrong: the engine does report cost,
just not per message. This wires up what it does report.

---

## 1. Problem / Motivation

`AgentSpend` carries three money figures — session, today, cumulative — and all
three were permanently `null`. The UI could show tokens but never dollars, and
ADR-0011's own promise of a dual figure was half unmet.

The M3 comment was accurate about what it had looked at: there is no cost on an
`assistant` line. But Claude Code records money elsewhere, and the previous
change surfaced one place (the statusline's `cost.total_cost_usd`). Looking
properly turned up a better one.

---

## 2. What the engine actually reports — and how I know

Grepping the local transcript corpus for cost-shaped keys found `costUSD` and
`totalCostUSD` on a line type nothing in this repo reads:

```json
{ "type": "cost-state",
  "sessionId": "0fd850ec-…",
  "totalCostUSD": 0.4845593999999999,
  "modelUsage": {
    "claude-haiku-4-5-20251001": { "inputTokens": 1966, "outputTokens": 24,
                                   "cacheReadInputTokens": 0, "costUSD": 0.0020859999999999997 },
    "claude-sonnet-5":           { "inputTokens": 1019, "outputTokens": 7678,
                                   "cacheReadInputTokens": 503917, "costUSD": 0.4824733999999999 }
  },
  "hasUnknownModelCost": false }
```

This is **better than the statusline** for this purpose: it is per-model (which
is what the ledger is keyed on), it carries the engine's own honesty flag, and
it lives in the transcript the Watch **already reads** — so no new observation
channel, no shim, no settings surface.

### The four properties that drive the whole design

Measured over the 20 real transcripts in the Agora working directory, not
assumed:

| Property | Evidence | Consequence |
|---|---|---|
| **Cumulative, not incremental** | every file with a `cost-state` carried exactly **one distinct** `totalCostUSD` | folding must **difference**, never append |
| **Written more than once** | **17 of 17** files wrote the identical line **twice** | appending the value doubles the bill on the duplicate alone |
| **No timestamp** | no `timestamp` key on any `cost-state` line | it cannot name its own day; the day has to come from elsewhere |
| **Written at session end** | 2 of 17 also had one mid-file (a resumed session), same value; **3 of 20 files had none at all** | a live agent has no figure yet, and a killed one never gets one — absence must stay distinguishable from `$0` |

---

## 3. What Changed

| File | Change |
|---|---|
| `src/main/engines/types.ts` | **New** `CostFact` (a *cumulative* figure, deliberately a different type from the incremental `UsageFact`); optional `TranscriptReader.costs()`. |
| `src/main/engines/claude.ts` | **New** `claudeCostFacts()` parses a `cost-state` line; `claudeTranscripts.costs()` collapses several snapshots to the newest per (session, model). |
| `src/shared/cost.ts` | **New** pure `foldCosts()` — running totals in, append-only increments out, by differencing against the rows the ledger already holds. |
| `src/main/watch/ledger.ts` | **New** `CostLedger.foldCosts()`; `onCostRegressed` / `onCostIncomplete` options. |
| `src/main/watch/budgets.ts` | The production call: `foldOne()` folds tokens, then money, per transcript per tick. |
| `src/main/index.ts` | Wires both new degradation reports into runtime health. |
| `test/shared/fold-costs.test.ts` | **New.** The arithmetic, 15 cases. |
| `test/main/cost-in-dollars.test.ts` | **New.** Parser → reader → ledger → watcher, 22 cases. |

---

## 4. Implementation Approach

### The type is separate on purpose

`UsageFact` is an **increment** (one turn's tokens, appended once). `CostFact`
is a **running total** (rewritten as the session goes on). They arrive from the
same file and look superficially alike, and conflating them is exactly the bug
that would double the bill on the first re-read. Two types, two readers, two
fold functions — so the compiler keeps them apart.

### Folding differences, with the ledger as the baseline

```
delta = engine_cumulative − Σ(cost_usd already in the ledger for this session+model)
```

The baseline comes from the **ledger**, not from a counter. That is deliberate
and it is ADR-0011's own argument applied to money: a counter is a thing a
restart can zero, and the ledger is not. The consequence is that idempotency is
**structural** rather than bookkept — a fold that already happened is visible in
the rows, so re-folding subtracts to zero and appends nothing. There is no
cursor to keep in step, and the Watch's fifteen-second re-read of every file is
free.

The delta is also correct for the case a cursor would get wrong: a resumed
session whose total grows $0.20 → $0.50 records $0.30 more, not $0.50 more.

### Money rows carry no tokens

`modelUsage` repeats token counts that `foldFacts` already recorded from the
`assistant` lines. A money row therefore has `inTokens: 0, outTokens: 0`, and
`totalOf` sums it into `costUsd` alone. Counting them again is the double-count
the whole function exists to avoid.

### Which day the money belongs to

A `cost-state` line has no timestamp, so it cannot name its day the way a
`UsageFact` can. The rule: **money is billed to the day that session last spent
tokens on that model**, read out of the rows already in the ledger, falling back
to today only when the ledger has no dated row for it.

This is why `budgets.ts` folds **tokens first, then money, in that order**. The
other order sends every figure to the fallback day, and a session that ran
across midnight ends up with its dollars and its tokens on different dates.

### Three ways the figure can be less than the truth — all of them visible

| Situation | Behaviour |
|---|---|
| Engine could not price a model (`hasUnknownModelCost: true`) | the priced models are still recorded (those figures are true), and `onCostIncomplete` reports that the total is an **understatement, not the full bill** |
| Running total goes **down** (transcript replaced or rotated) | nothing recorded — a negative row is impossible and a positive one would invent money — and `onCostRegressed` says so; the earlier figure stands |
| No `cost-state` at all (killed session, live session, engine with no `costs()`) | no rows, so `costUsd` stays **null** — which the UI shows as "not reported", never as "free" |

---

## 5. Design Decisions

**Why `cost-state` and not the statusline's `cost.total_cost_usd`.** The
statusline figure is a whole-session scalar; `cost-state` is per-model, which is
the ledger's own key. It also carries `hasUnknownModelCost`, and it arrives
through a reader that already exists. The statusline stays what the previous
change made it: the pacing signal.

**Why `totalCostUSD` is not read at all.** The per-model figures sum to it, and
they attribute. Reading both would create two sources for one number, and the
first drift between them would be silent.

**Why a zero delta writes nothing.** So that an engine reporting `$0.00` and an
engine reporting nothing do not collapse into the same ledger state. Zero delta
→ no row → `costUsd` null → "not reported". ADR-0011 requires that distinction
for tokens; money gets it for the same reason.

**Why the parser checks `type` rather than duck-typing.** A future transcript
version, or a summary line, could carry a `sessionId` and a `modelUsage`-shaped
object without being a running cost total. Reading money out of it would add a
bill nobody was charged. (This was found by a mutation check that came back
green — see §7.)

**Why no new ADR.** ADR-0011 already specifies the column and the dual figure.
Nothing here contradicts a decision; the M3 note that dollars were unavailable
was an observation about the code at the time, not a decision to record.

---

## 6. Verification against the real corpus

The strongest evidence available: run the parser and the fold over the **actual
transcripts** and check the result against the engine's own arithmetic. Every
file in the Agora working directory, folded **three times** as the Watch would:

```
after pass 1:  34 cost rows, total $10.193202
after pass 2:  34 cost rows, total $10.193202
after pass 3:  34 cost rows, total $10.193202

files with a cost-state : 17
files WITHOUT one       : 3     (these keep costUsd null, not $0)
unpriced-model files    : 0
regressions seen        : 0

engine's own per-model total : $10.193202  (34 model entries)
ledger folded total          : $10.193202  (34 rows)
MATCH — fold reproduces the engine exactly
```

Two things are proved at once: the fold **agrees with the engine to the cent**
on real data, and it is **idempotent on real data** — passes 2 and 3 add no rows
and move no total.

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
```

```bash
npx vitest run test/shared/fold-costs.test.ts test/main/cost-in-dollars.test.ts
```

---

## 7. Mutation checks

Seventeen mutations; all seventeen red after the fix below.

| Mutation | Result |
|---|---|
| append the cumulative value instead of the delta | RED |
| a zero delta still writes a row | RED |
| a backwards total is recorded anyway | RED |
| money rows carry the tokens again | RED |
| day always falls back to today | RED |
| session ignored when matching existing rows | RED |
| model ignored when matching existing rows | RED |
| parser reads any line, not just `cost-state` | **GREEN → fixed → RED** |
| an unpriced bill is reported as complete | RED |
| a missing flag marks the bill incomplete | RED |
| a non-numeric cost is let through | RED |
| a line with no session is accepted | RED |
| reader yields every snapshot, not just the newest | RED |
| watcher never folds costs at all | RED |
| ledger does not report an incomplete bill | RED |
| ledger does not report a regression | RED |

**The green one was a real hole.** Deleting the `type !== 'cost-state'` guard
left the suite passing, because no fixture had a line that was *not* a
cost-state but *did* carry both a `sessionId` and a `modelUsage`. Duck-typing
would have read money out of any such line. A case was added covering a
`cost-state-v2` type, a `summary` type, and a line with no `type` at all; the
mutation is now red.

---

## 8. What this does NOT do

- **No live agent's dollars.** `cost-state` is written at session end, so an
  agent that is still running shows tokens and a null cost until it stops. The
  statusline's `cost.total_cost_usd` *is* live and could fill that gap, at the
  cost of a second money source that would have to be reconciled with this one.
  Not attempted; recorded as the obvious next step if the gap matters.
- **No cost for Codex or Gemini.** Neither adapter implements `costs()`, so
  their rows keep `costUsd` null — a visible tier, not a fault.
- **No UI change.** `AgentSpend` now carries real dollars in all three figures;
  what the renderer does with them is untouched.
- **No backfill.** Only transcripts of sessions the Watch folds get costed;
  history from before this change is not swept.
- **No price table.** Every figure here is the engine's own. Nothing is derived,
  which is what the M3 note was protecting and remains true.

---

## 9. Related Docs

- [Usage-aware pacing](2026-09-01-usage-aware-pacing.md) — the change this completes
- [ADR-0011 — The Watch: circuit-breaker ladder and a durable cost ledger](../adr/ADR-0011-watch-breaker-budgets.md)
- [ADR-0009 — Engine adapters](../adr/ADR-0009-engine-adapters.md)
- [docs/ENGINEERING-STANDARDS.md](../ENGINEERING-STANDARDS.md)
