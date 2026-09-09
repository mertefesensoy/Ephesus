# M8c goal prompt — bounded, honest, and able to be left alone

Paste the block below as the argument to `/goal`. It is written to be pasted whole;
every clause in it exists because something in the 2026-09-09 exit run or the M8b
rehearsal went wrong without it.

**Keep this file updated as M8c progresses — it is the handover, and a stale handover
is worse than none.** `docs/M8b-GOAL.md` was written and never committed, and the
session that needed it could not find it.

The Architect settled five questions on 2026-09-09 before this was written. They are
stated as settled inside the prompt so the next session does not re-litigate them: all
ten packages in scope, one PR per package, merge each on green, tests + mutation + an
adversarial refutation pass, and the mutation harness must carry a control.

---

Build milestone **M8c** of Ephesus — *"Bounded, and honest about itself"*, plus the two
packages added on 2026-09-09 that are neither: **a company that can be left alone at
all.** All ten packages, M8c.1 through M8c.10. They are defined with acceptance
criteria in `docs/IMPLEMENTATION.md`; do not restate them, work from them.

**FIRST, follow `BUILD-PROMPT.md` §2's reading protocol in full.** Do not skip it and
do not substitute `docs/PROGRESS.md` for it. §2 is the router to the normative sources
— the SRS for *what*, the SDD for *how*, and the governing ADR — with the precedence
rule (SDD > ADR > SRS > README for how; SRS > SDD for what). ADRs are append-only:
never edit an accepted one, supersede it.

**Then read both execution records, in this order:**

1. `docs/demo/m8-onehour-aftershock.md` — the exit run that produced M8b and M8c.
   **Read Finding 13's correction block before Finding 13**; the finding below it is
   wrong on its central claim and left standing on purpose.
2. `docs/demo/m8b-rehearsal-m8b-rehearsal.md` — the M8b rehearsal, 2026-09-09. It is
   where M8c.9 and M8c.10 come from, and it is the only record of what the company
   does when the crew can actually act.

Every package cites a Finding in one of those two. The records name the exact log rows,
seq numbers and quoted agent reports behind each one — you should not have to re-derive
any of it, and if you find yourself doing so, read the record again before reading
`src/`.

## Why this milestone exists, in one paragraph

M8b made the crew able to act, and the rehearsal proved it: five of six incidents
triaged where the exit run had none of eighteen, three pull requests from the crew all
merged with `main` green, a meeting that adjourned itself in ninety-one seconds. Then
it found what nobody could see while the crew was stalled at a missing file. **After
the restart the crew could not be brought back at all** — activate refuses because the
worktrees exist, deactivate refuses because the agents do not — and **four of the five
agents ended the hour parked at their engine's own permission prompt**, which nobody
may answer and `ephctl` cannot. The run also cost $17.77 unbudgeted, because the
ceiling is still unreachable from the surface the run is driven from. M8c is the
distance between a company that works when watched and one that can be left alone.

## The order to build them in, and why

**M8c.10 first, and it is one sentence.** `EXIT-M8.md` §3 tells the runner to commit
the break as *"test: break one assertion for the M8 exit run"*, and a competent on-call
agent reads that, correctly concludes the break is deliberate, and declines to open a
fix PR. **Until that sentence changes, no exit run can pass clause 2 honestly** — so
every verification you do afterwards is measured against a script that cannot measure
the thing. Do it first because it is cheap and because it makes everything after it
mean something.

**M8c.9 second.** It is the highest-severity item in the milestone: a real run stops at
§4 and does not restart. Its first half is not code — it is finding out **which of two
observations is stale**, because the exit run recorded reactivation taking over a down
instance per ADR-0027 and the rehearsal recorded it refusing. One of those is about a
path that no longer works. Settle that before you design a fix.

**M8c.8 third.** It is an ADR, and the design question is the deliverable. Do it before
the cost packages, because what you decide about engine prompts changes how long a run
lasts, and every cost number M8c.1–3 tune is measured over that window.

**Then M8c.1, M8c.2 and M8c.3 together** — they compound and the record says so.
M8c.3's acceptance is a policy call that only makes sense once .1 gives a ceiling a
surface and .2 stops charging for history.

**Then M8c.4, M8c.5, M8c.6, M8c.7** — the honesty half, and the one M8c was originally
named for. M8c.6 also removes the §5.1 trap that has now caught two runners.

## ASK THE ARCHITECT — in series, not in a batch

Use the `AskUserQuestion` workflow, one round at a time, using each answer to shape the
next question. Do not batch every open question into a single call at the start, and do
not proceed on a guess where a design choice is genuinely open. **Five are already
known to be open**, and there will be more:

- **M8c.9** — is the fix to *reuse* an existing worktree, or to *remove and recreate*
  it? Different failure modes: reuse inherits whatever the previous agent left in the
  working tree (the rehearsal found a half-finished `agent/mason/fix-…` branch);
  recreate destroys work in progress that a restart interrupted. Ask before building.
- **M8c.8** — pre-authorise engine permissions in the spawn plan, or escalate them as
  real Ephesus gates the Architect can clear? This is the ADR's whole content, and it
  is a trust decision, not a mechanical one.
- **M8c.1** — a real `budget:set` verb, or a refusal in `ephctl help` that names where
  to set one? The acceptance offers either, and `watch:approve` is the standard to
  beat. Ask which.
- **M8c.2** — raise incidents only for runs newer than the activation, or suppress a
  failure a later success on the same branch has superseded? The record argues both
  are defensible and they behave differently on a repository that is red at
  activation. Ask.
- **M8c.3** — a default ceiling, or a first-run confirmation naming projected spend?
  The record calls this *"the Architect's call on policy, not a mechanical fix"*.

Anything that reaches a `BUILD-PROMPT` §8 must-ask, or that would change behaviour an
accepted ADR governs, is an Architect question too — not a judgement call.

## The verification bar — the Architect set this explicitly

Tests at the seam, then mutation, then an adversarial refutation pass before you call a
package done. Not one of the three is optional, and **the third is the one that keeps
paying**: on M8b it found three defects that survived every test and every mutant —
an installed file the engine had no permission to read, a prompt that steered agents
past the mechanism built for them, and a refusal that never said the work was still
owed.

**Your mutation harness must carry a control, and here is why.** M8b discarded *three*
rounds that reported near-perfect scores they had not earned, and the only thing that
caught each one was a planted no-op mutant coming back "killed". The requirements, all
of which were needed:

- plant a **no-op control** and treat its survival as the round's certificate;
- run the suite once **before the first mutant** and abort unless it is green — a red
  baseline makes every mutant look killed;
- treat *"the suite refused to start"* as INVALID, not as a kill — `requireHeadroom`
  exits non-zero under 1 GB free without running a test;
- hash every file **before and after** each mutant, which catches an insert, a delete
  **and** an edit;
- read and write with no newline translation, or a restore is not byte-exact;
- **commit the package before the round**, so `git status` is a second check and
  `git checkout --` is the restore;
- report **which test files the round ran** — M8b.3 killed 6 of 6 and the full suite
  then failed two scenarios the round never loaded.

The full account is in `docs/DECISIONS-LOG.md`, 2026-09-09. Rebuilding that harness
each milestone is friction worth a `/improve` proposal rather than a private script —
file one if you agree, do not just build it.

M8's standing instruction still governs: *"our goal is not the plan for the smallest
but the most reliable and testable fix."*

