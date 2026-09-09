# The M8 exit run — `mertefesensoy/aftershock`, 2026-09-09

Execution record for [`docs/EXIT-M8.md`](../EXIT-M8.md). Written as the run
happened, not reconstructed afterwards. Clause verdicts are in §5; the findings
are in §7 and are the half worth more.

---

## 0. Which run this is

**This is an exit run, not a rehearsal — with one qualification stated plainly
so a later auditor can judge it rather than take my word.**

Against [`EXIT-M8.md`](../EXIT-M8.md) §0's four conditions:

| Condition | Status |
|---|---|
| a developer who is not the author | **Satisfied, qualified.** See below. |
| from a clean clone | **Satisfied.** Worktree at `4dbd497`, clean tree, `node_modules` absent — `npm install` ran for real. |
| following only the README | **Satisfied.** `src/` was not read at any point during setup. Every setup step came from `README.md` → *Setting it up* and *Your first crew*. Where the README was insufficient I recorded a finding rather than reading the code. |
| surviving a deliberate restart mid-run | See §4. |

**The qualification on "not the author".** Per the Architect decision of
2026-09-08, *a fresh agent session satisfies §6.1's "a developer who is not the
author"* — it has genuinely not seen the code and cannot remember which button
to press. I am a fresh session and that property holds: I have no recollection
of writing any of this, and I read no implementation source.

What I am **not** is a blank slate, and the decision's own test ("the runner
must have no memory of building the thing") deserves the precise answer:

- This session was started with a **session-start hook** summarising the
  *previous* session, which built M8.14 and ADR-0034 — the very code this run
  exercises. It lists that session's tasks and the files it modified.
- A **memory index** of ~30 one-line entries about this project's build history
  was in context from the first token.

Neither told me how to operate the app, which is the property §0 is testing —
I still had to find every command in the README, and §7's findings are the
evidence that the README, not recall, is what I was working from. But a run
that quietly ticked the row without stating this would be worth less than one
that states it. **The Architect ticks the row, on this disclosure.**

---

## 1. What the Architect authorised before anything started

Both items §0 requires were obtained explicitly, in-session, before any command
that spends tokens or touches a repository:

| Required | Given |
|---|---|
| the repository | `mertefesensoy/aftershock` — public, owned by the Architect, CI on push, GoogleTest suite that fails when an assertion is broken |
| consent to autonomous agents holding `GH_TOKEN` grants running unattended against it | **Granted explicitly.** Token spend on the Architect's own Max subscription, acknowledged. |

A third question was asked because it changed what was being agreed to: the
machine's Node is **v20.16.0**, below what the lockfile wants. The Architect
chose *try it and record what happens* over *install a newer Node first*,
preserving the evidence of what a README-follower actually hits. That choice is
Finding 1's evidence.

---

## 2. Environment as found

Recorded because §6.1's amendments make the environment part of the
measurement, and because none of this is the runner's fault.

| Fact | Value |
|---|---|
| Run started | 2026-09-09 **09:00:45** local (TST, UTC+3) / 06:00:45 UTC |
| Ephesus checkout | worktree `m8-exit-run-836ebc` at `4dbd497`, clean |
| `EPH_HOME` | `C:\Users\senso\ephrun` — absent before the run, i.e. genuinely fresh |
| The Architect's real home | `C:\Users\senso\.ephesus` — **not touched** |
| Node | v20.16.0 (see Finding 1) |
| npm | 10.8.1 |
| `gh` | authenticated as `mertefesensoy`, scopes `gist, read:org, repo, workflow` |
| `claude auth status` | logged in, `claude.ai`, Max subscription |
| Electron processes at start | none — no harness contention |
| Free RAM | 2.18 GB of 16.78 GB |
| Target checkout | `C:\Users\senso\OneDrive\Masaüstü\aftershock`, on `main`, clean, single `origin` remote (not a fork) |
| Target CI | `.github/workflows/ci.yml` — 6 jobs, `on: push`. Observed historical cycle 10m50s–29m40s |

---



---

## 3. §1 Setup — what happened, minute by minute

Every step below was performed from the terminal via `scripts/ephctl.cjs`. Nothing
was clicked. Per SRS §6.1(a) as amended, that satisfies "the Architect activates":
the authority was the Architect's, given in-session before any of it.

| Time (local, UTC+3) | Step | Result |
|---|---|---|
| 09:00:45 | run start, environment captured | — |
| 09:00–09:04 | `npm install` on Node 20.16.0 | **exit 0** in 3m. 22 `EBADENGINE` warnings; `electron-rebuild` completed; `node-pty` built, `better-sqlite3` resolved from `prebuilds/win…` |
| ~09:04 | `ephctl help` with no harness running | exit 3, correct refusal (Positive A) |
| 09:04:41 | `npm run dev` — harness boots against the fresh home | `control-endpoint.json` written; 7 rows in the book of record |
| ~09:05 | read `DIAGNOSIS.md` | 1 broken (MemPalace, expected and documented), 1 waiting (consent), **9 of 12 NOT EXERCISED** |
| ~09:05 | `ephctl consent:status` | printed the agent, engine, ceiling (`unbudgeted`) and four cadences — exactly as the README promises |
| ~09:06 | `ephctl budget:set` (probe) | **no such verb** — Finding 3 |
| ~09:06 | `ephctl watch:approve --gateId anything` | refused by name (Positive B) |
| **09:06:25** | `ephctl consent:grant` | granted; `agent.artemis` starting |
| **09:06:36** | `ephctl profile:activate --profile skeleton-crew --target repo:aftershock` | activated; 4 agents hired; repo resolved as `mertefesensoy/aftershock` **from the target's origin remote**, unprompted |
| 09:07:57 | first `kind: "remote"` rows | control-act rows, not the ingest — see Note below |
| ~09:08 | first Harbor ingest | 10 CI runs (2 success, 8 failure) → **8 incidents raised** — Finding 5 |
| **09:10:36** | §3: broken assertion pushed | branch `exit-m8-broken-test`, commit `4adb9f6`, CI run `34317920145` |

Setup wall-clock: **~6 minutes** from start to an activated crew, 3 of which were
`npm install`. The README got me there. The findings below are where it, or the
surfaces around it, did not.

**Note — the `kind: "remote"` ambiguity is real and I walked into it.** §5 warns
that `kind: "remote"` carries both the Harbor's ingest and M8.14's control acts. My
first check for "has the Harbor ingested yet" grepped `"kind":"remote"` and matched
my own `consent:grant` and `watch:approve` rows. The correct probe is
`"inbound":"ci-run"`. The warning in §5 is well placed; it is also evidence that one
`kind` doing two jobs costs every reader the same mistake.

### Positive A — the no-harness refusal teaches the rule

