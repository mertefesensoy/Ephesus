# Ephesus — Implementation Plan

**Status:** approved build order. Milestones are cumulative; each has hard exit
criteria (demos + suites from [TEST-STRATEGY](./TEST-STRATEGY.md)). Durations assume
the Architect plus agent labor; they are sequencing estimates, not promises.

---

## 0. Build principles

1. **Mechanism before intelligence.** Hermes, the Agora, gates, and the fake-engine
   test rig come before any real LLM is in the loop — every coordination behavior is
   testable deterministically first (TEST-STRATEGY §1).
2. **The reference engine is Claude Code**; no second engine until M4.
3. **Vertical slices.** Every milestone ends with something the Architect actually
   uses that week.
4. **Docs move with code.** A milestone isn't done if the SDD lies about the code.
5. **The Gymnasium runs from day one** (ADR-0015, FR-12.6). During the build phase the
   self-improvement loop lives in the repository: friction observed while building
   becomes `/improve` proposals in `docs/gymnasium/`, gated by the Architect, measured,
   and ledgered. The build process itself is the first thing the company improves.

## M0 — Skeleton (≈ 1 week)

Scaffold: electron-vite + React + TS three-project setup, typed preload bridge, CI
(typecheck/lint/unit), ENGINEERING-STANDARDS lint boundaries active from day one.
PtyManager spawns one hardcoded shell in a PTY → xterm.js panel. Pixi floor renders
one terrace room and one avatar walking between two points. SQLite app-state store.

**Exit:** `npm run dev` shows floor + live terminal; CI green; S-suite harness
skeleton runs one trivial test.

## M1 — One real agent, both planes (≈ 2 weeks)

Claude Code engine adapter (spawn plan, settings.local.json hook wiring with backup/
uninstall, interrupt, version probe). `eph-hook` shim + UDS server (+ Windows named
pipe) with per-spawn token. Avatar state machine driven by real hook events; station
walks for tool classes. Command bar with queue-until-idle + interrupt semantics.
Fake-engine binary v1 and the adapter conformance suite. Floor art v1 to the
UI-DESIGN §7 quality bar (licensed tileset intake + ATTRIBUTION.md + walk-cycle
citizens replacing the M0 placeholder) lands with the avatar work.

**Exit:** SRS UC-03 demo — spawn a real `claude`, ask it to edit a file, watch shelf
walk → desk → idle; type into it mid-run; conformance suite passes for claude + fake.

## M2 — The Agora + Hermes: a company of two (≈ 2–3 weeks)

Agora on-disk layout + single committer (queue, backoff, startup reconcile).
Registry, ledger, `log.jsonl` + Activity tab. Hermes: outbox watchers, atomic
delivery, speech-act validation, hop caps, bounce, broadcast, cursors, `.done/`.
Stop-hook autonomy loop + inbox wake watchdog. Identity/protocol injection at spawn.

**Exit:** two real agents complete a scripted collaboration (A `request`s data from B,
B `inform`s back) unattended; S-BLACKOUT, S-LIVELOCK, S-BOUNCE, S-WAKE, S-STOPLOOP
pass.

## M3 — Artemis + the Watch: a governed company (≈ 3 weeks)

Artemis lifecycle (auto-spawn, temple seat, respawn-with-memory), prompt assembly
from `prompts/`, delegated-authority table, blackboard scribing, task assignment
flow (§7.1). Gates: deny-by-default policy, approvals UI, packaging (what/why/blast
radius/rollback). Budgets + durable cost ledger (transcript folding). Circuit-breaker
ladder. Secret broker + redaction filter. Kanban Ledger tab.

**Exit:** SRS UC-02 + UC-08 demos — a real directive fans out through Artemis and a
destructive op stops at a gate; S-GATE, S-BREAKER, S-LEDGER, S-SECRETS pass. **From
this milestone on, Ephesus agents help build Ephesus** (dogfood start).

## M4 — The Library + engine breadth (≈ 2 weeks)

Memory read/write protocol live (agents demonstrably recall across respawn), recall
+ company archive via MemPalace (ADR-0016: wings/rooms/drawers mapping, mtime-gated
mining, visible install path) + FTS/grep degrade, Memory panel, reflection job
+ archive, knowledge shelf. Second and third engine adapters (pick two: codex,
gemini, opencode) at honest hook grades. Worktree isolation option.

**Exit:** kill and respawn an agent — it resumes with memory; recall smoke test with
known-answer queries passes; two extra engines pass conformance; parity with the
upstream inspiration's core loop is reached.

## M5 — The Odeon: the accountable company (≈ 3 weeks) — *differentiator*

Briefing compiler (fact refs mandatory) + Briefs tab. Deck template + task-close
gate + deck viewer. Memo policy engine + queues + Artemis triage/countersign +
verdict routing + immutable archive. Meeting driver (turn order, minutes, action
items) + Odeon room on the floor. Org layer v1: org chart, hire templates
(versioned), per-agent metrics from the log.

Gymnasium v1 lands here on top of the Odeon/org primitives it reuses: `gymnasium.ts`
(proposal validation, ledger, gate classification, metric scheduling, rollback driver —
SDD §7.6), the `gym` IPC surface, the ledger seeded from the repo's build-phase
`docs/gymnasium/` archive, and the standup brief's gym-slice section.

**Exit:** SRS acceptance §6.3 (deck) and §6.4 (memo) pass as S-DECKGATE / S-MEMO;
S-BRIEF and S-MEETING pass; a real weekly retro report generates; S-GYM passes
(proposal shape enforcement, architect-only verdicts, mechanical refusal of
authority-widening proposals, rollback on regressed metric).

## M5b — The Stoa + company modes: the learning company (≈ 1–2 weeks)

The proof-of-improvement milestone (ADR-0017, ADR-0018). Depends only on M5's
Gymnasium v1; runs immediately after M5 and may proceed in parallel with M6 — it is
deliberately lettered rather than renumbering the milestones that accepted ADRs
already cite.

`stoa.ts`: watchlist (schema §4.7, architect-only mutation), researcher spawn plans
(read-only checkout, no secret grants), brief validation (uncited finding rejected
pre-human), immutable brief archive, `stoa` IPC group; the Agora `stoa/` layout
seeded from the repo's build-phase `docs/stoa/` (FR-13.7). Company mode in
`config.json` + `gym.mode/setMode` (architect-verified handler), the proof-gate
check over the gym ledger + log (SRS §6.9), scheduler mode-gating for the
Stoa/Gymnasium cadences, mode tagging on autonomous records, breaker rung-3
auto-revert (FR-14.5). Status-strip mode chip; the standup brief states the mode
and folds the Stoa into the gym-slice section.

**Exit:** SRS acceptance §6.8 (research) passes as S-STOA and §6.9 (proof gate) as
S-MODE; E-STOA runs against the fixture source; one **real** research cycle over a
registered watchlist source produces an archived, provenance-valid brief and a GYM
proposal citing it in the Architect's queue. The proof gate itself is *met* later,
by operation — this milestone builds and proves the machinery that will measure it.

## M6 — The Herald: the spoken company (≈ 2–3 weeks) — *differentiator*

