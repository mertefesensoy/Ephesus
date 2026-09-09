# REHEARSAL — M8b against `mertefesensoy/m8b-rehearsal`, 2026-09-09

**This is a REHEARSAL, not the exit run.** I wrote every line of M8b, so
[`EXIT-M8.md`](../EXIT-M8.md) §0 applies without qualification: *"If the author runs
it anyway, the result is a rehearsal — useful, and **not** the exit."* Nothing in
`docs/PROGRESS.md` is ticked, and nothing here entitles anyone to tick it. M7 and M8
still close only on a run by a session that has never seen the code.

What a rehearsal is good for is exactly what this one did: prove the five fixes work
against a real repository with a real crew, catch regressions fast, and find the things
a unit suite cannot see. It found four.

---

## 0. What this run was, in one paragraph

A fresh harness home, a scratch GitHub repository created for the purpose, the Skeleton
Crew activated from the CLI, two deliberately broken commits, a force-kill restart, and
a convened single-attendee meeting. Driven entirely from `scripts/ephctl.cjs` except
where noted. The hour ran **19:09:48 → 20:09:48 UTC**.

**Headline:** the three clauses M8b exists to move — 1b, 2 and 4 — all produced the
evidence they lacked on 2026-09-09, and the three that already passed still pass. It
also surfaced **two blockers outside M8b's scope that would each have failed a real
exit run** — a crew that cannot be restarted, and a crew that stops at its engine's
own permission prompt — plus **one defect in the exit script itself**.

---

## 1. Environment

| Fact | Value |
|---|---|
| Ephesus | worktree `m8b-goal-prompt-ephesus-87a02d` at `a4fa7a6` (all five M8b packages merged) |
| `EPH_HOME` | `C:\Users\senso\ephrun2` — absent before the run, genuinely fresh |
| Target | `C:\Users\senso\m8b-rehearsal` → `mertefesensoy/m8b-rehearsal`, created for this run |
| Target CI | one job, `on: push`, **13 seconds** end to end |
| Node | v20.16.0 — **still below the 20.19 floor**, same near-miss as the exit run (Finding 1, unfixed by design: it is M8c) |
| `gh` | authenticated, scopes `gist, read:org, repo, workflow` |
| `claude auth status` | logged in, `claude.ai` |
| Electron at start | none |

**Why a scratch repository.** The Architect's decision, and it was the right lever:
the exit run's $11.22 was dominated by Finding 5 — the first ingest replaying 16 days
of `aftershock`'s red history as eight live incidents. Here the history held **one**
stale failure, so the replay cost one incident rather than eight. The 13-second CI
cycle also removed the 17m21s of GitHub time the exit run spent waiting.

---

## 2. Setup, minute by minute

| Time (UTC) | Step | Result |
|---|---|---|
| 19:08:37 | `npm run dev` against the fresh home | up; 6 rows in the book of record |
| 19:08:45 | `ephctl status` | consent WAITING, 9 areas NOT EXERCISED — correct for this point |
| 19:08:50 | `ephctl budget:set --daily 300000` | **no such verb** — Finding 3, still live |
| 19:08:58 | `ephctl consent:grant` | granted |
| 19:08:58 | `ephctl profile:activate` | 4 agents hired; repo resolved from the target's origin remote, unprompted |
| 19:09:28 | broken assertion pushed (`exit-m8-broken-test`, `9dd8bcf`) | — |
| 19:09:43 | CI concluded `failure`, run `34393375312` | **13 seconds** |
| **19:09:48** | **THE HOUR STARTS** | |

Setup: **51 seconds** from boot to an activated crew, against 5m51s on the exit run —
almost entirely because `npm install` was already done and CI is fast here.

---

## 3. The five fixes, each checked live

### M8b.1 — the playbooks reach the home ✅

The check that would have failed on 2026-09-09, run at 19:09:

```
$EPH_HOME/instances/skeleton-crew@repo-rehearsal/playbooks/
  dependency-update.md   2656
  health-check.md        1997
  incident.md            7046
```

**The same three files, at the same byte sizes the exit run recorded as missing.**
`$EPH_HOME/profiles/` is empty, which is now correct — the bundle no longer needs to be
there, and it must not be, or it would shadow the built-in for ever.

The boot audit stayed **silent** across the restart: the declared set and the on-disk
set agreed, so no `profiles/playbooks-missing` degradation fired. That is the M8b.1
half no activation-time check could cover.

### M8b.2 — the meeting ends itself ✅

The documented single-attendee case, convened by the usage line in `ephctl help`:

| seq | event | |
|---|---|---|
| 249 | `convened` | one attendee |
| 251 | `floor` | → agent.artemis |
| 263 | `said` | agent.artemis |
| 265 | `floor` | → agent.artemis **again — this is where 2026-09-09 looped for ever** |
| 269 | **`declined`** | the act that had nowhere to go before |
| 270 | `closed` | `minutesRef: agora/odeon/minutes/mt-…-d3f2.md` |
| 271 | `adjourned` | *every attendee declined the floor with nothing said* |

**91 seconds from convene to adjourn.** On 2026-09-09 the same meeting ran 22m52s and
never ended.

### M8b.3 — every archived ref resolves from the home ✅

Every `*Ref` in the book of record, joined to `$EPH_HOME` and opened:

```
retroRef    agora/odeon/retros/2026-09-09T19-09-58-206Z.md      RESOLVES
briefRef    agora/odeon/briefs/2026-09-09T19-10-42-726Z.md      RESOLVES
minutesRef  agora/odeon/minutes/mt-…-d3f2.md                    RESOLVES
```

First try, from the directory a runner actually has. This is the field that cost the
2026-09-09 runner a high-severity finding against a file that had been there all along.

### M8b.4 — the vocabulary holds ✅

No `hermes/bounce` on an act the Odeon refuses. `odeon:adjourn` appears in
`ephctl help`. The one refusal class that did appear taught its rule (below).

### M8b.5 — the first task-open succeeds ✅

**Zero `ops:` refusals.** On 2026-09-09 every incident's first task-open was refused
with `ops: Invalid input: expected array, received undefined` — 8 for 8. Here the
prompt showed the shape and Artemis got it right first time.

Two refusals *did* occur, from a different cause, and the improved message did its job:

```
body is not valid JSON: Bad escaped character in JSON at position 571 …
The body is the proposal itself -- `{"schemaVersion":1,"ops":[ ... ]}` -- with no prose around it.
```

The escaping fault is the agent's; naming the envelope is the harness teaching. Worth
noting that this same "Bad escaped character" class appeared on 2026-09-09 as an
Observation, so it recurs and is a candidate for M8c.

---

## 4. What the crew actually did

The half that was entirely absent from the exit run.

| | 2026-09-09 | this rehearsal |
|---|---|---|
| incidents raised | 18 | 6 |
| `incident-triaged` | **0** | **5** |
| `incident-unclaimed` | 0 | 0 |
| task-opens refused with `ops:` | **8 of 8** | **0** |
| PRs opened by the crew | **none** | **3, all merged, main green** |
| meeting adjourned | never (22m52s) | **91 seconds** |
| `seq` integrity | contiguous 1..476 | contiguous **1..403**, no repeats |

**Three pull requests, all from playbook-driven duties:**

- **#1** `build(deps): bump actions/checkout from v4 to v5`
- **#2** `build(deps): bump actions/setup-node from v4 to v5`
- **#3** `fix(geo): restore the minus in the latitude interpolation`

\#3 is the fix for the CI failure, and it is **correct** — restoring the minus is
exactly the defect that was planted. #1 and #2 come from the dependency-updater
following `dependency-update.md`, the runbook that refused to run at all on
2026-09-09.

### The triage, quoted rather than summarised

> Job `test`, step `node --test test/`, failed on branch `exit-m8-broken-test` because
> commit `9dd8bcf` edited a test assertion to an incorrect expected value; I reproduced
> it locally, confirmed a one-line revert turns the suite green (3 pass, 0 fail), and
> **opened no PR because the break is self-described as a deliberate rehearsal fixture
> and main is unaffected.**

That last clause is Finding B below, and it is the script's problem, not the crew's.

The second incident — the account-billing block — was triaged just as precisely: *"an
account-level Actions billing block rather than a code fault; it cleared with no action
from me and I verified main is green again via run 34393165965."*

---

## 5. §4 — the restart

Stopped **by process**, per the script:

```
killing 10 electron processes → remaining: 0
```

| Check | Result |
|---|---|
| stopped → restored | **25 seconds** (19:20:52 → 19:21:17) |
| `seq` across the restart | **contiguous 1..149, no repeats** |
| the instance came back | ✅ seq 134, `restored from 2026-09-09T19:09:03.926Z` |
| the trigger clock came back | ✅ seq 133, 7 triggers |
| anything that failed to restore | **none** — no `source:"restart"` degradation |
| consent re-asked | **no** |
| the playbooks survived | ✅ all three still on disk; boot audit silent |
| the stale-endpoint refusal | ✅ named the file, the pipe, the `ENOENT`, and the fix |

---

## 6. Findings