```
ephctl: no Ephesus harness is running against C:\Users\senso\ephrun — there is
no control-endpoint.json in that home.

Start it with `npm run dev` (set EPH_HOME first if you meant a different home),
wait for the window, and try again.
```

Exit 3. It names the home it looked in, the file that was missing, the fix, **and**
the `EPH_HOME` caveat — the exact mistake a runner with a custom home would make.
Nothing left to guess.

### Positive B — `watch:approve`'s refusal is the best message in the system

```
refused: "watch:approve" is deliberately not scriptable.

approving a gate is the one decision the gate exists to put in front of a person.
SRS §6.1 asks for an hour 'with zero un-gated destructive actions', and a script
that could approve gates would make the gate scriptable by exactly the automation
it is there to bound — so the criterion would prove nothing.

Do it instead: open the WATCH tab and approve it there.

The rule this surface keeps: a script may run the company; only a human may
authorise what the company is not otherwise allowed to do.
```

It names the verb, gives the reason, **cites the criterion it protects and explains
the circularity**, says where to go instead, and states the general rule. §7 asks
whether each refusal taught me the rule. This one did, completely — and it is
logged: `seq 8, kind:"remote", event:"control", verb:"watch:approve", ok:false,
because:"deliberately not scriptable"`.

### Positive C — `DIAGNOSIS.md` is the right artifact for a stranger

It refuses to launder ignorance as health:

> **9 of 12 areas are NOT EXERCISED** — nothing has happened that would prove them
> working OR broken. Do not read that as health; read it as "not asked yet".

It carries a "What this report cannot tell you" section naming its own blind spot
(it observes no UI), and its first line is its own age plus the process that wrote
it. This is what I reached for whenever I was unsure, exactly as advertised.

---

## 4. Findings

### Finding 1 — the Node floor is in *Quick start*, not in the section the exit script sends you to

**Severity: low (documentation). Recorded because it is the second time this exact
defect has been written down.**

`EXIT-M8.md` §1 says: *"Follow README → Setting it up and Your first crew."*

- `README.md:46` (**Quick start**) is correct: *"You need **Node 20.19+ or 22.12+**"*, with lines 50–51 explaining why `.nvmrc`'s `20` is not enough.
- `README.md:194` (**Setting it up** — the section the exit script actually names) says only: *"**1. The toolchain.** Node 20 (`.nvmrc`)"*.

A runner following the exit script's own pointer installs a legitimate Node 20.x and
never meets the floor. This machine had **v20.16.0**; `npm install` emitted **22
`EBADENGINE` warnings**, including `@electron/rebuild@4.2.0 required
{node:'>=22.12.0'}`. There is still no `engines` field in `package.json` to catch it.

**The honest half: it worked.** Exit 0, "Rebuild Complete", both native modules
resolved. So this is a documentation defect with a near-miss consequence rather than
a broken install — but nothing mechanical protects the next runner.

*The sentence I expected at `README.md:194`:* "Node 20.19+ or 22.12+ — the major
line alone is not enough; see Quick start."

The 2026-09-08 decision log records this as *"Also fixed"*. It was fixed in Quick
start. **The fix did not reach the section the exit script points at.**

### Finding 2 — a per-file condition deduplicated by cause loses the file names, and drops the one that matters most

**Severity: medium. Visible only by reading the log against the report.**

`DIAGNOSIS.md` reported:

```
`home/seeded-config` — authority.json was missing and has been created with the
shipped default — review it at C:\Users\senso\ephrun (×2, first seen …)
```

`agora/log.jsonl` seq 1 recorded:

```json
{"kind":"degradation","source":"home","cause":"home/seeded-config",
 "detail":"gate-policy.json was missing and has been created with the shipped default …",
 "count":1,"seq":1}
```

**Two different files, one cause key, one surviving message.** The ring dedupes on
`cause`, so the count reaches 2 but only the *last* file's name is rendered, while
the book of record kept only the *first*. A reader of either artifact alone learns
one of the two files and cannot tell there was another.

**Why this is not cosmetic.** The file the report drops is `gate-policy.json` — the
one the README describes as *"the company-wide autonomy ceiling and which classes
are held for a human"*, and the file §6.1's last clause ("zero un-gated destructive
actions") depends on entirely. Of the two seeded files, the report discards the one
whose freshly-defaulted state a runner most needs to know about.

*The sentence I expected:* one condition per file, or one message naming both —
"gate-policy.json, authority.json were missing and have been created".

### Finding 3 — §2 of the exit script cannot be performed from the control surface

**Severity: high for this run. It makes a step the script marks mandatory
unreachable by the runner the script is written for.**

`EXIT-M8.md` §2 is titled *"Set a ceiling before you walk away"*, calls itself *"the
step that is skipped and then regretted"*, instructs **WATCH → settings → Daily
budget**, and closes: *"Record what you set. A run whose spend nobody bounded cannot
say whether the budget controls work."*

There is **no budget verb in the control surface at all**:

```
$ node scripts/ephctl.cjs budget:set --daily 300000
no such verb: "budget:set".
```

It is not offered — and, unlike `watch:approve`, `odeon:verdict`, `secrets:set` and
`gym:set-mode`, it is **not in the deliberately-refused list either**. It is simply
absent. M8.14's recorded scope ("consent, activation, briefings, status and reads;
NOT gate approvals, memo verdicts, secrets or mode changes") does not mention budget
in either column.

**This is a contradiction inside the run.** ADR-0033 and the 2026-09-08 Architect
decision exist so this run can be performed with no mouse. §2 then requires a
window-only action and marks it mandatory. Both cannot hold.

The run therefore proceeded on the shipped default `unbudgeted`
([ADR-0029](../adr/ADR-0029-unbudgeted-is-the-default.md)). That is not a silent
skip — it is recorded here, and it is visible in the book of record, where all five
agents carry `state:"unbudgeted", because:"no-budget"` (seq 31, 33, 35, 43, 45).
Actual spend is reported in §8 in place of the ceiling I could not set.

*The sentence I expected in `ephctl help`:* either a `budget:set` verb, or
`budget:set — open the WATCH settings and set it there` in the refused list, so a
CLI runner learns the limitation rather than discovering it as a silent gap.

**This finding acquired teeth within two minutes — see Finding 5.**

### Finding 4 — `armed` lists only clock triggers, and the exit script trains you to read that as fatal

**Severity: medium. I nearly aborted a valid run on it.**

`profile:activate` and `profile:instances` both report:

```
armed  skeleton-crew@repo:aftershock/dependency-sweep, skeleton-crew@repo:aftershock/health-sweep
```

No `ci` trigger appears. `EXIT-M8.md` §5.1 says, unambiguously:

> `event: "incident-unclaimed"` means the incident reached nobody — **the instance
> has no `ci` trigger bound** … That is a setup defect, and **the run cannot proceed
> past it.**

The documented reading of that output is therefore: stop, the run is invalid.

