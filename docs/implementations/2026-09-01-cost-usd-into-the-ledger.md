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
- ~~No UI change.~~ **Closed — see §11.** The dock, the card and the spend tab
  now show the money and the pace.
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

---

## 11. Addendum — surfacing pace and cost in the UI

§8 and §10.6 both recorded "no UI surface" as owed: pacing and cost existed only
as log events and runtime-health entries. That left the two questions they
answer — *"why is my company slow"* and *"what is this costing me"* — answerable
only by reading a log. Invariant §7 asks for every degradation to be **visible**,
and a paced company looks exactly like a stalled one until something says
otherwise.

### 11.1 Three surfaces, each answering a different question

| Surface | Question | Where |
|---|---|---|
| **Pace strip**, once above the dock | why is the company slow? | `paceStrip` in `AgentDock.tsx` |
| **Cost line**, per card | what is this agent costing? | `DockRow.cost` / `costNoteOf` |
| **Spend tab**, per agent | session vs today vs all time | `spendLines` in `AgentPanel.tsx` |

The pace is shown **once for the whole dock, not per card**. The usage window
belongs to the ACCOUNT, so repeating it on every card would state one fact N
times and invite reading it as an agent-level one.

### 11.2 The strip is silent at full speed — and loud when unobserved

`full` renders nothing: a banner that is always on stops being read, and a
company at full speed needs no explanation. Two states do show:

- **paced** (`slowing down` / `holding`), naming the window, its used-percentage
  and when it frees up, so a slow company is legibly slow rather than seemingly
  broken. A `hold` says *"until the window resets, frees up in 1h 30m"* — the
  bound is the point, and hiding it would make a bounded pause look like a hang.
- **`usage unseen`** — and this one is the argument. *"Full speed because the
  account has room"* and *"full speed because we cannot see the account"* are
  different facts, and only the second means the pacing signal is **not
  working**. Rendering them alike would hide precisely the failure the Architect
  needs to know about, so the unobserved state is marked `notable` and says
  `ungoverned` out loud.

The projection is named only when the projection is the reason: *"on course for
160%"* beside a window that is 40% used reads as an alarm about a number that is
not alarming.

### 11.3 The money says which figure it is

A dollar amount with no provenance is what this had to avoid becoming. The live
figure is provisional and the folded one is final, so the card renders
`$0.30 so far` versus `$0.48`, and the tooltip says which and why. Two rules
carried over from ADR-0011, now in the UI:

- **"not reported" is not "$0.00".** An engine that reports no cost and an agent
  that genuinely spent nothing must never render alike — the same rule the token
  meter already follows for `reporting: 'none'`.
- **Sub-cent spend is not rounded away.** `$0.004` renders as `$0.0040`, not
  `$0.00`; money that was spent must not render as money that was not.

The spend tab reports session, today and all-time **independently**. That was a
bug I introduced and caught: a first version returned early when the session had
no figure, which suppressed *today* and *all-time* along with it — a real state
(an earlier session today, a fresh one now), and an existing test caught it.

### 11.4 What is deliberately NOT shown

Wake deferrals and wake overruns are individually transient — a card that
flickered "deferred" every few minutes would be noise, and the pace strip
already answers the question a deferral raises ("why is nothing happening").
They remain log events and runtime-health entries. The same goes for the
cost-incomplete and cost-regressed reports: they are conditions of the figure,
and the figure's tooltip is where they would belong if they proved frequent.

### 11.5 Verification

```bash
npx vitest run test/renderer/spend-surface.test.tsx test/renderer/agent-dock.test.tsx
```

35 tests. Every colour is a design token (invariant: UI values come only from
tokens) — verified by extracting every `--eph-*` reference in `AgentDock.tsx`
and checking each is defined. The strip is `role="status"`, not `role="alert"`:
it changes on a five-second poll and must not interrupt a screen-reader user
repeatedly. The glyph sits beside the word, never instead of it (§8
double-encoding), the same rule the phase badge follows.

**Mutation checks: 13, all red** — a live figure presented as final; an
unreported cost rendered as zero; sub-cent spend rounded away; the IPC seam
trusted rather than normalised; the strip shown at full speed; `unobserved`
treated as ordinary full speed, and labelled as it; the reset time, the window
and the projection each suppressed or over-reported; a past reset reporting
negative time; the live marker and the all-time line dropped from the tab.

The runner now **refuses to run unless the baseline is green**, which is the
rule §10.6 earned — and it earned its keep immediately: the first attempt
aborted, and the red baseline turned out to be the `spendLines` early-return
regression described in §11.3. Under the old script that would have been
reported as thirteen successful mutation kills.

### 11.6 One hardening

`sessionCostOf` now normalises a missing live figure to null rather than
trusting it. The dock reads spend across an **IPC boundary**, so a version skew
or a partial payload can deliver a field the type says is always present — and
`formatUsd(undefined)` throws, which would blank the whole company panel. The
panel exists to end blindness about the company; crashing it on one malformed
row would be the richest possible irony. A test covers the partial payload.