**Definition of Done, green before every commit:**

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs
```

## Landing the work

**One PR per package — ten PRs.** The Architect chose the strict convention
deliberately, and M8b bore it out: M8c.9 is the one you would most want isolated if it
regresses.

- Branch per package: `fix/<topic>`, one work package each.
- Merge each PR once its three required checks are green, then move to the next. Do not
  queue ten PRs behind the Architect.
- Every PR carries evidence — the mutation result **with its control**, and what the
  adversarial pass tried and failed to break. Not just "tests pass".
- Commits: Conventional Commits, subject ≤ 72 chars, Architect sole authorship, and no
  agent/session/model name anywhere in the tree — not in trailers and **not in prose**.
  `check-attribution.cjs` does not catch prose.
- Each package owes a `docs/implementations/YYYY-MM-DD-<slug>.md`.

## How you verify M8c, and the limit on what that proves

When all ten have merged, re-run `docs/EXIT-M8.md` end to end and write the result to
`docs/demo/m8c-rehearsal-<repo>.md`.

**Label it a REHEARSAL in its first line, and do not tick anything.** You will have
written the fix, so you are the author, and `EXIT-M8.md` §0 is explicit that an
author's run is *"useful, and not the exit"*. Say so plainly at the end, and say which
clauses moved.

**The bar for M8c being done:** the run completes inside a **stated** ceiling; no
incident is raised for a run older than the activation; `DIAGNOSIS.md` reports no area
as `WORKING` on an entry row; a restarted company brings its crew back with no manual
filesystem step; and **the hour ends because the work ended, not because an agent met a
prompt.**

M7 and M8 still close only on a later run by a session that has never seen the code.
That run is owed and M8c does not discharge it.

## What the rehearsal learned about running one of these

Do not rediscover any of this.

- **A scratch repository is the right target.** 13-second CI against `aftershock`'s
  11–20 minutes, and one stale incident replayed instead of eight. `mertefesensoy/m8b-rehearsal`
  still exists and is public — reuse or replace it, but check its CI history first,
  because whatever failures are in it will be replayed as incidents until M8c.2 lands.
- **Private repositories cannot run Actions on this account.** The first attempt failed
  with *"recent account payments have failed or your spending limit needs to be
  increased"*, and the job never started. Public repositories get free minutes.
- **A crew that can act costs more than one that cannot.** The rehearsal spent $17.77
  against a $3–8 estimate and against $11.22 for the whole exit run. Tell the Architect
  what a run is likely to cost and let them decide **before** starting it, and expect
  M8c.1–3 to be what finally bounds it.
- **`%USERPROFILE%\ephrun2` holds the rehearsal's home.** A fresh `EPH_HOME` is
  required for any run; a used home inherits its crew and book of record. Keep the path
  short — a deep path breaks Agora git commits on Windows with *Filename too long*.
- **Stop the harness by process, never by killing `npm run dev`** — that leaves
  Electron alive.
- `gh` and `claude auth status` must both be authenticated, or the crew hires fine and
  ingests nothing.
- Node must be 20.19+ or 22.12+. This machine has **20.16.0** and it worked twice, with
  22 `EBADENGINE` warnings. It is a near miss, and M8c.6 owns the documentation half.

## Two traps this run will hit, both known and both now IN scope

1. **`EXIT-M8.md` §5.1 will tell you to abort a valid run.** `profile:activate` reports
   `armed dependency-sweep, health-sweep` and never lists the `ci` trigger, because
   `armed` can only show `kind:"schedule"` triggers. §5.1 says a missing `ci` trigger
   means *"the run cannot proceed past it"*. It is bound — check
   `profiles/skeleton-crew/triggers/ci-failure.json` and keep going. **Unlike M8b, this
   is now yours to fix: it is M8c.6.**
2. **After the §4 restart the crew will not come back.** That is M8c.9, and until you
   fix it your own rehearsal will stall exactly where the last one did. The manual
   escape is `git worktree remove --force` on each of the four agent worktrees, then
   `git worktree prune` — record it as a deviation if you use it.

## What NOT to do

- **Do not widen into M7b.** Ten packages is the job.
- **Do not tick anything in `docs/PROGRESS.md`.** M8's exit row is the Architect's, on
  a non-author's run.
- **Do not shorten a cadence, raise an autonomy ceiling, or loosen gate policy** to
  make a rehearsal clause land. That is changing the product to pass its own test.
- **Do not edit an accepted ADR.** M8c.8's answer deserves a new one; ADR-0021,
  ADR-0027, ADR-0029 and ADR-0033 stay as they are.
- **Do not weaken `requireHeadroom` or a coverage floor** to get a run to complete. If
  the machine cannot run the suite, that is a fact to report, not a gate to lower.

## Where the evidence lives

| What | Where |
|---|---|
| The exit run this milestone comes from | `./demo/m8-onehour-aftershock.md` |
| The M8b rehearsal, and M8c.9/M8c.10's evidence | `./demo/m8b-rehearsal-m8b-rehearsal.md` |
| The ten packages and their acceptance criteria | `./IMPLEMENTATION.md` — M8c |
| What M8b actually changed, package by package | `./implementations/2026-09-09-m8b-*.md` |
| The run script to rehearse against | `./EXIT-M8.md` |
| The criterion itself | `./srs/SRS.md` §6.1, with its three 2026-09-08 amendments |
| Why a fresh session counts as a non-author | `./DECISIONS-LOG.md`, 2026-09-08 |
| What three discarded mutation rounds taught | `./DECISIONS-LOG.md`, 2026-09-09 |

## The Architect's decisions, recorded here so they are not re-asked

| Question | Answer |
|---|---|
| Scope | All ten M8c packages. |
| PR shape | One PR per package, ten in total, per the standing convention. |
| Merge authority | Merge each once CI is green, rather than queueing ten for review. |
| Verification bar | Tests + mutation + an adversarial refutation pass. All three. |
| Mutation harness | Must carry a no-op control and a proven-green baseline. A round without one is not evidence. |
| Who re-runs the exit | The builder, as a rehearsal. It cannot close M7 or M8; a fresh run is still owed. |