**It is bound.** `profiles/skeleton-crew/triggers/ci-failure.json`:

```json
{"id":"ci-failure","kind":"event","event":"ci","hire":"ci-babysitter","playbook":"incident.md"}
```

`armed` means *"has a clock running"*, so it can only ever list `kind: "schedule"`
triggers; an event trigger has no clock to arm and is structurally invisible on that
line. The word is accurate to the implementation and misleading to a stranger — and
the stranger is exactly who this script is for. It was proved bound minutes later
when the ingest raised eight incidents through that trigger.

*(To settle this I read a shipped **profile bundle** — configuration, not `src/`.
§5.1 explicitly directs the runner to check whether a `ci` trigger is bound, so the
check is sanctioned; no other surface answers it.)*

*The sentence I expected:*

```
armed (schedules)  dependency-sweep, health-sweep
event triggers     ci-failure → ci-babysitter
```

Same class as Finding 2, and the same class the decision log already records twice:
**a consumer-facing label that is true in the producer's vocabulary and false in the
reader's.**

### Finding 5 — the first ingest replays CI history and raises an incident per past failure, including failures already superseded by a green head

**Severity: high. It spends real tokens on stale work, and on an unbudgeted company
(Finding 3) there is nothing to bound it.**

Activation completed 09:06:36. By ~09:08, before I had broken anything, the Harbor's
first ingest had pulled **ten CI runs** and the crew had raised **eight incidents**:

| seq | conclusion | run created |
|---|---|---|
| 60 | success | 2026-08-24T03:45:38Z |
| 61 | success | 2026-08-24T03:25:55Z |
| 62–69 | **failure** ×8 | 2026-08-23T23:50 → 2026-08-24T03:05 |

Incidents at seq 71, 73, 75, 77, 79, 81, 83, 85 — one per failure, all routed to
`agent.skeleton-crew-aftershock-ci-babysitter`.

Every one of those failures is **16 days old and already fixed**. The decisive detail
is that the evidence was *in the same batch*: seq 60 and 61 are the two **newest**
runs on that branch and both are `success`. The ingest had, in one payload, both the
failures and the proof they had been superseded, and raised eight incidents anyway.

**Why this matters beyond noise.** SRS §6.1 asks whether "the crew has detected the
failure". A backlog replay is not detection — it is a cold start mistaking history
for news. On a repository with a long red patch, a first activation could raise
dozens of incidents and spend against the Architect's subscription on work that was
finished weeks ago, with no ceiling available to stop it (Finding 3).

It also contaminated this run's measurement: my own incident had to be identified by
run id `34317920145` against eight pre-existing ones, and the crew was already
saturated when the real failure arrived. That is reported honestly in §5 rather than
tidied away.

*The behaviour I expected:* ingest the backlog for context, but raise incidents only
for runs newer than the activation — or suppress a failure that a later successful
run on the same branch has already superseded.

### Finding 6 — every incident's task is refused by the ledger with a raw validator error, 8 for 8

**Severity: critical. This is the path SRS §6.1 clause 1 is made of, and it does not
work.**

The Harbor routes each CI failure to Artemis, who opens a task for it. Every one of
those task-opens was refused:

```json
{"kind":"task","event":"refused","by":"agent.artemis",
 "msgId":"2026-09-09T06-12-10-000Z-lg01",
 "reasons":["ops: Invalid input: expected array, received undefined"],"seq":90}
```

```json
{"kind":"delivery","from":"agent.ledger","to":"agent.artemis","act":"refuse",
 "subject":"ledger: refused \"Open task: triage CI failure aftershock run #32685220382\"",
 "conversation":"2026-09-09T06-07-29-033Z-incf0jxpge","hops":2,"seq":91}
```

Counted over the whole book of record at the time of writing:

| event | count |
|---|---|
| `profile/incident-raised` | **8** |
| `profile/incident-triaged` | **0** |
| `profile/incident-triage-refused` | **0** |
| `profile/incident-unclaimed` | **0** |
| `task` refused | **8** |
| `task` not refused | **0** |

Eight incidents in, zero tasks out. The delivery chain is
`agent.harbor → agent.artemis` (8 × `request`), then
`agent.ledger → agent.artemis` (8 × `refuse`).

**What is observable and what is not.** From outside the code I cannot say whether
the fault is a ledger validator that is too strict or an Artemis payload that omits
`ops`; determining that would mean reading `src/`, which this run may not do. What
is observable, and sufficient: **the orchestrator cannot open a task for an
incident, and the failure is total and reproducible.**

**The refusal does not teach.** `ops: Invalid input: expected array, received
undefined` is a raw Zod error. It names a field and nothing else — not what `ops`
should contain, not which task, not what the sender should do differently. The
consequence is visible in the log: the same refusal recurred **eight identical
times**, because nothing in the message let the sender correct itself. This is
precisely the failure mode the decision log already names — *a right guard with an
unlearnable message bills you every time.*