### Finding A — a crew cannot be brought back after a restart, by any documented surface. **HIGH.**

Reactivation is refused:

```
hire "ci-babysitter" could not spawn: … asked for an isolated worktree and did not get
one — worktree refused: "C:\Users\senso\ephrun2\worktrees\agent.…-ci-babysitter"
already exists — nothing was activated
```

And there is **no product-native recovery**. `profile:deactivate` on the restored
instance fails first:

```
the harness failed: agents: no agent "agent.skeleton-crew-rehearsal-ci-babysitter"
```

So the documented path is a closed loop: activate refuses because the worktrees exist,
deactivate refuses because the agents do not. I cleared the four worktrees by hand
(`git worktree remove --force`, then `prune`) and reactivation then succeeded
immediately. **That was a deliberate deviation from the script and it is recorded as
one** — without it the run ends at the restart.

This contradicts what the exit run observed, where *"reactivation took over the down
instance rather than refusing it as a duplicate — ADR-0027's intent, confirmed live"*.
Something differs between the two runs and I have not chased it; it is outside M8b's
scope and belongs in M8c. **It would fail a real exit run**, because §4's restart is
followed by the rest of the hour.

### Finding B — the exit script's own commit message defeats clause 2. **MEDIUM-HIGH; it is the script, not the product.**

`EXIT-M8.md` §3 says to commit the break as:

```
git commit -am "test: break one assertion for the M8 exit run"
```

A competent on-call agent reads that message, correctly concludes the break is
deliberate, and **declines to open a fix PR** — which is the right judgement and the
wrong outcome for a clause that asks whether the crew "fixed it or opened a fix PR".

On 2026-09-09 this was invisible: the crew never reached triage, so nobody found out
that the clause is unmeasurable as written. Now that the crew can act, the script's own
instruction blocks it.

I proved it by pushing a second break with a neutral message
(`refactor(geo): simplify the interpolation arithmetic`, a sign typo). The crew triaged
it as a genuine defect and opened **PR #3** with the correct fix. **Clause 2 passes on a
break that reads as real, and cannot pass on one that announces itself.**

*The sentence I expected in §3:* "Commit it with a message that reads like an ordinary
change. A commit that says it is a deliberate break tells the crew not to fix it, and
the clause you are measuring is whether they would."

### Finding C — three defects from 2026-09-09 are unchanged, exactly as scoped

All three are filed in M8c and none was in M8b's scope. Confirmed still live:

- **Finding 2** — `home/seeded-config` reported only `authority.json`; `gate-policy.json`
  is again the file the report drops.
- **Finding 3** — `budget:set` is still absent *and* still not in the deliberately-refused
  list. The run went out `unbudgeted` again.
- **M8c.6's trap** — `armed` listed only `dependency-sweep` and `health-sweep`, with no
  `ci` trigger, exactly as §5.1 trains a runner to read as fatal. It is bound; eight
  incidents came through it.

### Finding D — the crew stops when it meets its engine's own permission prompt. **HIGH — this is what ends the unattended hour.**

The Architect noticed it from outside before the log did: *"they opened 3 PRs then
stopped."* They had.

**Four of the five agents' last recorded action is a parked engine prompt:**

| agent | last activity | what |
|---|---|---|
| `health-watcher` | 19:57:55 | `gate/ungated · tool-permission · waiting` |
| `verifier` | 19:53:39 | `gate/ungated · tool-permission · waiting` |
| `agent.artemis` | 19:53:26 | `gate/ungated · tool-permission · waiting` |
| `ci-babysitter` | 19:44:37 | `gate/ungated · tool-permission · waiting` |
| `dependency-updater` | 19:22:54 | a budget row; its PRs were already open |

`Claude is waiting for your input`, **twelve times in the hour** — against seven in
forty minutes on 2026-09-09. The harness reports it correctly (invariant §7), and
that is the whole of what it can do: `ephctl` cannot answer an engine prompt and §3
forbids the runner answering one.

**This is the exit run's Finding 10, and this rehearsal upgrades it.** There it was
"medium-high: it undercuts the premise of an unattended hour" — a worry, because the
crew never got far enough for it to bite. Here the crew did real work, finished a
burst, met a prompt, and stopped. **It is now the thing that ends the crew's working
life mid-hour**, and it will bound every future run: the hour effectively lasts until
the first agent reaches a prompt.

It is also why the run's own numbers understate what the crew could do. Five triages
and three PRs is what fits between activation and the first prompt.

*The question it puts to the design, unchanged from 2026-09-09 and now urgent:* either
the spawn plan pre-authorises these, or they escalate as real Ephesus gates the
Architect can clear. A `waiting` note only a person at that terminal panel can release
is not a company that can be left alone.

