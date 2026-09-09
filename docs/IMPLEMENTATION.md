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

> Also filed 2026-09-09 from the same record. **None of these blocked a clause**
> — they made the run expensive, or made its reports untrustworthy. Two of them
> would have made an unattended overnight run genuinely costly, which is the
> thing M8 exists to make safe.

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

**M8c.8 — Decide what an engine-level permission prompt is** *(Finding 10)*. Ten
times the harness recorded `gate/ungated · tool-permission · waiting · "Claude is
waiting for your input"`. The harness is right to surface it — invariant §7
requires it — but the run's own rules forbid answering it, and `ephctl` cannot.
So an agent that reaches its engine's prompt is stalled for the rest of the run
**by construction**, which undercuts the premise of an unattended hour. This is
not an Ephesus gate: it has no `gateId` and no Architect can clear it.
*Acceptance:* a decision, recorded as an ADR — either the spawn plan
pre-authorises these, or they escalate as real gates the Architect can clear.
The design question is the deliverable; the code follows it.

**Exit:** an unattended run of `docs/EXIT-M8.md` completes inside a **stated**
ceiling with no incident raised for a run older than the activation; and
`DIAGNOSIS.md` reports no area as `WORKING` on the strength of an entry row —
verified by planting an entered-but-failing pipeline and reading the report.

## M7b — The recursive company + shipping (≈ 2 weeks) — *differentiator*

**Recursive Improvement** built-in profile (FR-9.5, ADR-0019 — needs M5b's Stoa
and modes): researcher + improver roles, mode-gated activation, delivery as PRs
under the company identity (FR-10.5, ADR-0020 — machine account, broker-held
token, the attribution carve-out in `check-attribution.cjs` lands here). Chat
bridge (remote conversation, briefs, approvals; `remote` tagging). Packaging:
signed builds for macOS/Windows/Linux, one-click update check.

**Exit:** S-RECURSE passes; the recursive test (SRS §6.10) lands one real chain —
URL on the Stoa panel → brief → approved proposal → company-identity PR →
Architect merge; a real overnight run produces a truthful morning brief on the
phone. The Gymnasium and Stoa cadence triggers are live under company-mode
governance (ADR-0018 — they fire autonomously only in `improving`, which the
proof gate §6.9 must first unlock), and the two-week gymnasium acceptance test
(SRS §6.7) is booked as the final v1 acceptance gate. **This is the v1
acceptance boundary.**

## Post-v1 horizon (recorded, not planned)

Department-head middle tier (ADR-0005 consequence) · local voice adapters · SDK-based
headless workers (ADR-0009) · read-only attach viewer (ADR-0014) · Telegram + more
bridges · multi-machine crews.

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

## Dependency order (what blocks what)

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M6 ─► M7 ─► M8 ─► M8b ─► M8c ─► M7b
            │          │      ▲ └► M5b ──┘                            ▲
            │          └──────┘     └────────────────────────────────┘
            │                       (Stoa + modes need only Gymnasium v1; M7b's
            │                        cadences and its Recursive Improvement
            │                        profile run under M5b's modes)
            └── fake-engine rig ─────────┘          (everything tests against it)
```

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