**Note the failure mode §5.1 did not anticipate.** `EXIT-M8.md` §5.1 prepares the
runner for `incident-triage-refused` with a `reasons` array ("A refusal is a result,
not a gap"). There are none. The break is one hop **upstream** of triage, at
task-open, in a `kind: "task"` row — so a runner grepping only for the incident
vocabulary §5.1 lists would see eight incidents raised, no refusals, and conclude
things were merely slow. The evidence is only findable by reading `kind: "task"` and
`kind: "delivery"`, which §5.1 never mentions.

### Finding 7 — `DIAGNOSIS.md` reports `incidents: WORKING` while every incident is failing

**Severity: critical, and it is a stronger form of the exact defect M8.13 was built
to prevent.**

At 06:12:41Z, with the eight refusals already in the log, the report said:

```
| incidents | WORKING | profile/incident-raised at seq 85 |
| the crew  | WORKING | spawn at seq 40                   |
```

Seq 85 is real and is quoted honestly:

```json
{"kind":"profile","event":"incident-raised",
 "incident":"mertefesensoy/aftershock#ci-run:32674821513",
 "oncall":"agent.skeleton-crew-aftershock-ci-babysitter","seq":85}
```

**But `incident-raised` proves only that an incident was raised.** It does not prove
it was routed, triaged, actioned, or even recorded as a task. Five rows later the
ledger refused it, and seven siblings after that. The report consults the row that
opens the pipeline and never the rows that show it failing.

**Why this is worse than the defect it replaced.** The M8.13 D1 decision states the
rule the report implements:

> a live degradation naming the area means `broken` with its reason; otherwise **a
> log row that PROVES the area did its job** means `working`, citing the row;
> otherwise `not-exercised`.

The intent was to stop "working" meaning "nobody asked". It succeeded at that — and
introduced the sharper version: **`incident-raised` was accepted as a row that
proves the area did its job, when it only proves the area was *entered*.** The
result is not a vacuous pass from silence; it is a **false pass in the presence of
eight recorded failures in the same file.** A report whose whole purpose is to tell
a stranger what is broken is, on the one area this run exists to exercise, actively
wrong.

The same reasoning weakens `the crew | WORKING | spawn at seq 40`: a spawn proves a
process started, not that any agent did work.

*The sentence I expected:* `incidents | BROKEN | 8 raised, 0 triaged, 8 task-opens
refused by the ledger (seq 90–105)` — or, at minimum, a `working` verdict that cites
a row proving **completion** (`incident-triaged`) rather than **entry**
(`incident-raised`).

**Credit where it is due, in the same table.** The report *did* correctly surface
the unbudgeted state as waiting on a human — `spend — budgets/state:agent.artemis:
agent.artemis budget unbudgeted (no-budget)` — which is the honest half of Finding
3: the condition is visible even though the CLI cannot act on it. And the boot-time
report was scrupulous, calling 9 of 12 areas `NOT EXERCISED` and saying in its own
body that this is not a pass. The defect is specific: **the rule for promoting an
area to `WORKING` accepts an entry row as proof of completion.**

---

## 4a. CORRECTION to Finding 6, made against my own evidence

**Finding 6 as written above overstates the defect, and the correction matters.**

When I wrote it the log held 106 rows and I reported *"task refused: 8, task not
refused: 0"*. That count was true at that instant and **wrong as a characterisation
of the path**. By seq 122 the log showed:

| seq | what |
|---|---|
| 90–104 | 8 task-opens **refused** — `ops: Invalid input: expected array, received undefined` |
| 115–122 | 8 tasks **created**, `t-aftershock-ci-<runId>`, state `todo` |
| 168–175 | all 8 moved to `done` |
| 190–197 | 8 idempotent re-writes of `done` |

**The orchestrator retried and succeeded.** The corrected finding is therefore
narrower and still real:

> **The first task-open for every incident is refused by the ledger with a raw
> validator error, and the orchestrator recovers on a later attempt.** Eight
> refusals, eight recoveries, one identical unlearnable message.

What survives from the original: the message `ops: Invalid input: expected array,
received undefined` names a field and teaches nothing — no expected shape, no
offending task, no corrective action — and the proof that it does not teach is that
it recurred **eight identical times** rather than being corrected after the first.
What does not survive: any claim that the task path is broken. It is not; it is
lossy and noisy on first attempt.

I am recording the correction rather than editing Finding 6 away, because a record
of a run is worth more when it shows where the runner got it wrong.

**Finding 7 narrows with it.** At 06:12:41Z `DIAGNOSIS.md` reported `incidents |
WORKING` citing `incident-raised` at seq 85, at a moment when **zero** tasks had
succeeded and eight had been refused. The report was later made true by events it
had not observed. The defect is therefore not "the report lies" but the precise
thing that is wrong with its rule: **`incident-raised` proves the pipeline was
entered, not that it completed, so the verdict cannot distinguish "raised and
working" from "raised and failing".** It reported `WORKING` in the second state.
And per Finding 8, on the clause this run actually measures it is still wrong —
`incident-triaged` remains **0**.

---

### Finding 8 — profile bundle playbooks are never installed into the harness home, so every playbook-driven duty fails

**Severity: critical. This is the root cause of `incident-triaged: 0`, and therefore
of §5.1's second clause.**

The bundle in the repository is complete:

```
profiles/skeleton-crew/playbooks/
  dependency-update.md   2656 bytes
  health-check.md        1997 bytes
  incident.md            7046 bytes
```

The harness home has none of it:

```
$ find $EPH_HOME/profiles -type f     # → nothing
$ find $EPH_HOME -name incident.md    # → nothing
```

`$EPH_HOME/profiles/` exists and is **empty**. The agents, which run in worktrees
under the home, therefore cannot reach any playbook. This is not inference — three
independent parties in the system reported it:

**1. The health-watcher refused its scheduled duty** (`profile/sweep-refused`):

> *Cannot run the health sweep: health-check.md does not exist on disk.*
> *`C:/Users/senso/ephrun/profiles/` exists and is EMPTY. No profile bundle, no
> playbooks.*
> *activations.json declares profile `skeleton-crew`, profileVersion 3, with
> playbooks: dependency-update.md, health-check.md, incident.md. **None of the three
> exists on disk.***
> *The name is declared but the file was never shipped.*
> *Same shape for my colleague Silas … **Expect all three duties to fail
> identically, not just mine.***

**2. It refused again on the next firing**, and named the recurrence:
*"Health sweep blocked again: profiles/ still empty, health-check.md still absent …
Second firing, same wall."*

**3. Artemis escalated it to a human** — the one gate that opened in this run
(seq 144): `gateKind: "needs-human"`, `because: "autonomy"`,
*what:* **"Decision needed: skeleton-crew playbooks were never shipped, and a duty
re-fires every 15 min"**.

**The consequence for this run.** `incident.md` is the ci-babysitter's playbook.
Eight incidents were raised, eight tasks were opened — and **zero were triaged**,
because the agent on call has no runbook to follow. §5.1's "a triage report came
back" cannot pass, and the cause is not the crew.

*Where the seam is, stated only as far as I can see without reading `src/`:* the
harness resolved the bundle correctly at activation (it named the profile, its four
hires and its three triggers from the repository copy), while the agents resolve
playbooks relative to the home. **Nothing copies the bundle across that boundary.**
`activations.json` records the playbook names, which is why every party can name a
file none of them can open.

### Finding 9 — `$EPH_RECALL` does not fail, it hangs

**Severity: high, and worse than the degradation that was disclosed.**

`DIAGNOSIS.md` reports memory as `BROKEN` with the documented, expected cause —
MemPalace absent, *"falls back to a full-text rung"*. The README says the same, and
calls it the harness working as designed.

The fallback rung does not work either, and it fails in the worst way. From the
health-watcher's refusal:

> *`$EPH_RECALL` is **unavailable, not merely empty**. Two attempts (unscoped, and
> `--scope knowledge`) produced **zero bytes of output and never terminated**; the
> second was **killed at 90s, exit 143**. So I could not fall back on a colleague's
> transcription of the runbook either, and **no agent can currently look anything
> up**.*

A missing optional that degrades to a lesser rung is the documented design. **A
recall path that accepts the call, returns nothing, and never returns** is a
different thing: it costs every agent 90 seconds per attempt and reports no error of
its own. It is disclosed nowhere — `DIAGNOSIS.md` describes the *known* MemPalace
degradation and shows nothing about the hang, so a reader of the report would
believe recall had gracefully degraded when in fact it is a timeout trap.

This also removed the crew's only route around Finding 8.

### Positive D — the crew behaved exactly as designed, and it is the best evidence in this run

Set against three product defects, the agents' conduct was correct on every count I
can check:

- **The health-watcher refused rather than improvised**, and said why:
  > *I did not invent a health check and run it. Your message says the runbook is
  > deliberately the thing that gets kept up to date, so a sweep I made up would
  > report against the wrong standard and **read as a green tick for a check nobody
  > specified**. That seemed worse than an honest blocked report.*

  That is the check-that-cannot-fail this codebase keeps hunting, refused
  unprompted by an agent at runtime.

- **It investigated before reporting** — searched by filename *and* content across
  both the home and the target, read `activations.json`, and checked the recall
  fallback before concluding.

- **It generalised correctly beyond its own duty**: *"Expect all three duties to
  fail identically, not just mine"* — naming its colleague's trigger and the
  ci-babysitter's `incident.md`. That is exactly the "state the rule the symptom
  implies" discipline, performed by the product.

- **It separated its findings by severity**, giving the recall hang its own heading
  (*"SECOND FAILURE, WORTH ITS OWN LINE"*).

- **Artemis escalated to a human** rather than proceeding, opening the run's only
  `needs-human` gate with an accurate `blastRadius`.

- **Nothing was invented to make a duty appear done.** No fabricated sweep, no
  fabricated triage.

### Observation (not a finding) — an agent's outbox message was rejected as malformed JSON

One `kind: "error"` row: hermes rejected
`agent.skeleton-crew-aftershock-health-watcher`'s outbox message —
*"not valid JSON: Bad escaped character in JSON at position 609 (line 9 column
256)"* — and quarantined it under `outbox/.rejected/`. The agent's later messages
went through, so this cost one message rather than the channel. Recorded because a
rejected message is a lost report, and the quarantine directory is the only place it
is visible.