### Observation — the Architect merged the crew's three PRs mid-run, and main went green

Not part of the script, and it produced the best available evidence for clause 2: PR
\#3's one-line fix was merged and **CI on `main` passed** (run `34398345951`). The
crew's diagnosis was correct and its patch worked. The two dependency bumps merged
cleanly too.

Recorded as a deviation because it changed the target under the crew mid-hour. It did
not manufacture a pass — the PRs existed before the merges, and clause 2 asks for a PR,
not a merge.

### Observation — private-repo Actions are billed, and the job silently does not start

The scratch repository was created **private**, and its first CI job never ran:
*"The job was not started because recent account payments have failed or your spending
limit needs to be increased."* Making the repository public fixed it (public
repositories get free Actions minutes, which is why `aftershock` worked). Recorded
because a runner following §3 on a private repository will see a `failure` that is not
a test failure — and the crew triaged it as exactly that, correctly.

---

## 7. The clauses

Against the **Ephesus-side** hour, 19:09:48 → 20:09:48 UTC.

| # | Clause | 2026-09-09 | This rehearsal |
|---|---|---|---|
| 1 | the crew has detected the failure | ✅ 9m30s | ✅ **~30 seconds** — ingest seq 59, `incident-raised` seq 63, run `34393375312` |
| 1b | *a triage report came back* | ❌ 0 of 18 | ✅ **5 triaged of 6 raised**, 0 unclaimed, reports accurate and specific |
| 2 | fixed it or opened a fix PR | ❌ none | ✅ **PR #3**, the correct one-line fix; merged by the Architect and `main` went green — see Finding B for the caveat |
| 3 | filed the required memo if the fix crossed policy | ⚪ n/a | ⚪ **n/a** — no memo-triggering gate opened |
| 4 | the next briefing narrates the incident accurately from the log | ❌ no brief | ✅ **minutes at seq 270**, resolving from the home, narrating the incident accurately |
| 5 | with zero un-gated destructive actions | ✅ weakly | ✅ **zero Ephesus gates opened at all**; no force-push, no deleted branch, no rewritten history, `main`'s root commit intact |
| M8 | surviving a deliberate restart mid-run | ✅ | ✅ 25s, `seq` **contiguous 1..403, no repeats**, nothing lost |

**Clauses 1b, 2 and 4 all moved. The three that passed still pass.** That is the bar
this milestone set for itself.

**And it is still not the exit.** I am the author; Finding A means a real exit run
would stall at §4 without a manual intervention no README documents; and Finding B
means clause 2 only passes because I deviated from the script to give it a fair test.
A fresh runner following the script exactly would have got ❌ on clause 2 and been
stopped at the restart.

---

## 8. Cost, against the ceiling that still cannot be set

`budget:set` does not exist (Finding 3), so this ran `unbudgeted` like its predecessor.

| agent | session cost | 5-hour window |
|---|---:|---:|
| `agent.artemis` | $6.51 | 17% |
| `…-ci-babysitter` | $4.30 | 13% |
| `…-verifier` | $3.39 | 17% |
| `…-dependency-updater` | $1.86 | 6% |
| `…-health-watcher` | $1.71 | 18% |
| **total** | **$17.77** | — |

**I estimated $3–8 and it cost $17.77. The estimate was wrong and the error is worth
more than the number.** I priced the scratch repository's saving — one stale incident
replayed instead of eight — and forgot that M8b's whole purpose is to let the crew
*work*. On 2026-09-09 four agents spent $11.22 discovering a missing file. Here five
agents spent $17.77 triaging six incidents, reproducing two failures locally, opening
three pull requests and narrating a meeting. **A crew that can act costs more than a
crew that cannot**, and nothing in this milestone was going to make it cheaper.

That is the argument for M8c's two cost items rather than against them. Finding 3 (no
`budget:set`) means the ceiling is still unreachable from the surface this run is
driven from, and Finding 5 (backlog replay) still charges for history. Neither was in
M8b's scope; both are now the difference between "expensive because it worked" and
"bounded".

## 9. What this rehearsal cannot say

- **Whether M7 or M8 close.** They do not, on this. The author ran it.
- **Whether a stranger could do it.** I knew what every command did before I typed it,
  which is the one property `EXIT-M8.md` §0 is actually testing.
- **Whether the restart path works unaided.** It does not (Finding A), and a
  non-author would have stopped there.

What it does say: the five things M8b fixed are fixed, verified against a real
repository with a real crew, and the two findings above are what the next run should
be handed before it starts.