Voice seam interfaces + policy layer (PTT, barge-in, repeat-back, failover state
machine). ElevenLabs adapter (STT + streamed TTS), OpenAI Realtime adapter (duplex).
Persona/phrase-book assets. Spoken briefings + voice approvals + meeting narration.
Optional local wake word. Text-parity degradation.

**Exit (AMENDED 2026-08-30 by Architect decision — see the note below):** every
scenario and conformance suite green, S-FAILOVER among them; the floor at the
UI-DESIGN v2 bar with its evidence committed; the close-out audit's findings
fixed with named, mutation-checked regressions.

> **What this amendment does and does not do.** The original exit read: *"SRS §6.2
> standup test and §6.5 failover test pass **live**; S-FAILOVER passes scripted; a
> full day driven by voice without touching the keyboard for status."* All three
> live clauses depend on the Herald being reachable from the application, and
> M6.9 — which wires it — was **deferred indefinitely** on 2026-08-30 because the
> Herald is not a current priority. They were therefore unreachable by
> construction, not merely unperformed, and BUILD-PROMPT §5 would have held M6
> open forever against a bar nobody intended to meet.
>
> So M6's **milestone gate** becomes the mechanical bar above, which is met.
> **SRS §6.2 and §6.5 are NOT satisfied and are not removed** — they are
> system-level v1 acceptance criteria (SRS §6) and they stay exactly as written,
> owed, now attached to M6.9 wherever it lands. The voice-driven day rides with
> them. This is a change to when the milestone closes, not a claim that the voice
> subsystem was demonstrated; the M6 close-out audit exists precisely because a
> record once said the latter.

## M7 — The Harbor + the two outward missions (≈ 2 weeks) — *differentiator*

> **Split from a single M7 on 2026-08-29** (Architect decision at the M6
> close-out), at the seam between the missions that face the Architect's *other*
> repositories and the one that faces this one. The original M7 put the one-hour
> company test, the recursive test, a chat bridge and three-OS packaging behind a
> single exit gate; neither half could be verified without the other being
> finished. The M5/M5b precedent applies.

Profile schema + loader + activation UI, per-target instantiation and
stricter-wins autonomy composition. **Skeleton Crew** built-in profile (health
watcher, CI babysitter, dependency updates, incident playbooks + severity
escalation). **Front Office** built-in profile (issue/PR triage, reply drafting
with autonomy levels, docs/changelog sync, release-prep checklist). GitHub
ingestion via `gh`. Shareable hires/profiles (export/import, human-confirmed).

**Exit:** **The one-hour company test (SRS §6.1) passes on a real repo** — the
crew detects a broken test, fixes it or opens a fix PR, files the memo if policy
was crossed, and the next briefing narrates the incident accurately from the log,
with zero un-gated destructive actions. S-PROFILE passes; E-PLAYBOOK's drill is
recorded.

## M8 — The company you can leave running (≈ 2 weeks) — *hardening*

> **Inserted 2026-09-02, and it runs BEFORE M7b.** The order is the point: M7b
> ships signed builds of a company that improves itself, and today that company
> cannot survive a restart, cannot tell the Architect it has stopped, and runs
> every hire in the Architect's own working tree. Shipping that is worse than
> not shipping it. *(Numbering is inherited — M5b and M7b already broke strict
> sequence. M7b may be renamed M9; the order is what matters.)*

Reliability, observability, persistence and the coverage that keeps them.
Derived from the 2026-09-02 MVP register — five independent read-only
investigations plus direct verification against the running system's book of
record — and shaped by the Architect's standing instruction that M8 take **the
most reliable and testable fix rather than the smallest**.

Every item is setup, wiring or disclosure; none of it is "the code doesn't
work". The tree is green at 3,192 tests, and that is exactly the problem this
milestone exists to fix. Closing Time has never once run in the shipped app, the
standup reads the oldest 500 log entries, the dock shows an overnight run's
first 300 events, and each of those passes its suite. **The recurring defect of
this codebase is a check that cannot fail** — five distinct instances were found
in a single day — so M8 opens by establishing a coverage baseline (there is none
today) and the rule it enforces: a wiring seam with no test is a defect.

**Exit:** SRS §6.1's action half on a real repository, performed by **a developer
who is not the author, from a clean clone, following only the README**, and
surviving a deliberate restart mid-run. M7's own exit remains open and
independent; §6.1's action half is owed to both.

*Architect decisions, 2026-09-08, after the first attempt at this run.* **A fresh
agent session with no memory of building Ephesus satisfies "a developer who is
not the author"** — it cannot remember which button to press, which is the
property the clause exists to test. This is recorded because "we never decided
what counts" is why M7's exit has been open since 2026-09-01, and one run now
settles both. It is not a licence for the author to run it and call it a proxy:
the runner declares which it is at the top of its record (`docs/EXIT-M8.md` §0).

**The run waits for M8.14.** The first attempt stalled because consent and
activation exist only in the renderer, so no runner could reach them without a
person at the machine. Rather than work around that, the control surface is
built first — so the exit is performed end to end by somebody who did not write
the code, with nobody clicking anything. SRS §6.1 carries the matching
amendment.

**The run was performed on 2026-09-09 and the exit did NOT pass.** Record, with
every clause's evidence and log rows:
[`docs/demo/m8-onehour-aftershock.md`](./demo/m8-onehour-aftershock.md). It ran
end to end against `mertefesensoy/aftershock` by a runner who did not write the
code, driven entirely from `scripts/ephctl.cjs` with nothing clicked — so
M8.14 did what it was built for, and §6.1(a) as amended was satisfied. Result:
**3 clauses pass, 3 fail, 1 not applicable**. Passing are the three M8 itself
built — detection in 9m30s of Ephesus-side time, zero un-gated destructive
actions, and M8's own restart clause with `seq` contiguous 1..476 across a
force-kill. Failing are triage, the fix PR, and the briefing, each for one
concrete cause. Those causes are filed as **M8b**; the findings that made the run
expensive or its reports untrustworthy are filed as **M8c**. The exit row in
`docs/PROGRESS.md` is deliberately untouched — it is the Architect's to tick, on
that record.

## M8b — The crew can act, and the briefing can be read (≈ 3–5 days) — *hardening*

> **Filed 2026-09-09 from the M8 exit run**, which was performed end to end
> against `mertefesensoy/aftershock` by a runner who did not write the code and
> clicked nothing. Full record with evidence, log rows and timings:
> [`docs/demo/m8-onehour-aftershock.md`](./demo/m8-onehour-aftershock.md).
> Findings are cited by number below rather than restated.

The run returned **3 clauses pass, 3 fail, 1 not applicable**. The three that
pass are the ones M8 built: detection (9m30s Ephesus-side), zero un-gated
destructive actions, and M8's own restart clause — `seq` contiguous 1..476
across a force-kill, consent not re-asked, the open gate restored. **M8's
machinery works.** What failed is the layer above it: the crew had nothing to
act *from*, and the briefing could not be produced or read.

This milestone is therefore scoped to exactly the five findings on those two
paths. **It is the whole distance between the current tree and an exit that
passes**, and nothing else belongs in it.