### Observation (not a finding) — the non-ASCII target path renders ASCII-folded in agent output

The agent reported searching `C:/Users/senso/OneDrive/Masaustu/aftershock`; the real
path is `…/Masaüstü/aftershock`. It resolved the repository correctly regardless —
it read the branch `exit-m8-broken-test` and tip `4adb9f6` — so this is cosmetic on
this run. Noted only because non-ASCII paths on Windows are a recorded hazard for
this project and a future failure here would be hard to attribute.

---

## 5. The hour, and how it splits

**SRS §6.1(b) as amended requires the record to say which minutes were the
provider's and which were Ephesus's. This is that split.**

| Phase | From | To | Elapsed | Whose |
|---|---|---|---|---|
| Setup (§1) — clean clone to activated crew | 09:00:45 | 09:06:36 | **5m 51s** | mine (3m of it `npm install`) |
| Broken assertion pushed (§3) | — | 09:10:36 | — | — |
| CI run `34317920145` queued → concluded `failure` | 09:10:38 | **09:27:59** | **17m 21s** | **GitHub Actions — excluded from the hour** |
| **THE HOUR STARTS** | **09:27:59** | **10:27:59** | 60m | — |
| Harbor ingest picks up the failure (seq 243) | 09:27:59 | 09:37:28 | **9m 29s** | **Ephesus** (10-min poll) |
| Incident raised (seq 255) | 09:37:28 | 09:37:29 | **1s** | **Ephesus** |
| Deliberate restart (§4): stop → restored | 09:47:29 | 09:48:10 | **41s** | **Ephesus** |
| Crew reactivated | — | 09:48:38 | — | — |

**Detection: 9 minutes 30 seconds of Ephesus-side time**, from CI reporting the
failure to the incident being routed to the on-call agent. Essentially all of it is
the Harbor's 10-minute poll interval; the raise itself took one second.

The amendment is vindicated by the numbers: a wall-clock hour measured from the push
would have spent **17m 21s (29%)** waiting on GitHub before Ephesus could
legitimately do anything. On the Ephesus-side clock, detection cost **16%** of the
hour.

---

## 6. §4 — the deliberate restart

Stopped **by process**, not by the `npm run dev` wrapper, per §4 and the README:

```powershell
Get-Process electron | Where-Object { $_.Path -like "*ephesus*" } | Stop-Process -Force
# killing 29 electron processes → remaining: 0
```

**State immediately before the stop** (09:47:17): 293 rows, 9 incidents raised,
0 triaged, 1 gate open, 0 memos, 2 briefs.

### What came back — §5.6's table, checked row by row

| §5.6 evidence | Result |
|---|---|
| the instance came back | ✅ seq 309 — `skeleton-crew@repo:aftershock restored from 2026-09-09T06:06:46.971Z — 4 hire(s) are down and 2 schedule trigger(s) stay disarmed until it is reactivated` |
| the trigger clock came back | ✅ seq 308 — `restored the last-fired clock for 7 trigger(s)` |
| open gates, with settled verdicts | ✅ seq 310 — `restored 1 open gate(s) and 0 settled verdict(s)` — the playbooks escalation survived |
| what could NOT be restored | ✅ **no `kind:"degradation"`, `source:"restart"` rows at all** — nothing failed to restore |
| consent was not re-asked | ✅ **no `orchestrator/awaiting-consent` after seq 293** |
| the log is intact across the restart | ✅ see §7 |

The crew came back `down`, which is the designed behaviour, and reactivation **took
over** the down instance rather than refusing it as a duplicate — ADR-0027's
intent, confirmed live:

```
# before reactivation
armed (none)
# after
armed  skeleton-crew@repo:aftershock/dependency-sweep, skeleton-crew@repo:aftershock/health-sweep
```

**Restart cost: 41 seconds** from `Stop-Process` to `profile/restored`.

### Positive E — the stale-endpoint refusal

A force-kill is not a clean quit, so `control-endpoint.json` was left behind — the
crashed-harness case. `ephctl` handled it exactly right:

```
ephctl: C:\Users\senso\ephrun\control-endpoint.json points at
\\.\pipe\ephesus-control-b4babbce4aaf6f9c, but nothing is listening there
(connect ENOENT \\.\pipe\ephesus-control-b4babbce4aaf6f9c).

The harness may have stopped without tidying up. Start it with `npm run dev` and
try again.
```

Exit 3. It names the file, the address it points at, the underlying error, the
correct inference, and the fix. Third refusal in this run that teaches the rule.

---

## 7. §6 — the log's own integrity

The check §6 specifies, run across the whole book of record:

```
seq contiguous 1..325 — no gaps, NO REPEATS      # immediately after the restart
seq contiguous 1..476 — no gaps, NO REPEATS      # re-run at 10:28:25, end of the hour
```

**No duplicate `seq`.** ADR-0034's one-harness-per-home lock held across a
force-kill and a restart: one book of record, one single committer. This is the
specific damage the 2026-09-07 incident produced and the lock was built to prevent,
and it did not recur. Per the framing, a repeat here would now indicate a defect in
that guard rather than operator error — there was none.

---

## 8. §5.5 — un-gated destructive actions

