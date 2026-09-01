# Usage-aware pacing: governing the company by the account's real window

**Date:** 2026-09-01 · **Branch:** `feature/usage-aware-pacing` (cut from
`fix/workspace-trust-and-remembered-targets`) · **Supersedes part of:**
[ADR-0011](../adr/ADR-0011-watch-breaker-cost-ledger.md) via
[ADR-0023](../adr/ADR-0023-usage-aware-pacing.md)

---

## 1. Problem / Motivation

Per-agent daily token budgets (`registry.agents[id].budget.dailyTokens`,
ADR-0011) are a **fixed number in a system with no fixed lifetime**. The company
is meant to run for days. Any constant is either too small to survive the day or
too large to mean anything, and the evidence says both happened on the same day:

| Budget set | Outcome |
|---|---|
| 200k–500k | blown 4–7× within minutes |
| 10M–20M | all four agents reached `projected-breach` in twenty minutes; the breaker throttled two to rung 2 |

Artemis alone burned **24.47M tokens** on 2026-09-01 (measured below — the
figure matches the ledger's).

The number that *does* move, and that the Architect actually pays against, is
the account's rolling usage window: a 5-hour session limit and a 7-day weekly
limit, each of which fills and then **resets**. A limit that resets is something
a long-running company can be paced against. A constant is not.

The requirement, in the Architect's words:

> "this system is supposed to work for days so no matter what we do that budget
> will be reached. So they will have to be dynamically following what the
> account's usage limit is. For example if my 5 hour usage limit comes to 90
> percent the company will slow down things. Or if the weekly limit is reset it
> will march forward."

---

## 2. The load-bearing unknown, resolved by experiment

**Question:** is the account's usage window readable programmatically, or must
the design fall back to what the harness can already observe (folded transcript
spend)?

**Answer: it is readable, and it was OBSERVED, not inferred.**

Claude Code passes a JSON document on **stdin to the configured `statusLine`
command** on every status render. That document carries a `rate_limits` block.

### How this was established

1. **Read out of the shipped binary's own documentation.** The CLI
   (`@anthropic-ai/claude-code@2.1.252`, `bin/claude.exe`) embeds the statusline
   input schema as literal text:

   ```
   "rate_limits": {   // Optional: Claude.ai subscription usage limits ... Only present for
                      // subscribers ... after first API response, while at least one window is present.
     "five_hour": {   // Optional: 5-hour session limit (present only while the API reports it
                      // and its resets_at has not passed)
       "used_percentage": number,   // Percentage of limit used (0-100)
       "resets_at": number          // Unix epoch seconds when this window resets
     },
     "seven_day": { ... },          // 7-day weekly limit, same shape
     "spend_limit": { ... }         // behind a Claude gateway only
   }
   ```

2. **Confirmed live by running it.** A real `claude` was spawned in a
   **node-pty pseudo-terminal — the same way Ephesus spawns agents** — with
   `--settings` pointing at a `statusLine` command that appended its stdin to a
   file. Three renders were captured. The third:

   ```json
   "rate_limits": {
     "five_hour": { "used_percentage": 12,   "resets_at": 1788294000 },
     "seven_day": { "used_percentage": 29.0, "resets_at": 1788753600 }
   }
   ```

   Decoded: the 5-hour window reset **4.60 h** later, the weekly window
   **132.26 h** later (Mon 2026-09-07 04:00 UTC). Both plausible; both moved
   with the account, not with the process.

3. **The documented absence reproduced too.** The *first* render carried no
   `rate_limits` key at all — exactly as documented ("after first API
   response"). The design therefore must treat "no window observed" as a real,
   first-class state, not as zero.

### What is NOT readable

Checked and found to carry nothing usable — recorded so nobody re-checks them:

| Candidate | Verdict |
|---|---|
| `~/.claude/stats-cache.json` | message/session/tool **counts** only, no limits, last computed 2026-04-16 |
| `~/.claude/metrics/costs.jsonl` | present but inert on this install — 1765 rows, all `model:"unknown"`, all-zero tokens |
| Transcript JSONL `rateLimits` field | exists **only** on `request_retry` error records, and is `null` in every one of them across the whole corpus (`grep -r '"rateLimits":{'` → 0 files). It is populated from a 429 response, not from normal traffic |
| `/api/oauth/usage` (string in the CLI binary) | almost certainly what `/usage` calls, but reaching it needs the OAuth token from `~/.credentials.json`. **Not used** — the harness must not read the Architect's credential store, and an undocumented endpoint is not a contract |

The statusline is the right seam because it is a **documented, supported
extension point** the harness already has an installer for: Ephesus already
writes `<cwd>/.claude/settings.local.json` for every spawn.

---

## 3. Where the spend actually goes (measured, not impressions)

Folded from the real Claude Code transcripts for the working directories the
registry names, counting exactly what `claudeUsageFact` counts
(`input + cache_creation + cache_read + output`). Artemis, 2026-09-01:

```
TOTAL 24.47M across 305 assistant turns / 39 wakes
  cache READ   21.21M  86.7%   <- re-reading context
  cache WRITE   2.95M  12.0%
  fresh in      0.001M  0.0%
  output        0.32M   1.3%
```

Per wake: median **485k**, p90 **1.82M**, max **2.67M**.
Wall-clock per wake: median **49 s**, p90 **137 s**, max **182 s**.

### Finding 1 — the cost is context re-read, not work done

Context size when a wake *starts* is a stable **65k–104k** (median 72k). It is
not unbounded growth. But each wake then makes **median 5, up to 30** API calls,
and every one of them re-reads that whole context:

> **91.4 % of the 24.47M (22.37M) is `ctx_at_wake_start × api_calls_in_wake`** —
> tokens spent re-reading context that already existed before the wake began.

The wake cost formula is therefore `≈ 70k × calls`. Output is 1.3 % of spend.
Any budget denominated in tokens is really measuring *how many times the agent
re-read its own context*, which is why raising the ceiling 50× changed nothing.

### Finding 2 — 39 % of the day was the harness waking the agent back up

Splitting the 39 wakes by what woke them:

| Trigger | Wakes | API calls | Tokens | Share | Mean/wake | Prompt size |
|---|---:|---:|---:|---:|---:|---:|
| inbox delivery (`wakeCheck`) | 19 | 175 | 13.53M | 55.3 % | 712k | 615 chars |
| **stop-hook re-wake (`decideOnStop`)** | **17** | **108** | **9.54M** | **39.0 %** | **561k** | 1006 chars |
| Architect / direct | 3 | 22 | 1.40M | 5.7 % | 467k | 133 chars |

A stop-hook re-wake carries **about a kilobyte** of new information and costs
**561k tokens** on average. In the trace they arrive in pairs — an inbox
delivery wake, then immediately a stop-hook wake announcing mail that arrived
while it ran. The wake, not the token, is the unit of spend.

**Conclusion that drives the design: pace the WAKE.** A limit that counts tokens
is measuring a quantity the agent does not control; a limit that counts wakes is
measuring the thing the harness itself issues.

---

## 4. What Changed

| File | Change |
|---|---|
| `docs/adr/ADR-0023-usage-aware-pacing.md` | **New.** Supersedes ADR-0011's budget clause and trip signal #4. |
| `src/shared/pacing.ts` | **New.** The usage-report schema and `paceFor()` — the pure decision that turns observed windows into `full` / `slow` / `hold`. |
| `shims/eph-usage.mjs` | **New.** Statusline shim: reads the engine's status JSON on stdin, writes the observed windows to `<home>/usage/<agent>.json` atomically, prints a short status back. |
| `src/main/watch/usage-watch.ts` | **New.** Reads and validates the per-agent reports, exposes the current windows and pace to main, reports staleness as a degradation. |
| `src/main/watch/wake-clock.ts` | **New.** The wall-clock cap per wake — the second, independent limit. |
| `src/main/engines/claude.ts` | Installs the `statusLine` block alongside the existing `hooks` block; `usageStatusDir`/`usageShimPath` deps; strip-then-merge so re-installs do not accumulate. |
| `src/main/hermes.ts` | `pace()` gate on both wake paths (`wakeCheck`, `decideOnStop`); deferral is visible and never consumes the inbox. |
| `src/shared/breaker.ts` | Trip signal #4 fires on `breached` only; `projected-breach` no longer trips (ADR-0023). |
| `src/main/index.ts` | Wires `UsageWatch` → `paceFor` → Hermes; wires `WakeClock` → `interrupt`; passes the shim paths to the Claude adapter. |
| `src/shared/config.ts` | `pacing` block: thresholds and the wall-clock cap, so none of it is a magic number in code. |
| `test/shared/pacing.test.ts` | **New.** The pure decision, on the shape the engine really sent. |
| `test/main/pacing-wakes.test.ts` | **New.** The production seam: both Hermes wake paths, UsageWatch, WakeClock. |
| `test/main/engines/claude-usage-statusline.test.ts` | **New.** The settings install and the shim, run as a real process. |
| `test/shared/breaker.test.ts` | Updated for the narrowed trip signal #4. |
| `docs/adr/README.md` | Index rows for ADR-0021/0022/0023 and the ADR-0011 clause note. |

---

## 5. Implementation Approach

Four pieces, in the order a signal travels through them.

### 5.1 Observation — `shims/eph-usage.mjs`

Claude Code runs the configured `statusLine` command on every status render,
handing it the session's status JSON on stdin. The Claude adapter now installs
such a command, pointing at our shim, into the **same
`.claude/settings.local.json` it already writes for hooks** — so the observation
point inherits the existing backup and uninstall path, and nothing new has to be
cleaned up on the way out.

The shim converts `resets_at` from epoch **seconds** to epoch **milliseconds**
once, at the boundary, and writes `<home>/usage/<agent>.json` with temp+rename
(invariant §4 — several agents' status lines write it while the harness reads
it). It is **fail-open and time-bounded**: it sits on the agent's critical path,
so every path exits 0, the stdin read gives up after 2 s, and trouble goes to
stderr only.

Two merge rules keep it honest, both mirroring the hook block's hard-won ones:
an Architect's own `statusLine` is **never** replaced (we simply do not observe,
and pacing runs on `unobserved`), and our own previous install **is**, so several
agents in one working directory do not accumulate copies.

### 5.2 Decision — `src/shared/pacing.ts`

Pure. Windows in, clock in, verdict out — the same discipline as
`shared/breaker.ts`, and for the same reason: a slowdown has to be explicable
from its inputs after the fact.

### 5.3 Enforcement — `src/main/hermes.ts`

The pace gates the **wake**, at the only two places this harness issues one.
Three properties matter, and each has a regression behind it:

- a deferred wake **never touches the mailbox**, so pacing is a delay and not a
  drop. `wakeCheck` checks the gate *after* the "is there new mail" test and
  *before* updating `nudged` — the other order would mark the mail announced and
  it would go unheard forever;
- `decideOnStop` defers by returning `null`, which lets the turn **end**. The
  agent goes idle with its mail still pending and `wakeCheck` collects it later;
- both paths call `noteWoken`, so they share one gap. Otherwise alternating
  between them would wake the company at twice the paced rate.

### 5.4 The independent limit — `src/main/watch/wake-clock.ts`

`prompt-submitted` opens a wake, `stop`/`session-end` closes it, and an overrun
is ended with the engine's cancel key. Deliberately *not* a breaker signal: a
wake that overran is a single event with a single correct answer, and ADR-0011's
own reasoning says time must not by itself climb a ladder toward `stop`.

---

## 6. Mathematical detail

**Elapsed fraction.** For a window of length `L` that resets at `R`, observed at
`t`:

```
elapsed = clamp01( (L - (R - t)) / L )
```

`R` comes from the engine; `L` is 5 h or 7 d according to which window it is.
Measuring each window against its own length matters: the same "two hours left"
means nearly-over for the 5-hour window and barely-started for the weekly one.
The clamp covers clock skew and an engine reporting a longer window than we
assumed — without it `elapsed` goes negative and the projection flips sign.

**The projection.** Linear extrapolation of the current burn to the reset:

```
projected% = used% / elapsed          (claimed only when elapsed >= 0.2)
```

`projected% > 100` means the window runs out before it refills. The `0.2` floor
is the same guard `evaluateBudget` already applies to its own projection: as
`elapsed → 0` the quotient diverges, so two minutes into five hours *any* usage
extrapolates absurdly and would slow a healthy company on its first tool call.
Under the floor the projection is `null` — "we do not know yet", never a guess.

**Combining windows.** Each window yields `full | slow | hold`; the company takes
the maximum on the order `full < slow < hold`. A window with `R <= t` is dropped
from the set entirely before that — and that single line is the whole of *"if the
weekly limit is reset it will march forward."*

**Why the wake is the right quantum.** From §3, a wake costs approximately

```
tokens ~= context_at_wake_start x api_calls_in_wake
```

with `context_at_wake_start` a stable 65–104k and output only 1.3 % of spend. The
harness cannot spend a fraction of an API call, and it does not choose how many
calls a wake takes — but it does choose **when to issue a wake**. The wake is the
only quantity in that equation the harness controls, so it is what the governor
acts on.

---

## 7. Design Decisions

**Why the statusline and not `/api/oauth/usage`.** The endpoint exists (§2), but
calling it requires the OAuth token in `~/.credentials.json`. A harness that
reads its Architect's credential store to check a quota has bought a small
convenience at a large trust cost, and an undocumented endpoint is not a
contract. The statusline is a supported extension point we already install into.

**Why a file and not the hook socket.** `eph-hook.mjs` posts to a local endpoint
whose event vocabulary is a shared, validated contract (`src/shared/hooks.ts`).
Adding a "usage" event would widen that contract for telemetry. A file is the
Ephesus idiom, survives a harness restart, and is inspectable: the Architect can
`cat ~/.ephesus/usage/*.json` and see the number the company is steering on.

**Why pacing is a governor, not an interlock.** No reading, a stale reading, and
an engine that reports nothing all yield `full`. A harness that froze the company
because a shim had not written a file yet is a harness that gets switched off —
and then it protects nothing, which is ADR-0011's own argument about false trips.
The runaway backstop (`breached`) covers the failure case.

**Why the per-agent ceiling survives at all.** It is the only thing that catches a
*single* agent running away while the account window is comfortable. It just
stops being the thing that governs normal operation.

**Why `hold` returns `Infinity` rather than a large number.** So that no caller
can do arithmetic on it and quietly turn a hold into a long slow.

**What was considered and not built.** Reducing the ~70k baseline context
directly — trimming the identity appendix, the memory layer, or `compileFacts` —
attacks the other factor in §6's equation. It is not in this change: it alters
what every agent knows about itself, which is a behavioural change needing its
own evidence, whereas spacing wakes changes only the harness's own cadence. §3's
numbers are the input for that work when it is scheduled.

---

## 8. Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
```

```bash
npx vitest run test/shared/pacing.test.ts test/main/pacing-wakes.test.ts test/main/engines/claude-usage-statusline.test.ts test/shared/breaker.test.ts
```

**Reproducing the usage-window capture** (§2, step 2). Spawn a real engine in a
pseudo-terminal — the way this harness spawns agents — with a `statusLine` that
saves what it is handed, answer the workspace-trust prompt, ask it anything, then
read the file. The `rate_limits` block is **absent on the first render and
present from the second**; that ordering is itself part of what §2 established.

**Reproducing the spend measurement** (§3). Fold the transcripts under
`~/.claude/projects/<slugged agent target>/`, counting
`input + cache_creation + cache_read + output` per assistant turn, and group turns
by the non-tool-result `user` message that started them. Note that three
skeleton-crew agents share one `target`, so a per-directory fold triple-counts
them — the Artemis figures in §3 are from her own directory alone, and they match
the ledger's reported 24.4M.

### Mutation checks

Every regression was verified by breaking the thing it guards, confirming red,
and reverting. All fifteen went red:

| Mutation | Result |
|---|---|
| slow threshold ignored | RED |
| a reset window still exerts pressure | RED |
| projection floor removed | RED |
| staleness ignored | RED |
| hold treated as slow | RED |
| `wakeCheck` gate removed | RED |
| `decideOnStop` gate removed | RED |
| stop-hook block not counted as a wake | RED |
| `projected-breach` trips again | RED |
| wake clock never interrupts | RED |
| `began` does not clear the previous timer | RED |
| `resets_at` left in seconds | RED |
| statusLine overwrites the Architect's own | RED |
| unusable file reported every tick | RED |
| a NEW fault not reported | RED |

The fourteenth was **GREEN on the first attempt**, and is recorded because it
found a real hole rather than a cosmetic one: the test's dedup was being done by
`UsageWatch`'s unchanged-bytes shortcut, not by the same-detail guard it claimed
to be testing. The test now rewrites the file with different bytes and the same
fault — which is what a shim writing garbage on a moving timestamp actually does.

### Suite state

**The full suite is unstable in a fresh worktree on this machine**, and the
instability is not small. Three full runs in one session:

| Run | Failures |
|---|---|
| base (`dd448a1`, clean checkout) | 41 |
| with this change | 32 |
| with this change, again | 56 |

The failures move between runs and cluster in the scenarios that drive **real git
in temp directories** (`agora`, `hermes`, `s-breaker`, `worktrees`, `s-crash`).
In the 56-failure run most carried `STACK_TRACE_ERROR` with no assertion message
— teardown timeouts, not assertion failures — and four of the new tests in
`pacing-wakes.test.ts` were swept up in the same cascade. Run on their own, the
three new files pass 47/47, three times out of three.

**Comparing the two sets rather than the counts** is what isolates this change.
Set-differencing the 32-failure run against the base run leaves five tests
failing here that passed there. Four of them (`agora.test.ts`,
`agora-ipc.test.ts`, `s-profile.test.ts` x2) pass in isolation and appear on
*both* sides of the diff in different combinations across runs. The fifth,
`breaker.test.ts :: burn rate ... fires on projected-breach`, is the intended
behaviour change; its test was rewritten to assert the new rule.

Separately, `test/shared/cost.test.ts :: splits one transcript across the days it
spans` fails on the base commit and is **not** from this change.

`test/renderer/emotes.test.ts` cannot typecheck in a fresh worktree because
`src/renderer/src/assets/tileset/*` is gitignored and generated locally; the
asset was copied in from the main checkout so the gate would be representative.

**This is a real gap in the evidence, and it is not closed here.** A suite whose
failure count swings 32–56 across identical inputs cannot prove the absence of a
regression; it can only fail to find one. The targeted evidence — the mutation
table above, the three new files run in isolation, and the set difference — is
what this change actually rests on.

---

## 9. What this does NOT do

- **No dollar figures.** — *closed on this branch by*
  [2026-09-01-cost-usd-into-the-ledger.md](2026-09-01-cost-usd-into-the-ledger.md),
  which wires the engine's own per-model figures into ADR-0011's `cost_usd`
  column. It uses the transcript's `cost-state` line rather than the statusline
  payload noted here: it is per-model, which is what the ledger is keyed on, and
  it arrives through a reader that already exists.
- **No reduction of the ~70k baseline context** — see §7.
- **No UI surface.** Pace changes, deferrals and wake overruns are log events and
  runtime-health degradations, which is how the Architect sees them today; no
  agent card or panel was added.
- **Non-Claude engines are unpaced.** Codex and Gemini install no statusline, so
  a company running them observes nothing and paces at `full`.
- **Nothing was run against the live company.** The evidence here is a captured
  statusline render, the folded transcripts of a real day, and the test suite.

---

## 10. Related Docs

- [ADR-0023 — Pace the company against the account's usage window](../adr/ADR-0023-usage-aware-pacing.md)
- [ADR-0011 — The Watch: circuit-breaker ladder and a durable cost ledger](../adr/ADR-0011-watch-breaker-budgets.md)
- [ADR-0013 — Autonomy loop via the engine's Stop hook](../adr/ADR-0013-stop-hook-autonomy.md)
- [ADR-0009 — Engine adapters](../adr/ADR-0009-engine-adapters.md)
- [docs/ENGINEERING-STANDARDS.md](../ENGINEERING-STANDARDS.md)
- [docs/TEST-STRATEGY.md](../TEST-STRATEGY.md)