**M8b.1 — Install the profile bundle into the harness home** *(Finding 8 —
the single highest-value fix in the record)*. The repository bundle carries
`incident.md` (7,046 bytes), `dependency-update.md` and `health-check.md`;
`$EPH_HOME/profiles/` is **empty**, and `activations.json` names all three.
Activation resolves the bundle from the repository while agents resolve
playbooks relative to the home, and nothing copies it across that boundary. One
gap, and it is the cause of **both** failing action clauses: no triage
(`incident-triaged: 0` across 18 incidents) and no fix PR. *Acceptance:* after
activation, every playbook the instance declares is readable from the agent's
own worktree, and a test asserts the declared set and the on-disk set are
equal — the assertion that would have failed on this run.

**M8b.2 — A meeting with one attendee must be able to end** *(Finding 11)*.
`meeting/said` passes the floor to the next attendee, who for a single-attendee
meeting is the same agent, so the meeting cannot advance past its only speaker.
Artemis diagnosed the loop from the log herself (seq 387 → 393 → 395 → 427 →
429) and declined the floor rather than spin. **The aggravating half:
`ephctl help`'s own usage line and `EXIT-M8.md` §5.4 both tell the runner to
convene exactly this case.** Artemis proposed the two fixes and either suffices:
adjourn when the only attendee yields, or treat a declined floor as ending the
round. *Acceptance:* a convened single-attendee meeting terminates and emits its
brief; the documented example in `ephctl help` is the tested case.

**M8b.3 — A brief that is archived must exist** *(Finding 13)*. The one brief in
the run was archived with `briefRef: "odeon/briefs/2026-09-09T06-08-00-374Z.md"`,
recording five sentences and 27 spoken seconds. **There is no `odeon/` directory
in the home at all**, and no brief markdown anywhere in it. Compounding it,
`meeting/said` rows carry `meetingId`, `from`, `floor` and `ts` and **no
content** — so between an unwritten `briefRef` and contentless `said` rows, the
narration Artemis gave at 07:05Z is unrecoverable from any artifact. §5.4 asks a
runner to read the brief against the incident and judge accuracy; there was
nothing to read. *Acceptance:* archiving is atomic with writing — a `briefRef`
in the log always resolves to a file on disk, and a test asserts that for every
archived brief.

**M8b.4 — The Odeon endpoint and the orchestrator agree on their vocabulary**
*(Finding 12)*. Artemis's adjourn request bounced: *"the odeon endpoint takes
`propose`, `inform`, `agree`, `refuse` or `done` acts; got `request`"*. She
recovered by re-sending as `refuse`, so this cost a round trip rather than a
deadlock — and it is only invisible because the agent worked around it. The
refusal itself is good (it enumerates the accepted acts) and is correctly
recorded as `hermes/bounce`. *Acceptance:* the orchestrator's meeting-control
messages use acts the endpoint accepts, asserted against the endpoint's own
schema rather than against a copy of it.

**M8b.5 — The ledger's first refusal must teach, or not happen** *(Finding 6, as
corrected)*. Every incident's first task-open was refused with
`ops: Invalid input: expected array, received undefined`, and the orchestrator
then retried successfully — 8 refusals, 8 recoveries. **The path is lossy and
noisy, not broken**, and the record carries the correction to an earlier
overstatement of this. What matters is the message: a raw validator error naming
a field and nothing else, whose failure to teach is proved by its recurring
eight identical times instead of being corrected after the first. *Acceptance:*
either the first attempt carries `ops` and the refusal stops occurring, or the
refusal names the expected shape and the offending task — measured the way
`docs/DECISIONS-LOG.md` already measures this class, by reading `reasons` in
`log.jsonl`.

**Exit:** `docs/EXIT-M8.md` re-run end to end by a runner who is not the author,
against a real repository, with **clauses 1b, 2 and 4 passing** and the three
that already pass still passing. The re-run needs no new script — `EXIT-M8.md`
is current, with the corrections in M8c.6 folded in.

## M8c — Bounded, and honest about itself (≈ 1 week) — *hardening*

> Filed 2026-09-09 from the same record. M8c.1–M8c.8 **blocked no clause** —
> they made the run expensive, or its reports untrustworthy.
>
> **M8c.9 and M8c.10 were added later the same day, from the M8b rehearsal**
> ([`docs/demo/m8b-rehearsal-m8b-rehearsal.md`](./demo/m8b-rehearsal-m8b-rehearsal.md)),
> and they are a different kind: **each would fail a real exit run on its own.**
> They were invisible on 2026-09-09 because the crew never got far enough to
> meet them — M8b is what let the crew act, and acting is what found them.
> M8c.8 is amended by the same run and is no longer a worry.

**M8c.1 — A ceiling must be reachable without a mouse** *(Finding 3)*.
`EXIT-M8.md` §2 calls setting a daily budget *"the step that is skipped and then
regretted"* and marks it mandatory. **There is no budget verb in the control
surface** — not offered, and unlike `watch:approve`, `odeon:verdict`,
`secrets:set` and `gym:set-mode`, not in the deliberately-refused list either.
It is simply absent, and M8.14's recorded scope names it in neither column. This
is a contradiction inside the run: ADR-0033 exists so the exit can be performed
with no mouse, and §2 then requires a window-only action. *Acceptance:* either
`budget:set` exists, or `ephctl help` refuses it by name with the reason — the
standard `watch:approve` already sets.

**M8c.2 — The first ingest must not replay history as news** *(Finding 5)*.
Within two minutes of activation, before anything was broken, the Harbor pulled
ten CI runs and the crew raised **eight incidents** for failures dated
2026-08-23/24 — sixteen days stale and already fixed. The decisive detail is
that the proof was **in the same payload**: the two *newest* runs in that batch
are both `success`. Repeat ingests correctly did **not** re-raise (dedupe works);
the defect is only the cold start. *Acceptance:* incidents are raised only for
runs newer than the activation, or a failure superseded by a later success on
the same branch raises none — with the ingest still reading history for context.

**M8c.3 — Findings 3 and 5 compound, and that is the lesson** *(cost control)*.
No ceiling could be set **and** the cold start replayed two weeks of history.
Neither alone is alarming; together they turned "walk away for an hour" into
**40,453,419 tokens ($11.22)** against the script's own guidance that *"a few
hundred thousand tokens is generous"* — roughly one hundred times over, with the
harness projecting 72.3% of the five-hour window consumed. The harness reported
this accurately and continuously; it had no ceiling to enforce and no way for a
CLI runner to give it one. *Acceptance:* a default ceiling, or a first-run
confirmation naming projected spend before the crew is hired. This package is
the Architect's call on policy, not a mechanical fix.

**M8c.4 — `WORKING` must cite a row that proves completion** *(Finding 7)*. With
eight ledger refusals already in the log and zero tasks succeeded,
`DIAGNOSIS.md` reported `incidents | WORKING | profile/incident-raised at seq
85`. The row is real and quoted honestly — but `incident-raised` proves the
pipeline was **entered**, not that it completed. M8.13's rule promotes an area on
"a log row that PROVES the area did its job"; an entry row was accepted as that
proof. **This is a sharper form of the defect M8.13 was built to prevent** — not
a vacuous pass from silence, but a false pass with eight recorded failures in
the same file. It stayed wrong for the whole run: `incident-triaged` was 0 at the
final check. The same reasoning weakens `the crew | WORKING | spawn at seq 40`.
*Acceptance:* each area's `working` verdict cites a **completion** row, and a
test plants an entered-but-failing pipeline and asserts the verdict is not
`working`.