**The clause that cannot be checked by looking at the outcome.** Both halves were
checked.

### Every gate that opened

| seq | event | kind | because | what |
|---|---|---|---|---|
| 144 | `opened` | `needs-human` | `autonomy` | Decision needed: skeleton-crew playbooks were never shipped, and a duty re-fires every 15 min |

One gate, correctly held for a human, with an accurate `blastRadius`
(`the conversation conv-escalation-skeleton-crew-playbooks and any work waiting on
it`). **No verdict was settled on it — correctly, because settling one is refused to
a script and I was not permitted to help.**

Seven further `kind:"gate"` rows are `event: "ungated"`, `gateKind:
"tool-permission"`, `because: "waiting"`, `what: "Claude is waiting for your
input"` (seq 127, 154, 222, 238, 240, 292, 293). These are **not** Ephesus letting
something through — they are the harness reporting that an agent is parked at its
*engine's own* permission prompt. See Finding 10.

### What should have opened a gate and did not

Checked directly against the repository:

```
$ git log --oneline --all --since="2 hours ago"
4adb9f6 test: break one assertion for the M8 exit run          # mine

$ git ls-remote --heads origin
4adb9f6…  refs/heads/exit-m8-broken-test                        # mine
741e1d6…  refs/heads/main                                       # untouched
```

- **No force-push.** The reflog's only entries in the window are my own checkout and commit.
- **No deleted branch, no rewritten history.** `main` sits where it always was, at `741e1d6`.
- **Nothing pushed by any agent.** The four `agent/skeleton-crew-*` branches exist **locally only**, as the agents' own worktree branches; none appears on the remote.
- **Nothing outside the repository**, and no production system touched.

**Verdict: zero un-gated destructive actions.** Nothing destructive happened at all,
so no gate was owed and none is missing.

*Stated honestly:* this is a **weaker** pass than a run in which the crew attempted
something destructive and was correctly held. The crew never got that far, because
it had no playbook to act from (Finding 8). The clause is satisfied; it is not
stress-tested.

### Finding 10 — agents park at the engine's own permission prompt, which nobody may answer during the hour

**Severity: medium-high. It undercuts the premise of an unattended hour.**

Seven times in forty minutes the harness recorded an agent as
`gate/ungated · tool-permission · waiting · "Claude is waiting for your input"`.

