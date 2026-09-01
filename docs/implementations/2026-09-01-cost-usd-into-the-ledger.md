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
through a reader that already exists — so it is the right source for the LEDGER.
The statusline is now wired too, but as the *live* figure only and outside the
ledger; §10 gives the reconciliation and why it cannot be a ledger row.

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

- ~~No live agent's dollars.~~ **Closed — see §10.** The statusline's
  `cost.total_cost_usd` is now wired as a second, reconciled source, so a
  running agent shows a cost instead of null.
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

---

## 10. Addendum — the LIVE figure, from the status line

§8 above recorded "no live agent's dollars" as the remaining gap: `cost-state`
is written when a session ENDS, so a running agent showed tokens and a null
cost. This closes it, with the second money source the Architect asked for.

### 10.1 They are the same quantity — verified

Wiring a second source is only safe if the two describe the same thing. Two
independent confirmations, neither assumed:

- **The engine's own docs**, in the CLI binary: `total_cost_usd` and
  `modelUsage` are *"Cumulative … read the latest result rather than summing
  across results."* Both are session running totals.
- **The corpus**: across **17 of 17** sessions, a `cost-state` line's session
  scalar `totalCostUSD` equalled the sum of its per-model `costUSD` **exactly**
  (`diff < 1e-9`, 0 exceptions). The scalar the status line reports live and the
  breakdown the transcript reports at the end are the same money.

### 10.2 The rule: the larger of the two, never the sum

`sessionCostOf(spend)` in `src/shared/cost.ts` returns `{ usd, from }` where
`from` is `'ledger' | 'live' | 'none'`. Taking the **maximum** forecloses three
distinct bugs, which is why it beats every alternative considered:

| Alternative | What it does the moment a session ends |
|---|---|
| **add them** | double-counts — both sources now describe the same spend |
| **always prefer live** | goes backwards to null when the agent exits and the reading goes stale |
| **always prefer ledger** | shows nothing at all for the entire time a session is running |
| **maximum** ✓ | live fills the gap, ledger takes over once final, neither can double nor regress |

`from` is carried so the UI can say which it is showing: a live figure is
provisional, a ledger figure is final, and a number that cannot say which it is
invites being read as the wrong one.

### 10.3 The live figure is NOT in the ledger, deliberately

It is not folded into any row, and `todayTotals` / `cumulativeTotals` cannot see
it. Two reasons, both load-bearing:

1. **It would double-count.** The ledger's own `foldCosts` rows restate the same
   money minutes later.
2. **It is un-modelled.** The status line reports one session scalar with no
   per-model breakdown, and the ledger is keyed `(agent, session, model, day)`.
   Writing an un-attributed figure into a per-model append-only book would
   permanently damage attribution — and append-only means it could never be
   taken back.

Instead it reaches `spendFor` through an **injected lookup**
(`CostLedgerOptions.liveCost`), read fresh on every call from the file the
status line rewrites. The ledger stores none of it, so ADR-0011's ban on
in-memory cumulative figures is untouched: this is a cached read of a file,
refreshed on a timer, exactly like the pace — not a counter a restart can zero.

### 10.4 One report file per agent

The pacing change wrote a single `<home>/usage.json`, which was correct while
the only content was the account's usage **windows** — those are account-wide,
so any agent's reading is every agent's.

It stops being correct the moment the report also carries **this session's
cost**. Several agents render status lines constantly; one shared file is
last-writer-wins, so whichever agent rendered most recently would have every
other agent's spend attributed to it — the mis-attribution ADR-0011 rejected
provider-side caps for. So: `<home>/usage/<agent>.json`, one per agent.

Consequences handled:

- **Attribution is by the `agentId` INSIDE the report**, never by filename. The
  filename is a sanitised convenience and two ids could in principle sanitise to
  the same name; the payload id is what the shim was actually told it was.
- **The filename is sanitised anyway** — the id reaches a path, and an
  unsanitised one is a traversal waiting for the first id with a separator in
  it. `../../x` becomes `----x.json`, inside the directory.
- **The pace now reads the FRESHEST report across agents**, not the last writer.
  That is a strict improvement on the previous single-file behaviour: an agent
  that exited an hour ago can no longer out-vote one reporting now.
- **An agent-less render** (the Architect's own `claude` in a repo where our
  settings are installed) writes `_account.json`: its windows are still worth
  having, its cost is nobody's to attribute.
- **Staleness applies to the live figure too**, on the same threshold the pace
  uses. A figure whose agent exited is not live, and the durable row is the
  right answer from then on.

### 10.5 Verification

```bash
npx vitest run test/main/cost-in-dollars.test.ts test/main/pacing-wakes.test.ts test/main/engines/claude-usage-statusline.test.ts
```

**Mutation checks: 15, all red** — reconciliation (sum instead of max; always
live; always ledger; either source missing), attribution (a live figure from a
different session; from a different agent; a stale one), the shim (one shared
file again; unsanitised id; cost or session dropped; a nonsense cost let
through), and the pace reading an arbitrary report rather than the freshest.

### 10.6 A methodology failure worth recording

The first run of that mutation set reported **15/15 red — and was worthless.**
The baseline was not green: two tests were already failing (a stale assertion
from the file-layout rename, and an assertion polluted by a file an *earlier
mutation run* had written outside its temp directory). Every mutation "went red"
because the suite was red before it was touched.

Re-run against a genuinely green baseline, **three of the fifteen went GREEN**:
`UsageWatch.liveCostFor` and `freshest` had **no coverage at all** — agent
attribution, staleness, and freshest-wins were entirely untested. Seven tests
were added and the three are now red.

Two rules this earns:

1. **A mutation check is only evidence if the baseline is green.** Confirm green
   first; a red baseline makes every mutation look caught.
2. **A mutation that deliberately breaks a path guard can write outside the
   test's sandbox.** This one left a file in `%LOCALAPPDATA%` that then made an
   unrelated assertion pass-then-fail across runs. The traversal test now uses a
   target unique to each run, so no leftover can decide its outcome, and the
   stray file was deleted.