**M8c.5 — A deduplicated condition must not lose what distinguishes its
occurrences** *(Finding 2)*. `DIAGNOSIS.md` reported *"authority.json was missing
and has been created (×2)"* while `log.jsonl` seq 1 recorded **`gate-policy.json`**
for the same `home/seeded-config` cause. Two files, one cause key, one surviving
message: the report kept the last, the book of record kept the first, and a
reader of either learns one file and cannot tell there was another. The file the
report drops is `gate-policy.json` — the one the README calls the company-wide
autonomy ceiling, and the file §6.1's last clause depends on. *Acceptance:* one
condition per file, or one message naming both.

**M8c.6 — Labels and docs that are true in the reader's vocabulary** *(Findings
4 and 1)*. `profile:activate` reports `armed dependency-sweep, health-sweep` and
never mentions the `ci` trigger, because `armed` can only list `kind:"schedule"`
triggers — an event trigger has no clock to arm. `EXIT-M8.md` §5.1 trains the
runner to read a missing `ci` trigger as *"a setup defect, and the run cannot
proceed past it"*, so **the documented reading of that output is: stop, the run
is invalid.** It is bound; the run nearly aborted on it. Separately,
`README.md:194` — the section `EXIT-M8.md` §1 actually sends the runner to —
still says only *"Node 20 (`.nvmrc`)"*; the correct floor is at `README.md:46`,
in **Quick start**, which the exit script does not name. The 2026-09-08 decision
log records that as *"Also fixed"*; the fix reached Quick start only. This
machine's Node 20.16.0 produced 22 `EBADENGINE` warnings and installed anyway,
so it is a near miss rather than a break. *Acceptance:* `armed` distinguishes
schedules from event triggers; the setup section states the Node floor; and
`EXIT-M8.md` §5.1 no longer sends a runner to abort on a bound trigger. **Same
class as M8c.5 and recorded twice already in the decision log: a label true in
the producer's vocabulary and false in the reader's.**

**M8c.7 — Recall must fail fast or not accept the call** *(Finding 9)*. Disclosed
as a graceful MemPalace degradation falling back to a full-text rung; in fact,
per the health-watcher's own report, `$EPH_RECALL` was *"unavailable, not merely
empty. Two attempts … produced zero bytes of output and never terminated; the
second was killed at 90s, exit 143."* A missing optional that degrades is the
documented design; a path that accepts the call, returns nothing and never
returns is a 90-second timeout trap, disclosed nowhere — `DIAGNOSIS.md` shows
only the known MemPalace cause. It also removed the crew's only route around
M8b.1. *Acceptance:* recall fails fast with a named cause, and the hang is a
reported degradation rather than a silent stall.

**M8c.8 — Decide what an engine-level permission prompt is** *(Finding 10,
**upgraded by the M8b rehearsal**)*. Ten
times the harness recorded `gate/ungated · tool-permission · waiting · "Claude is
waiting for your input"`. The harness is right to surface it — invariant §7
requires it — but the run's own rules forbid answering it, and `ephctl` cannot.
So an agent that reaches its engine's prompt is stalled for the rest of the run
**by construction**, which undercuts the premise of an unattended hour. This is
not an Ephesus gate: it has no `gateId` and no Architect can clear it.
**The rehearsal settles what this costs.** With the crew finally able to act,
it stopped here: **four of the five agents' last recorded action is a parked
prompt** — health-watcher 19:57:55, verifier 19:53:39, artemis 19:53:26,
ci-babysitter 19:44:37 — **twelve prompts in the hour**, against seven in forty
minutes on 2026-09-09. The Architect saw it from outside before the log did
(*"they opened 3 PRs then stopped"*). So the hour does not last an hour: **it
lasts until the first agent reaches a prompt**, and every number a run reports
is bounded by that rather than by the company's capacity. This is no longer a
premise being undercut; it is the thing that ends the run.

*Acceptance:* a decision, recorded as an ADR — either the spawn plan
pre-authorises these, or they escalate as real gates the Architect can clear.
The design question is the deliverable; the code follows it. Whichever is
chosen, an unattended hour must be able to *end because the work ended*.

**M8c.9 — A crew must be able to come back after a restart** *(M8b rehearsal,
Finding A — **the highest-severity item in M8c**)*. After the §4 force-kill the
instance restored correctly — plan back, trigger clock back, `seq` contiguous,
consent not re-asked — and then **the crew could not be brought back by any
documented surface**:

```
profile:activate  → hire "ci-babysitter" could not spawn: … asked for an isolated
                    worktree and did not get one — worktree refused:
                    "<home>\worktrees\agent.…-ci-babysitter" already exists
                    — nothing was activated
profile:deactivate → the harness failed: agents: no agent "agent.…-ci-babysitter"
```

A closed loop: **activate refuses because the worktrees exist, deactivate
refuses because the agents do not.** The rehearsal continued only because the
runner deleted four worktrees by hand (`git worktree remove --force`, then
`prune`), which no README documents and which a non-author would not invent.

**It contradicts the exit run**, whose §6 recorded reactivation *"took over the
down instance rather than refusing it as a duplicate — ADR-0027's intent,
confirmed live"*. Something differs between the two runs and the rehearsal did
not chase it; **finding out which is the first half of this package**, because
one of the two observations is about a path that no longer works.

*Acceptance:* after a restart, `profile:activate` on a restored instance brings
its crew back with no manual filesystem step — reusing or replacing the existing
worktree — and a test performs a restore-then-reactivate against real
directories rather than a stubbed worktree seam. Whatever is decided, the
refusal an Architect meets must name the recovery.

**M8c.10 — The exit script must not tell the crew the break is deliberate**
*(M8b rehearsal, Finding B — a defect in `EXIT-M8.md`, not in the product)*.
§3 instructs:

```bash
git commit -am "test: break one assertion for the M8 exit run"
```

The on-call agent reads that message and **correctly declines to open a fix
PR**. Its own words, from the rehearsal's log:

> …I reproduced it locally, confirmed a one-line revert turns the suite green (3
> pass, 0 fail), and **opened no PR because the break is self-described as a
> deliberate rehearsal fixture and main is unaffected.**

That is good judgement and the wrong outcome: **clause 2 asks whether the crew
would fix a broken build, and the script tells it not to.** The clause is
therefore unmeasurable as written. It was invisible on 2026-09-09 because the
crew never reached triage; the rehearsal proved it by pushing a second break
with a neutral message (`refactor(geo): simplify the interpolation arithmetic`,
a sign typo), which the crew triaged as a genuine defect and fixed in PR #3 —
merged, and `main` went green.

*Acceptance:* §3 tells the runner to commit the break with a message that reads
like an ordinary change, and says why in one sentence. Cheap, and until it is
done **no exit run can pass clause 2 honestly.**