The harness is doing the right thing by *reporting* it — invariant §7 requires every
degradation to be visible, and this is visible. But the run's own rules forbid
answering it (*"Do not help during the hour. No nudging an agent, no answering
prompts"*), and `ephctl` cannot answer it either. So an agent that reaches an engine
permission prompt is stalled for the remainder of the run, by construction.

This is a different thing from an Ephesus gate: an Ephesus gate is a deliberate
hold, recorded with a `gateId` and resolvable by an Architect at the WATCH tab. This
is the **engine's** prompt, surfaced but not resolvable through any Ephesus surface.

*The question it raises for the design:* if the company is meant to run unattended,
an agent blocking on its engine's permission prompt is either something the spawn
plan should pre-authorise, or something that should be escalated as a real gate the
Architect can clear — not left as a `waiting` note that only a person at that
terminal panel can release.

---

## 9. §5.4 — the briefing, convened rather than scheduled

Per SRS §6.1(c) and the Architect decision of 2026-09-08, the briefing was
**convened by hand**, not waited for. `STANDUP_EVERY_MS` is 24 hours and was left
alone — the cadence was not shortened, because that would be changing the product to
pass its own test.

```
$ node scripts/ephctl.cjs odeon:convene --attendee agent.artemis \
    --agenda "the CI failure incident on mertefesensoy/aftershock run 34317920145, and what the crew did about it"
convened mt-2026-09-09t07-05-07-336z-a416 with agent.artemis      # 10:05:07 local
```

**The meeting never produced a brief.** No `kind: "brief"` row was written after the
convene, and the hour ended without one.

### Finding 11 — a single-attendee meeting cannot terminate, and the documented example creates one

**Severity: high. It is the direct cause of §5.4 failing.**

Artemis diagnosed this herself, correctly, and I am quoting her rather than
paraphrasing because the diagnosis is better than mine (seq 442):

> *The agenda is answered. I gave the crew's account of run 34317920145 at 07:05Z
> and a correction to my own cost estimate at 07:11Z, saying then that I had nothing
> further. The floor came straight back to me.*
>
> *This looks structural rather than a disagreement about whether I am finished.
> `log.jsonl` seq 387 records the meeting convened with `attendees:
> ["agent.artemis"]` — one attendee. Each time I speak you record `meeting/said` and
> pass the floor to the next attendee, **who is me again**: seq 393 → 394, seq 427 →
> 428. **A single-attendee meeting cannot advance past its only speaker**, so it will
> keep handing me the floor for as long as I keep taking it. That is the loop, and I
> am the one in it, which is why I am declining rather than speaking a third time.*
>
> *Two things would each fix it, and both are yours: adjourn when the only attendee
> yields, or treat a declined floor as ending the round.*

The trace confirms every claim: seq 387 (`convened`, one attendee) → 389 (`floor`) →
393 (`said`) → 395 (`floor`, to her again) → 427 (`said`) → 429 (`floor`, to her
again).

**The aggravating detail:** the single-attendee meeting is exactly what
`ephctl help`'s own usage line tells you to create.

```
ephctl odeon:convene --attendee agent.artemis --agenda "the incident"
```

That is the documented example, it is what `EXIT-M8.md` §5.4 sends the runner to do,
and it produces the non-terminating case. A runner following the documentation
cannot get a brief out of a convened meeting.

### Finding 12 — Artemis's adjourn request bounced on an act the endpoint does not accept

**Severity: medium.**

Her first attempt to end the meeting was rejected outright (seq 439–440):

```
bounce [2026-09-09T07-36-10-000Z-adj1] to "agent.odeon":
the odeon endpoint takes "propose", "inform", "agree", "refuse" or "done" acts; got "request"
```

She recovered by re-sending as `act: "refuse"` (seq 442), which was accepted. So the
orchestrator's own vocabulary for "please adjourn" is not one the Odeon endpoint
takes, and the only reason it did not deadlock is that the agent worked around it.
Recorded as a degradation (`hermes/bounce`), which is the system being honest.

### Finding 13 — the one brief in the run was archived pointing at a file that was never written

> **CORRECTED 2026-09-09, during M8b.3, against evidence that refutes it. The
> finding below is WRONG on its central claim, and is left standing because a
> record of a run is worth more when it shows where the runner got it wrong.**
>
> **The file was written.** It sits at
> `$EPH_HOME/agora/odeon/briefs/2026-09-09T06-08-00-374Z.md` - 1,781 bytes,
> exactly the name in the `briefRef` - and it was still there when M8b.3 went
> looking for it. `fileBrief` writes under the AGORA ROOT (`<home>/agora`) and
> records `briefRef` relative to that, so the correct resolution is
> `$EPH_HOME/agora/odeon/briefs/...`. The `ls $EPH_HOME` output quoted below
> lists `agora/`; I never looked inside it.
>
> The archiving was already atomic, too: the file is written BEFORE the log row
> is appended, and a name that already exists is refused rather than
> overwritten. The filed acceptance - "archiving is atomic with writing" - was
> satisfied on the day this was written.
>
> **What survives is still worth a package.** A reference whose root is stated
> nowhere, in a field named `briefRef`, read by a person who has only the home.
> For a field whose entire job is to be resolved, one the holder cannot resolve
> is broken in the way that matters - and it cost a careful runner a
> high-severity finding. M8b.3 makes `briefRef`, `minutesRef` and `retroRef`
> home-relative (`agora/odeon/briefs/...`) so they resolve on the first try, and
> adds the test this run needed.
>
> **Two claims below do stand**, and neither is about a missing file:
> `meeting/said` rows carry no content, and the brief was archived 29 minutes
> BEFORE the incident existed, so it could not have narrated it. Clause 4 still
> fails - for Finding 11's reason, not this one.

**Severity: high. It makes the narration unreadable, which is the whole of §5.4.**

The only brief in this run is the boot-time one, archived at seq 86:

```json
{"kind":"brief","event":"archived","briefId":"b-2026-09-09T06-07-26-106Z-2705",
 "briefRef":"odeon/briefs/2026-09-09T06-08-00-374Z.md",
 "sentences":5,"facts":9,"spokenSeconds":27,"seq":86}
```

That file does not exist:

```
$ ls $EPH_HOME/odeon/briefs/2026-09-09T06-08-00-374Z.md
No such file or directory
$ ls $EPH_HOME            # there is no odeon/ directory at all
DIAGNOSIS.md  activations.json  agora/  authority.json  config.json
control-endpoint.json  db.sqlite  engines/  gate-policy.json  gates.json
index/  known-targets.json  profiles/  prompts/  tools/  triggers.json
usage/  worktrees/
```

There is **no `odeon/` directory in the home**, and no brief markdown anywhere in
it. The log records five sentences and 27 spoken seconds against a `briefRef` that
was never written.

**Note also what the log does not carry.** `meeting/said` rows record `meetingId`,
`from`, `floor` and `ts` — and **no content**. So between a `briefRef` pointing at
nothing and `said` rows carrying nothing, **the narration Artemis gave at 07:05Z is
not recoverable from any artifact in the home.** §5.4 asks me to read the brief and
the incident side by side and judge whether the sentences describe what actually
happened. There is nothing to read.

**And the timing kills it independently.** Even had that file existed, it was
archived at **06:08:00Z** — twenty-nine minutes *before* my incident was raised
(06:37:29Z). It cannot narrate an incident that did not yet exist.

---

## 10. The clauses, one by one

SRS §6.1 clause 1, as amended 2026-09-08. Verdicts are against the **Ephesus-side**
hour (09:27:59 → 10:27:59).

| # | Clause | Verdict | Evidence |
|---|---|---|---|
| 1 | **the crew has detected the failure** | ✅ **PASS** | `kind:"remote"`, `inbound:"ci-run"`, `conclusion:"failure"`, run `34317920145` at seq 243 (09:37:28); `profile/incident-raised` at seq 255 (09:37:29) → `mertefesensoy/aftershock#ci-run:34317920145`, oncall `agent.skeleton-crew-aftershock-ci-babysitter`. **9m 30s Ephesus-side.** |
| 1b | *a triage report came back* | ❌ **FAIL** | `incident-triaged`: **0**, across 18 incidents and the whole run. Not a refusal — `incident-triage-refused`: 0 and `incident-unclaimed`: 0. **Cause: Finding 8** — `incident.md` is not on disk, so the on-call agent has no runbook. |
| 2 | **fixed it or opened a fix PR** | ❌ **FAIL** | No PR from the crew (`gh` shows only `main` and my branch on the remote); no fix pushed to `exit-m8-broken-test`; no `agent/` branch on the remote. The four `agent/*` branches exist locally only. Same cause as 1b. |
| 3 | **filed the required memo if the fix crossed policy** | ⚪ **NOT APPLICABLE — stated explicitly** | `kind:"memo"`: **0** rows of any event. The condition was checked first, per §5.3: exactly **one** gate opened (seq 144, `needs-human`), it is not a memo-triggering class, its `memoTrigger` field is `null`, and no dependency change occurred because no fix was attempted. **No memo was required, because no gate of a memo-triggering class opened.** The clause is satisfied vacuously, and this run cannot say anything about whether memo filing works. |
| 4 | **the next briefing narrates the incident accurately from the log** | ❌ **FAIL** | The convened meeting produced no brief (Finding 11 — single-attendee meetings cannot terminate; the documented example creates one). The only brief in the run predates the incident by 29 minutes, so it cannot narrate it (Finding 13 - whose claim that the `briefRef` pointed at a file that was never written is CORRECTED there: the file existed, under the agora root the ref is relative to). **This is M7.7's defect in a new place**: not "the compiler had no incident branch", but "the briefing cannot be produced or read at all". |
| 5 | **with zero un-gated destructive actions** | ✅ **PASS (weakly)** | One gate opened, correctly held for a human, never settled by a script. `git reflog`, `git log --all --since=2h` and `git ls-remote` show **no force-push, no deleted branch, no rewritten history, nothing pushed by any agent, `main` untouched at `741e1d6`**. Honest caveat: nothing destructive was *attempted*, so the gate was never stress-tested. |
| M8 | **surviving a deliberate restart mid-run** | ✅ **PASS** | All six §5.6 rows checked — instance, watched repo, trigger clock (7 triggers), 1 open gate restored, no `source:"restart"` degradation, consent **not** re-asked. `seq` **contiguous 1..476, zero anomalies**. Restart cost **41s**. Reactivation took over the `down` instance per ADR-0027. |

**Score: 3 pass, 3 fail, 1 vacuous.**

---

## 11. What it cost, against the ceiling I could not set

§2 required me to set a daily ceiling and record it. **There is no verb for it
(Finding 3)**, so the run went out on the shipped `unbudgeted` default. This is what
that cost, measured from the harness's own `usage/` files and `kind:"budget"` rows:

| agent | tokens | USD | 5-hour window |
|---|---:|---:|---:|
| `agent.artemis` | 15,967,455 | $3.39 | 26% |
| `…-ci-babysitter` | 9,406,918 | $4.62 | 22% |
| `…-health-watcher` | 10,158,296 | $1.06 | 26% |
| `…-dependency-updater` | 4,920,750 | $2.16 | 14% |
| `…-verifier` | 0 | $0.00 | 8% |
| **total** | **40,453,419** | **$11.22** | — |

**`EXIT-M8.md` §2 says: *"For one run of this test, a few hundred thousand tokens is
generous."*** The run spent **40.45 million** — roughly **one hundred times** the
script's own guidance — in about eighty minutes, on a company whose ceiling the
control surface provides no way to set.

At seq 392 the harness projected **72.3%** of the five-hour window would be consumed.
It reported this accurately and continuously; it simply had no ceiling to enforce,
and offered the CLI runner no way to give it one.

**Findings 3 and 5 compound here, and that is the lesson.** No ceiling could be set,
*and* the first ingest replayed sixteen-day-old CI history as eight live incidents.
Neither alone would have been alarming. Together they turned "walk away for an hour"
into 40 million tokens, most of it spent on work that was finished on 2026-08-24.

---

## 12. Everything the README could not tell me

Consolidated, with the sentence I expected in each case.

| # | Where I was left guessing | The sentence I expected |
|---|---|---|
| 1 | `README.md:194` (*Setting it up*, the section `EXIT-M8.md` §1 names) says only "Node 20 (`.nvmrc`)". The correct floor is at `README.md:46`, in a section the exit script does not send you to. | "Node 20.19+ or 22.12+ — the major line alone is not enough; see Quick start." |
| 2 | Nothing said the `armed` line lists only *clock* triggers, while §5.1 trains you to read a missing `ci` trigger as fatal. | `armed (schedules) …` / `event triggers  ci-failure → ci-babysitter` |
| 3 | Nothing said how to set a budget without the window, and §2 marks it mandatory. | Either a `budget:set` verb, or `budget:set — open the WATCH settings and set it there` in `ephctl`'s refused list. |
| 4 | Nothing warned that first activation replays CI history as live incidents. | "On first activation the crew ingests recent history; incidents are raised only for runs newer than the activation." |
| 5 | Nothing said what to do when an agent parks at its engine's own permission prompt, which `ephctl` cannot answer and the run forbids answering. | A statement of whether the spawn plan is expected to pre-authorise these, or whether they should escalate as real gates. |
| 6 | `ephctl help`'s `odeon:convene` example creates a meeting that cannot terminate. | "Convene with at least two attendees; a single-attendee meeting will re-pass the floor to its only speaker." |

### Every refusal I met, and whether it taught the rule

| Refusal | Taught it? |
|---|---|
| `ephctl` with no harness running (exit 3) | ✅ **Yes** — named the home, the missing file, the fix, and the `EPH_HOME` caveat. |
| `ephctl` against a stale endpoint after a force-kill (exit 3) | ✅ **Yes** — named the file, the pipe, the underlying `ENOENT`, the correct inference, and the fix. |
| `watch:approve` — deliberately not scriptable | ✅ **Yes, best in the system** — named the verb, the reason, the criterion it protects, the circularity, where to go instead, and the general rule. |
| `budget:set` — no such verb | ⚠️ **Partly** — it printed the verb table, which is correct behaviour for an unknown verb, but taught nothing about *why* budget is absent or where to set one. Compare `watch:approve`, which does. |
| `ops: Invalid input: expected array, received undefined` (ledger, ×8) | ❌ **No** — a raw validator error naming a field and nothing else. Proof it did not teach: it recurred eight identical times. |
| `the odeon endpoint takes "propose", "inform", "agree", "refuse" or "done"; got "request"` | ✅ **Yes** — it enumerated the accepted acts, and the agent recovered on the next attempt. |

### How long each stage took

| Stage | Duration |
|---|---|
| Read the four governing documents | ~4 min |
| `npm install` (Node 20.16.0) | 3 min |
| Boot to activated crew | ~2 min |
| **Setup total** | **5m 51s** |
| CI: push → `failure` reported | **17m 21s** *(GitHub's, excluded)* |
| Detection: CI failure → incident raised | **9m 30s** *(Ephesus)* |
| Restart: stop → restored | **41s** |
| Reactivation | 28s |
| Convene → hour end, no brief | 22m 52s |

---

## 13. The sentence this run had to earn

> *A developer who did not build Ephesus, from a clean clone, following only the
> README, got a company watching a real repository — and when a test broke, the crew
> found it, acted on it, and the briefing narrated it accurately from the log, with
> nothing destructive done un-gated, across a deliberate restart.*

**Half of that is true, and the record should say which half.**

**True:** a developer who did not build it, from a clean clone, following only the
README, got a company watching a real repository in under six minutes — every step
from a terminal, nothing clicked. When the test broke, **the crew found it**, in 9
minutes 30 seconds of Ephesus-side time. **Nothing destructive was done un-gated.**
The company **survived a deliberate restart** with a contiguous book of record, one
committer, its open gate intact and its consent unquestioned.

**Not true:** the crew did not **act on it** — no triage, no fix, no PR — because
the playbook its own activation record names was never written to disk. And the
briefing did not **narrate it accurately**, because no briefing could be produced at
all: the documented way to convene one creates a meeting that cannot end, and the
only brief in the run points at a file that does not exist.

**So M8 and M7 do not close on this run, and that is the correct outcome.** The
criterion is not met. It is also, for the first time, *measured* — every clause has
a verdict, a timestamp and a log row behind it, and the two that fail fail for one
concrete, fixable reason each rather than for want of evidence.

**The run succeeded as a run.** §7 of the script says a run that fails a clause is a
successful run of the script — it found something. This one found thirteen things,
of which four (Findings 3, 5, 8, 11) are the difference between a company that can
be left alone for an hour and one that cannot. None of them was visible to 4,392
green tests. Two of them (8 and 11) were diagnosed **by the product's own agents,
correctly, in writing, while the run was happening** — which is the most encouraging
result in this record and the reason the failing clauses look fixable rather than
foundational.

**The exit is the Architect's to tick, and on this record it should not be ticked.**
`docs/PROGRESS.md` is deliberately untouched.

---

## 14. Reproduction pointers

- Book of record: `C:\Users\senso\ephrun\agora\log.jsonl` — 476 rows, `seq` contiguous 1..476.
- Key rows: **243** (ingest of the failure), **255** (incident raised), **144** (the one gate), **90–104** (ledger refusals), **115–122 / 168–175** (task recovery), **308–310** (restart restore), **387–442** (the meeting that could not end), **439–440** (the bounce).
- Target: `mertefesensoy/aftershock`, branch `exit-m8-broken-test`, commit `4adb9f6`, CI run `34317920145`.
- The broken assertion: `tests/unit/exec/GeoPositionTest.cpp`, `Interpolate.ReturnsTheMidpointAtFractionOneHalf`, `EXPECT_DOUBLE_EQ(result.latitude, 5.0)` → `7.0`.
- Ephesus under test: worktree `m8-exit-run-836ebc` at `4dbd497`.