> **Observation, not a package.** Two task-opens in the rehearsal were refused
> with `body is not valid JSON: Bad escaped character…` — the same class the exit
> run recorded as an Observation when hermes quarantined a health-watcher
> message. It has now cost a message on both runs, so it is a recurrence rather
> than a one-off; the M8b.5 refusal named the envelope and the orchestrator
> recovered. Recorded here so the third occurrence is not filed as new.

**Exit:** an unattended run of `docs/EXIT-M8.md` completes inside a **stated**
ceiling with no incident raised for a run older than the activation;
`DIAGNOSIS.md` reports no area as `WORKING` on the strength of an entry row —
verified by planting an entered-but-failing pipeline and reading the report; a
restarted company brings its crew back with no manual filesystem step; and the
hour ends because the work ended rather than because an agent met a prompt.

## M9 — The harness is the product (≈ 5–6 weeks) — *the pivot*

> **Inserted 2026-10-02, and it runs BEFORE M7b.** Planned and approved for
> planning on 2026-10-02; **the build has not started** — the Architect's words were
> *"i just want to plan this out not build it yet. i approve the documentation and
> planning for the future milestone."* The full plan, the evidence behind it and the
> seven decisions it rested on are in [`M9-PLAN.md`](./M9-PLAN.md); this section is
> the register's digest of it and does not restate what that file says.

The direction (M9-PLAN §2): the environment is not the differentiator, the upstream
concept had become a constraint, and a harness that only wraps one vendor's CLI can
neither run a local model nor measure itself. M9 builds **Ephesus's own agent
engine** (`eph-agent`, ADR-0036 — a CLI in a PTY behind the existing adapter seam,
speaking any OpenAI-compatible local endpoint first and Claude natively second), and
builds the **bench** before the engine so the exit is a measured **harness uplift**
under ablation (M9-PLAN §4), not a feature list. Zero new runtime dependencies;
every invariant and both data planes unchanged; one sentence of ADR-0009 superseded.

Packages (acceptance, tests and risk per package in M9-PLAN §6):

- **M9.0 The contract** — ADR-0036 accepted (done at plan time), ADR-0037 (the
  bench and its ledger) and ADR-0038 (the provider seam) written; SRS FR-15/FR-16/
  §6.11; SDD §13; TEST-STRATEGY S-NATIVE/S-BENCH; the two watchlist sources studied
  at a pin into RB-002 and RB-003 before any engine code.
- **M9.1 The bench, v0** — schema'd tasks (T1 = `EXIT-M8.md` made mechanical, T2 a
  dependency bump, T3 a docs drift), a runner that drives the company only through
  the control surface, a scorer reading `log.jsonl` and the cost ledger,
  `docs/bench/LEDGER.md` append-only with every row's condition; deterministic
  discrimination suite in CI; one live baseline row on the wrapped `claude` adapter.
- **M9.2 `eph-agent`: the native engine** — the loop, the provider seam with the
  OpenAI-compatible local implementation over platform `fetch`, native hook
  emission (`hooks: 'native'`), the Stop question asked of the harness (ADR-0013
  unchanged), a `schemaVersion`'d JSONL transcript, refusal by name of an
  unreachable endpoint or a model without native tool calls or below the context
  floor; `native.ts` registered and passing the whole conformance table.
- **M9.3 Tools, and the gate as the permission prompt** — a closed tool registry
  with containment at every path; `shell` honours ADR-0035 grants as the allowlist
  and everything else is a real Ephesus gate (ADR-0039); tool results tagged
  untrusted with provenance (NFR-18 as a record).
- **M9.4 Memory and context** — the Library layer, `recall` as a tool, compaction
  as a `compacting` event that preserves identity and protocol byte for byte.
- **M9.5 Claude, natively** — the Anthropic Messages API over `fetch`, key as a
  broker secret; the same loop runs the reference model, so a bench cell can
  isolate the loop from the model.
- **M9.6 The first uplift** — ablation switches, N ≥ 3 per cell on one local model
  and `claude` native, rows with conditions, README quoting the ledger; the weekly
  bench cadence under company-mode governance.
- **M9.7 Headless-first** — `npm run headless`; the window a client of the same
  `IpcDeps`; nothing deleted (DD-M9-4).
- **M9.8 Exit review.**

**Exit (M9-PLAN §7):** the native adapter passes the whole conformance table in
both directions; a native-engine Skeleton Crew on a local model completes bench T1
from the control surface with no window, zero parked prompts and zero un-gated
destructive actions; the harness uplift is measured and recorded for one local
model and `claude` native, N ≥ 3 per cell, whatever the numbers are; zero new
runtime dependencies; no accepted ADR edited; docs synced. **The unattended hour
of `EXIT-M8.md` is subsumed by T1 (DD-M9-7)**: the M7, M8b and M8c exit boxes stay
open until T1's first live row exists, and they are the Architect's to tick on it.

## Phase 9, continued: M9b–M9f — the agentic harness, to v1 (≈ 32–39 weeks at nominal package estimates) — *the capabilities*

> **Planned and approved for planning 2026-10-03; the build has not started, and
> neither has M9's.** The
> Architect gave Ephesus the feature sets of the two harnesses on the Stoa
> watchlist as its target and said: *"We will keep the initial Ephesus brand core
> but the floor becomes an optional view mode and Ephesus upgrades itself towards a
> real agentic harness."* **M9 above is unchanged and comes first** (DD-M9-8). What
> follows it is seven lettered milestones, each with its own exit and its own bench
> tasks: **five before M7b — this section — and two after it** (DD-M9-18, which
> amended DD-M9-10 once the estimate was known). The full plan — the sixteen features mapped
> to their subsystems, the rules every capability enters under, acceptance, tests
> and risk per package, the decisions it rests on — is
> [`PHASE-9-PLAN.md`](./PHASE-9-PLAN.md); this section is the register's digest and
> does not restate it.

Three rules carry the whole phase (PHASE-9-PLAN §4). **The bench comes with the
capability**: each one is a switch in the ablation protocol and lands with a task
whose verifier no agent can reach, so a milestone exits on ledger rows. **Granted
by name, gated by the Watch**: web reach, a backend, a skill, a connector and a
schedule are declared in the hire template and shown before anything starts, and
content from outside the company arms the gate. **A zero-dependency core and a memo
for every addition** (DD-M9-9): M9 stays as approved; after it, `fetch`, `node:`
builtins or an owned subprocess first, and a decision memo for anything else.

Every milestone opens with a contract package (`.0`) that writes its ADRs, its SRS
group, its SDD, THREAT-MODEL and TEST-STRATEGY sections and runs one governed
`/research` cycle at a pin, as M9.0 does.

**The estimate is the sum of the package estimates, not a rounded hope.** All seven
milestones: about 48 weeks of packages, 51 with exit reviews, in series. That is
roughly double what the Architect was quoted when the order was first decided, so
the order was asked again on the full figure and **M7b moved to after M9f**
(DD-M9-18). To v1 on that order: about 32 weeks on the main line — M9b, M9d, M9e,
M9f — with M9c beside it, about 39 in series. After v1, M9g and M9h are about 12.
PHASE-9-PLAN §8 says what cuts the other way.

### M9b — The workspace: a harness you talk to (≈ 7 weeks)

- **M9b.1 View modes** — ADR-0040: the window opens on a workspace; the Terraces
  are a mode, not loaded unless chosen, not deleted; absent means `workspace` on
  every install.
- **M9b.2 The conversation** — a pure projection of the native engine's transcript;
  input down the existing command path; gates approved inline through the one
  handler; a wrapped hire shows its terminal.
- **M9b.3 Sessions, and choosing a model** — a `companion` hire; models picked from
  capability records; resume and search; Artemis stays the front door.
- **M9b.4 Attachments** — validated in main; an image only to a model with vision.
- **M9b.5 Skills** — `SKILL.md`; inspect and install by the Architect; granted by
  name; an agent may only propose, through the Gymnasium.
- **M9b.6 The Architect's profile, and notes** — a budgeted profile in the Library;
  quick capture into the knowledge shelf.

**Exit:** both a fresh and an upgraded home open on the workspace with the floor
one switch away and its suites green; a native Artemis carries T1-shaped work from
the conversation with a gate approved inline; the skills uplift measured (T-SKILL,
N ≥ 3 per cell); an agent-proposed skill in the ledger that no path can install
without a verdict.

### M9c — The hearth: local models, first-class (≈ 7 weeks; may run beside M9b and M9d)

- **M9c.1 What the machine is** — hardware facts with provenance, `unknown` rather
  than a guess.
- **M9c.2 The catalogue, and what fits** — a pure fit function with a named
  limiting resource.
- **M9c.3 Downloads** — the Architect's act, never an agent's; checksum before the
  final name.
- **M9c.4 Serving, and the verified capability** — `owned` (llama.cpp as an owned
  subprocess), `declared` (the Architect's command line: vLLM, SGLang) and
  `attached`; a capability record that is probed, not claimed.
- **M9c.5 Compare** — the Architect's blind verdict as a judged row, the mapping
  held in main until it is written; a script cannot give one.
- **M9c.6 The council** — multi-model reasoning as a grant; measured against its
  best member.

**Exit:** on the Architect's machine, scan → fit → pull → serve → `verified` → a
native hire runs T1 with the server in the row's condition; no agent path pulls or
serves; one blind comparison recorded; the council measured, whatever the number.

### M9d — The walls and the hands (≈ 8–9 weeks)

- **M9d.1 The backend seam, `local` and `docker`** — the loop never moves; the
  tools may (DD-M9-14); a declared isolation grade checked in both directions.
- **M9d.2 `apptainer`, `ssh`, `modal`** — the same conformance table; pinned host
  keys; a cloud sandbox named at consent.
- **M9d.3 Provenance arms the gate** — once outside content is in context, a hire
  may read more and may not write to the world without a human (DD-M9-12).
- **M9d.4 MCP** — one company-wide registry (DD-M9-13); the harness is the only
  client, so a server holds its credentials and no agent does; manifest drift
  refuses.
- **M9d.5 Delegation** — ephemeral workers with a subset of the parent's grants,
  torn down on return.
- **M9d.6 Scripted tool calls** — a program in the backend calling the hire's own
  tools through the same gate path.

**Exit:** the backend table green for `local` and `docker`, every other backend
recorded with its platform or as not exercised; T-INJECT with zero canary leaks
with the gate armed and the unarmed cell recorded; MCP end to end with no secret
in an agent's reach; T-FANOUT with and without delegation.

### M9e — The open web and the research desk (≈ 7–8 weeks)

- **M9e.1 Search and fetch** — the `web` grant; a configured search backend;
  private and loopback addresses refused at every redirect; an archive that keeps
  citations resolvable.
- **M9e.2 The browser** — Electron's own Chromium, offscreen, per-hire profile;
  input on an unlisted origin is a gate; ships only inside its support window
  (the Electron pin).
- **M9e.3 Sight, images, voice** — `vision`, `image_generate`, and `speak`: the
  Herald's **output** gets a caller and nothing else of M6.9 does (DD-M9-16).
- **M9e.4 Inquiries** — the Stoa studies questions as well as repositories; a
  report with an uncited finding is rejected before a human sees it.
- **M9e.5 Documents** — an AI edit is a patch the Architect accepts; no agent path
  writes the file.

**Exit:** T-RESEARCH on a fixture web with every citation resolving and the
planted instruction reported; one live inquiry recorded with its condition; the
address-refusal table green; with no hire holding `web`, egress is unchanged.

### M9f — The harbor opens: every surface, one Artemis (≈ 9 weeks)

Absorbs M7b.4.

- **M9f.1 The gateway, the terminal and Telegram** — one conversation behind every
  surface; identity paired by a code issued at the machine — single-use, expiring,
  attempt-limited, with a lockout; an unpaired sender receives nothing.
- **M9f.2 More platforms** — Discord, Slack, Signal, WhatsApp; one adapter per PR
  behind one conformance table.
- **M9f.3 Remote authorisation** — a paired human on an authenticated surface may
  approve, with repeat-back for what cannot be undone; absent policy means off; a
  script still approves nothing.
- **M9f.4 Schedules from language** — a plan the Architect confirms; armed
  verbatim; fresh session per run; pauses itself on repeated failure.
- **M9f.5 Push, reminders and the morning brief** — ntfy first; what a push carries
  depends on where it goes.
- **M9f.6 The workspace in a browser** — a third front door onto the same handlers,
  bound to loopback only, never without a session; reached from a phone through a
  tunnel the Architect runs; a remote surface, not a second window.

**Exit:** a real chat identity paired and an unpaired one met with silence; a
destructive gate approved from chat only with repeat-back, through the one
validated path; a schedule made in language that survives a restart and runs
headless; **a truthful morning brief on the phone after an unattended night**
(moved here from M7b); the workspace open in a phone's browser, with nothing
answering outside a session.

## M7b — The recursive company + shipping (≈ 2 weeks) — *differentiator*

> **Follows M9 (2026-10-02, DD-M9-1).** Content unchanged; M7b.2's proposals about the
> harness now cite bench rows as evidence and bench deltas as metrics (M9-PLAN §9).
>
> **Follows M9f (2026-10-03, DD-M9-18, amending DD-M9-10).** v1 is M9 through M9f;
> M9g and M9h are built after this milestone. The chat bridge is absorbed by
> M9f.1–M9f.3 and is not built here, and the exit clause about a morning brief on
> the phone moves to M9f's exit with it. Everything else in this section stands,
> and this is still the v1 acceptance boundary.

**Recursive Improvement** built-in profile (FR-9.5, ADR-0019 — needs M5b's Stoa
and modes): researcher + improver roles, mode-gated activation, delivery as PRs
under the company identity (FR-10.5, ADR-0020 — machine account, broker-held
token, the attribution carve-out in `check-attribution.cjs` lands here). ~~Chat
bridge (remote conversation, briefs, approvals; `remote` tagging).~~ *(moved to
M9f, 2026-10-03)* Packaging: signed builds for macOS/Windows/Linux, one-click
update check.

**Exit:** S-RECURSE passes; the recursive test (SRS §6.10) lands one real chain —
URL on the Stoa panel → brief → approved proposal → company-identity PR →
Architect merge; ~~a real overnight run produces a truthful morning brief on the
phone~~ *(moved to M9f's exit, 2026-10-03)*. The Gymnasium and Stoa cadence triggers are live under company-mode
governance (ADR-0018 — they fire autonomously only in `improving`, which the
proof gate §6.9 must first unlock), and the two-week gymnasium acceptance test
(SRS §6.7) is booked as the final v1 acceptance gate. **This is the v1
acceptance boundary.**

## Phase 9, after v1: M9g and M9h (≈ 12 weeks at nominal package estimates) — *planned, post-v1*

> **Planned 2026-10-03 with the rest of the phase; built after M7b** (DD-M9-18).
> No v1 requirement asks for mail, a calendar or a companion app, and nothing in
> M7b waits on them. With M7b.2 landed first, the company's own Recursive
> Improvement profile can take part in building them. Packages, acceptance, tests
> and risk are in [`PHASE-9-PLAN.md`](./PHASE-9-PLAN.md) §6.

### M9g — The Architect's desk: mail, calendar, todos (≈ 4–5 weeks)

- **M9g.1 The mail connector** — IMAP and SMTP; mail is untrusted input; no send
  tool exists, because sending is what an approved outbound gate does (ADR-0030).
- **M9g.2 The inbox profile** — a triager that cannot draft and a drafter that
  cannot send.
- **M9g.3 Calendar and todos** — CalDAV; an event is written only by an approved
  gate; todos are ledger tasks assigned to `human`.

**Exit:** triage on a real mailbox with nothing sent un-gated; the calendar in the
brief and an event written only through a gate; a planted instruction in a mail
reported and not obeyed; T-TRIAGE rows recorded.

### M9h — The companion: Ephesus on the phone, as its own subsystem (≈ 7 weeks)

DD-M9-15: *no shortcuts — a proper mobile system.* M9f already serves the phone
the way Hermes Agent does, through paired chat accounts and the workspace in a
browser. This milestone builds what neither source has.

- **M9h.0 The design** — the protocol written down before it is written in code,
  and reviewed adversarially as a document: pairing, handshake, replay protection,
  rotation, revocation; the threat cases named by hand.
- **M9h.1 Device identity and pairing** — a key that never leaves the phone;
  pairing only at the machine, by a code that carries no long-lived secret; a
  device list with no secret in it; one act ends a pairing.
- **M9h.2 The channel** — authenticated by the device key and protected end to end
  at the application layer, so whatever carries it sees ciphertext; a replay, a
  tampered message and a downgrade are each refused.
- **M9h.3 The companion itself** — an installable client of the same handlers the
  window uses; nothing old shown as current; no secret, no mode, no registry.
- **M9h.4 Push to the device** — the push service learns that something happened
  and nothing about what.

**Exit:** a real phone paired at the machine, and an unpaired or ended one
receiving nothing; a destructive gate approved from the companion with repeat-back
through the one validated path; on a captured session nothing readable, a replay
and a tampered message refused; a lost-phone drill written down; **and the
phase's closing review** — every bench task with its deterministic half in CI.

## Post-v1 horizon (recorded, not planned)

Department-head middle tier (ADR-0005 consequence) · local voice adapters · SDK-based
headless workers (ADR-0009) · read-only attach viewer (ADR-0014) · Telegram + more
bridges · multi-machine crews.

*Amended 2026-10-03 (PHASE-9-PLAN §9):* **Telegram + more bridges** is no longer
horizon — it is M9f. **Local voice adapters** move into M9e.3, for speech output
only (DD-M9-16). **Multi-machine
crews** stays here: DD-M9-14 chose *loop local, tools remote*, so a hire's tools
may run on another machine and its loop may not. **SDK-based headless workers**
remains what ADR-0036 made it — a possible provider behind the native engine's
seam, not a kind of its own.

---

## Risk register

| # | Risk | Likelihood | Impact | Mitigation / trigger |
|---|---|---|---|---|
| R1 | Engine hook schema drift breaks the event plane | High (it will happen) | Medium | Versioned shim, payload validation with visible warnings, heuristic fallback (FR-2.3); nightly live suite catches drift within a day |
| R2 | Stop-hook loop pathology burns budget overnight | Medium | High | Triple guard (ADR-0013) + breaker burn-rate signal + per-agent budgets; S-STOPLOOP |
| R3 | Odeon friction: agents drown in memo paperwork | Medium | Medium | Memo-policy granularity per profile; memo-volume health metric in org panel (ADR-0008); tune before M7 |
| R4 | Voice latency/quality misses the "Jarvis" bar | Medium | Medium | Streaming-first design, data-side compile before narration; failover; the bar is measured (NFR-3), not vibes |
| R5 | ElevenLabs/OpenAI pricing or API changes | Medium | Low | Seam (ADR-0007) — worst case is writing another adapter |
| R6 | fs-watch flakiness cross-platform (Hermes latency) | Medium | Medium | Debounced watchers + periodic sweep fallback; bench gate on all three OSes |
| R7 | Artemis judgment quality caps the product | Medium | High | Prompt-as-policy iteration loop + E-DECOMP/E-ESCALATE eval trends; delegated authority starts narrow and widens with evidence |
| R8 | Scope: three differentiator subsystems after parity | High | High | M5–M7 are strictly sequenced vertical slices; each independently shippable; parity at M4 means the project is useful even if paused there |
| R9 | Solo-maintainer bus factor | Certain | Medium | This documentation suite + dogfooding from M3 (the company maintains itself under supervision) |
| R10 | Secret leakage via agent output | Low | Critical | Broker + env-grant least privilege + redaction filter + S-SECRETS; security memo path for new grants |
| R11 | Gymnasium drift: self-improvement gamed (metric gaming, authority creep) or degenerating into busywork | Medium | High | ADR-0015 hard rules (nothing self-approves; ledger is total; budget slice); mechanical refusal of authority-widening proposals (FR-12.3); unmeasurable ⇒ regressed ⇒ rollback; the Gymnasium's own health metric is its validated-vs-regressed ratio, reviewed in retros (UC-12) |
| R12 | Prompt injection / hostile content in a watched source steers the researcher | Medium | High | ADR-0017 R2: content is data; read-only, no-secrets researcher spawns enforced by the Watch (NFR-17); adversarial S-STOA plants an injection per run; nothing from a source lands ungated (FR-13.4) |
| R13 | License/IP contamination from studied repositories | Low | High | Patterns not code (FR-13.5); license recorded at registration, `unverified` refuses pattern intake; verbatim/derived intake demands memo + attribution (ENGINEERING-STANDARDS §5) |
| R14 | Autonomy enabled before the loop is trustworthy, or left on through a failure | Low | High | ADR-0018: proof gate refuses the first enable until §6.9 evidence exists; mode is architect-only, always visible, mode-tagged records; breaker rung 3 auto-reverts (FR-14.5) |
| R15 | Recursive Improvement floods the Architect with PRs, or review decays into rubber-stamping | Medium | Medium | One scoped change per proposal (FR-12.2) bounds PR size; Artemis ranks before anything is implemented; the gym budget slice (FR-12.5) bounds volume; PR throughput + time-in-review become org-panel health metrics reviewed in retros (UC-12) |
| R16 | Company GitHub credential leaks or the account is misused | Low | High | ADR-0020: fine-grained PAT, broker write-only, env-grant to improver roles only; account holds write not admin; `main` PR-and-review protected so the host blocks merges; every remote act logged; one broker action revokes |
| R17 | The native engine grows engine-specific knowledge into core (NFR-12's failure from the other side of ADR-0024) | Medium | High | `native.ts` is a fourth adapter behind the same interface; import-boundary lint; a conformance suite with four subjects, never one special case (M9-PLAN §11) |
| R18 | The bench is gamed — prompts tuned to its tasks, or the company reading its own score (R11 for an instrument) | Medium | High | ablation scores contribution not absolute; T2/T3 not written by the prompt author; verifiers outside agent worktrees; bench-seeded proposals Architect-gated; the ledger is total |
| R19 | Local-model quality makes T1 unreachable at any harness setting, read as "the harness failed" | Medium | Medium | the exit asks for a measured uplift, not a positive one; the row names the model and its tool-use declaration; `claude` native is the second cell so a model limit and a harness limit can be told apart |
| R20 | Owning tool execution moves THREAT-MODEL §6.7 one layer closer with no OS sandbox | Medium | High | containment at every path (`tool-grants.ts` rule), the gate as the shell's permission prompt, worktree isolation (M8.6); §6.7 amended to say what is bounded; a sandbox is a later ADR |
| R21 | A provider key is a kind of money the consent screen does not yet name | Low | Medium | ADR-0032's consent names provider spend per hire before start; the key is broker-held and never read back |
| R22 | Five milestones stand between M9 and v1, and two more follow it — R8 at ten times the scale | High | High | each milestone is useful alone and exits on its own bar; the Architect already moved M7b forward once (DD-M9-18) and may take it at any earlier boundary; a bench row that shows no uplift is a reason to stop (PHASE-9-PLAN §12) |
| R23 | Injection at open-web and mail scale (R12 widened from one watched repository to everything an agent can now read) | High | High | the armed gate (M9d.3) lands before the first stranger's content; contained backends; researcher and triager roles that hold no powers; T-INJECT in CI; THREAT-MODEL §6.1 still says *mitigated, not solved* |
| R24 | Approval fatigue: armed gates and a phone that can approve turn the Architect's verdict into a reflex (R15's shape) | Medium | High | the bench counts gates opened per task as a cost; taint-tolerant grants are explicit; repeat-back for what cannot be undone; `remoteApproval` absent means off |
| R25 | Dependency creep under sixteen features' pressure | High | Medium | DD-M9-9: `fetch`, `node:` builtins or an owned subprocess first; PHASE-9-PLAN §10 lists every expected memo; `NOT BUILT`, with the reason, is an accepted package outcome |
| R26 | Seven platform APIs, each drifting (R1 for the gateway) | High | Medium | adapters behind one conformance table; recorded captures; the live suite only for adapters the Architect has paired |
| R27 | Supply chain: model weights, container images, MCP servers, skills | Medium | High | hashes and digests pinned; installed only by the Architect's act; manifest drift refuses; each registry is one review point |
| R28 | An ageing Chromium reads the open web (Electron is pinned at 37) | Medium | High | the browser ships only inside the support window its ADR names, or in a container backend, or is recorded `NOT BUILT` |
| R29 | Remote authorisation weakens the clause SRS §6.1 protects | Medium | High | a paired identity on an authenticated adapter, a nonce, a digest of the held action, repeat-back, first verdict wins, default off, the same validated path a click takes, an adversarial pass |
| R30 | The product dissolves into a generic assistant — M9-PLAN's C1 from the other side | Medium | High | every capability enters through a city subsystem and carries its gate, its record and its bench row; what Ephesus offers is governance and measurement, not the feature list |
| R31 | A local model cannot carry the feature (R19 widened) | Medium | Medium | every bench row names its model and its verified capabilities; `claude` native as the second cell tells a model limit from a harness limit |
| R32 | The company-wide MCP registry puts one compromised server in reach of every hire (DD-M9-13) | Medium | High | the harness is the only MCP client and the server holds its own credentials; manifest snapshot and drift refusal; side-effect tools pass gate policy; results arm the gate; NFR-17's researcher rule stands unless amended |
| R33 | Cost multipliers stack — council, fan-out, schedules, research | Medium | Medium | an estimate shown before each; the ceilings; the morning brief reports spend per schedule and per capability |
| R34 | The phone and the browser are new ways into the machine (DD-M9-15): a listener ADR-0033 declined, and a security protocol of the project's own | Medium | High | loopback only and never without a session (M9f.6); pairing only at the machine; a device key that never leaves the phone; a channel unreadable and unreplayable by its carrier; machine-only acts refused by name on every remote surface; the design reviewed adversarially as a document before any code (M9h.0); no primitive implemented by hand |
| R35 | The estimate: about 44–51 weeks of packages at their nominal sizes, against the "about six months" quoted when the order was decided (DD-M9-10) | High | Medium | the order was asked again on the full figure and M7b moved to after M9f (DD-M9-18), about 32 weeks on the main line; every milestone exits on its own bar; the pace is re-read from the record at each exit review instead of assumed |

## Dependency order (what blocks what)

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M6 ─► M7 ─► M8 ─► M8b ─► M8c ─► M9 ─► [M9b…M9f] ─► M7b ─► [M9g, M9h]
            │          │      ▲ └► M5b ──┘                                               ▲
            │          └──────┘     └─────────────────────────────────────────────┘
            │                       (Stoa + modes need only Gymnasium v1; M7b's
            │                        cadences and its Recursive Improvement
            │                        profile run under M5b's modes)
            └── fake-engine rig ─────────┘          (everything tests against it)

Inside Phase 9 (PHASE-9-PLAN §8):

M9 ─► M9b workspace ─► M9d walls & hands ─► M9e web & research ─► M9f harbor opens ─► M7b (v1) ─► M9g desk ─► M9h companion
 │
 └──► M9c hearth   (needs only M9; may run beside M9b and M9d)
```

**Why M7b sits after M9f** (DD-M9-18). M9f carries the two things v1 already
requires of a remote surface — the chat bridge (FR-10.2) and the morning brief on
the phone — so it is the earliest boundary at which M7b's own exit can be met.

**Why the walls come before the web.** M9e, M9f and M9g each feed agents content
written by strangers — pages, chat messages, mail. M9d's armed gate and contained
backends are what stand between that content and a credential, so they land first.
It is the M8 insertion argument again: the order is the point.

The only cross-cutting asset built early and maintained forever is the fake-engine
rig — it is the test double for every milestone and the reason the differentiators
can be built deterministically.

**The hardening chain, and why it sits where it does.** M8 was inserted before
M7b on 2026-09-02 for a stated reason — *"M7b ships signed builds of a company
that improves itself, and today that company cannot survive a restart"* — and the
same reason extends to M8b and M8c. The 2026-09-09 exit run
([record](./demo/m8-onehour-aftershock.md)) established that M8's own machinery
holds: restart survival, a contiguous book of record, and zero un-gated
destructive actions all passed. What it also established is that the crew cannot
act on what it detects, and that an unattended hour has no reachable ceiling.
Shipping signed builds of that is the same mistake M8's insertion note refuses.
**M8b is the shorter path — it is the exact distance to an exit that passes.**
