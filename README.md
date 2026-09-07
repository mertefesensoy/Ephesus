<div align="center">

<img src="./docs/brand/ephesus-128.svg" width="96" height="96" alt="">

# Ephesus

### An agent company you govern as its architect

**A multi-agent harness that turns the terminal coding CLIs you already pay for into a
self-coordinating company of agents** — a skeleton crew that keeps your apps alive, a
front office that keeps your projects running smoothly, and a chief-of-staff you talk
to by voice. You act as the software architect; your agents build, report back, and
present their work to you.

<p><em>Electron · React · TypeScript · Pixi.js · xterm.js · node-pty</em></p>

[![CI](https://github.com/mertefesensoy/Ephesus/actions/workflows/ci.yml/badge.svg)](https://github.com/mertefesensoy/Ephesus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2E6F8E.svg)](./LICENSE)
[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-C4552D.svg)](#status)
[![Node 20](https://img.shields.io/badge/node-20-7A8B3D.svg)](./.nvmrc)

</div>

---

![Four hired agents at their desks on the Terraces floor, with a live agent terminal on the right](./docs/demo/m3-floor-seats.png)

<div align="center"><sub>A development build — four agents at their desks, one live in a real terminal. The floor is drawing procedural tiles here: the licensed sprite sheets are deliberately not in this repository.</sub></div>

## Status

**Pre-alpha. There are no releases and no installer** — signed builds are a planned
milestone (M7b.5) and have not shipped. If you are here to *use* Ephesus, the honest
answer is: not yet. If you are here to *build* it, everything runs from source today
and [contributions are welcome](./CONTRIBUTING.md).

What works right now: the Electron shell, real agent CLIs under management with
memory and mailboxes, the 2D floor, the Agora, the Odeon, the Stoa and the Gymnasium
self-improvement loop. The current milestone is **M8 — the company you can leave
running**. Package-by-package state with evidence is in
[`docs/PROGRESS.md`](./docs/PROGRESS.md); the narrative is under
[Where the build stands](#where-the-build-stands).

## Quick start

You need **Node 20.19+ or 22.12+**, a toolchain that can compile native modules
(`node-pty` and `better-sqlite3` are built on install), and at least one agent
CLI on your `PATH`.

[`.nvmrc`](./.nvmrc) says `20`, which is the major line — but fifteen packages
in the lockfile, `@electron/rebuild` among them, require `^20.19.0 || >=22.12.0`.
On an older 20.x you will get a wall of `EBADENGINE` warnings from `npm install`
and a native rebuild that may not work. Nothing refuses the install, so check
`node -v` yourself.

```bash
git clone https://github.com/mertefesensoy/Ephesus.git
cd Ephesus
npm install     # patches node-pty, syncs the pixel fonts, rebuilds natives
npm run dev     # the app, with hot reload
```

Then confirm the checkout is healthy:

```bash
npm run typecheck && npm run lint && npm test
```

All three must be green on a fresh clone. If they are not, that is a bug and we want
the issue. The full story — which engine to install, the files created in
`~/.ephesus/`, and what the shipped gate policy allows — is under
[Setting it up](#setting-it-up).

## Contributing

Ephesus is documentation-first, and its rules are unusual on purpose: the docs are the
source of truth, accepted ADRs are append-only, every pull request carries evidence,
and **a wiring seam with no test is a defect rather than a gap**.
[`CONTRIBUTING.md`](./CONTRIBUTING.md) explains all of it, including exactly what you
get from a first clone and what is deliberately missing from it.

The single most useful contribution today: **clone it, run it on a machine that is not
Windows, and open an issue about the first thing that goes wrong.**

---

## Why "Ephesus"

Ephesus was a working city: a harbor that moved goods in and out, an agora where business
was coordinated, the Library of Celsus that held its knowledge, an odeon where the council
met and heard reports, and the Temple of Artemis watching over all of it. Every subsystem
in this harness is named for the part of the city that does the same job:

| Subsystem | City metaphor | What it does |
|---|---|---|
| **Artemis** | Patron deity | The orchestrator agent — your chief of staff. The one agent you talk to. Routes work, adjudicates, escalates only what needs you. |
| **Hermes** | The messenger | The messaging/routing layer — mailboxes, delivery, speech-act messages, escalation, anti-livelock rules. |
| **The Agora** | The marketplace | The shared on-disk coordination space — roster, blackboard, task ledger, append-only event log. A git repo with a single committer. |
| **The Library** (Celsus) | Library of Celsus | The memory layer — per-agent markdown memory plus semantic recall and the company archive, backed by [MemPalace](https://github.com/mempalace/mempalace) (ADR-0016), with reflection/condensation so it never grows unbounded. |
| **The Odeon** | Council theatre | The briefing subsystem — voice standups, auto-generated slide reviews, decision memos (mini-ADRs), and live meeting mode. |
| **The Harbor** | The port | Everything in and out — GitHub, Slack/chat bridges, webhooks, mobile/remote command, shareable hires. |
| **The Herald** | Town crier | The voice interface — a Jarvis-style spoken assistant. Provider-agnostic seam; ElevenLabs first, OpenAI Realtime fallback, local engines optional. |
| **The Terraces** | Terrace houses | The 2D office floor — every agent is an avatar at a desk; stations, walking, flying envelopes. Watchability as observability. |
| **The Watch** | City walls | Safety — human gates, budgets, the circuit breaker (steer → constrain → stop), the secret broker, telemetry. |
| **The Gymnasium** | Training grounds | The self-improvement loop — the company's **primary standing mission**: observe → propose → gate → land → measure, every step Architect-gated and recorded in a permanent ledger. |
| **The Stoa** | Colonnade of the scholars | The research department — studies Architect-registered external repositories (the tagged watchlist) and files provenance-cited briefs that feed the Gymnasium (ADR-0017); company modes decide when it runs autonomously, behind a proof gate (ADR-0018). |

## What it is

Ephesus is a desktop app (Electron) that wraps a **real terminal-agent CLI** as
fully-capable agents with long-term memory, mailboxes, and desks on a 2D floor,
coordinated by **Artemis**, the one agent you talk to. It works with the subscription
you already pay for, on its limits.

**The MVP ships one engine — `claude`**
([ADR-0024](./docs/adr/ADR-0024-claude-only-for-the-mvp.md)). Engines reach the
harness through an adapter seam: a fixed conformance surface every integration has
to pass ([ADR-0009](./docs/adr/ADR-0009-engine-adapters.md)). That seam is real
rather than aspirational — two further adapters, `codex` and `gemini`, live in the
tree and are held to the same table on every run, because a conformance suite with
one implementation only proves that implementation compiles. Neither is registered,
and a hire declaring either is **refused at activation**, by name, with the reason:
neither can yet carry a granted autonomy level to its process or report a single
hook event, and a company that silently runs at one turn per wake is worse than one
that will not start. Adding an engine is an adapter and a registration, and the bar
is that suite passing for it on autonomy, notification and trust — not that it
spawns.

What makes it different from its inspiration:

1. **The architect relationship.** Agents don't just do work — they *account for it*.
   Every non-trivial decision becomes a decision memo you can approve or reject; every
   milestone produces a short slide review; Artemis delivers spoken standup briefings; and
   you can convene a live meeting with any subset of agents. See
   [`docs/sdd/SDD.md §7`](./docs/sdd/SDD.md) (the Odeon).
2. **Mission profiles.** Three first-class, pre-wired company configurations:
   - **Skeleton Crew** — a standing crew per app you own: health watching, CI
     babysitting, dependency updates, incident response with escalation to you.
   - **Front Office** — the outward face of a project: issue/PR triage, drafted replies,
     docs and changelog upkeep, release preparation.
   - **Recursive Improvement** — the self-improvement mission as a switchable crew
     (ADR-0019): you present repositories by URL, the Stoa studies them, approved
     proposals come back as pull requests from the company's own GitHub identity
     (ADR-0020) — and you merge.
3. **A voice-first chief of staff.** The Herald gives Artemis a refined, Jarvis-style
   spoken presence: wake word, barge-in, briefings on demand, approvals by voice.
4. **A real org.** Departments, roles, hiring templates, agent performance reviews, and
   retros — the "little company" made explicit rather than emergent.
5. **It improves itself — under governance.** The company's primary standing mission is
   its own improvement (ADR-0015): improvement proposals rise from the company's own
   operating records, pass through the same memo/gate machinery as any other change,
   land with a declared success metric, and are measured — with every outcome, including
   rejections and rollbacks, kept in the [Gymnasium ledger](./docs/gymnasium/LEDGER.md).
   The loop starts *now*, during the build phase, and carries into the running system
   unchanged in shape.

## How it works (one screen)

```
                 you ──── voice (Herald) / text ────►  ┌─────────────┐
                                                       │   ARTEMIS   │ orchestrator
                 ◄── briefings · reviews · memos ────  │ (chief of   │ roster · routing
                          (Odeon)                      │   staff)    │ adjudication
                                                       └──────┬──────┘
                                                              │ assigns · routes · escalates
                      ┌───────────────────────┬───────────────┴────────┐
                      ▼                       ▼                        ▼
                ┌───────────┐  Hermes   ┌───────────┐   Hermes   ┌───────────┐
                │  agent A  │ ────────► │  agent B  │ ─────────► │  agent C  │
                │ CLI + mem │  message  │ CLI + mem │   message  │ CLI + mem │
                └───────────┘           └───────────┘            └───────────┘
                      └────── the Agora: blackboard · tasks · log · registry ──────┘
                      └────── the Library: memory.md × N + semantic index ─────────┘
```

1. **You describe intent to Artemis** — by voice or text. Artemis decomposes it, checks
   the roster, and assigns work as self-contained task specs.
2. **Agents collaborate through Hermes over the Agora** — plain files in a local git
   repo. Agents write only to their own `outbox/`; the harness router delivers into
   recipients' `inbox/`. Only the main process ever commits (no `index.lock` wars).
3. **Agents keep themselves running** — a `Stop`-hook autonomy loop drains each agent's
   inbox when it finishes a turn, so mail never waits for a human.
4. **The company reports back** — decision memos queue for your sign-off, milestone
   slide reviews archive in the Odeon, and Artemis briefs you aloud on schedule or on
   demand.
5. **Everything is watchable** — avatars on the Terraces floor, live terminals, the
   activity log, budgets and the tool waterfall.

## Setting it up

Ephesus runs a company of real terminal-agent CLIs on your machine. It needs
three things from you and creates the rest itself.

**1. The toolchain.** Node 20 (`.nvmrc`), then:

```bash
npm install        # postinstall patches node-pty and rebuilds native modules
npm run dev        # the app, with hot reload
```

**2. An engine you are logged into.** The MVP ships Claude only
([ADR-0024](./docs/adr/ADR-0024-claude-only-for-the-mvp.md)): install the
`claude` CLI and sign in.

```bash
claude auth status   # what Ephesus asks before it hires anybody
claude auth login    # if that says you are not logged in
```

Ephesus asks this itself at every spawn. An agent whose engine has no session
is shown as **needs-login** with the command to run, rather than started and
left sitting at a login prompt while its card claims it is working.

**3. Nothing else is required** — though the first boot will tell you about one
optional extra. Semantic recall uses [MemPalace](https://github.com/mempalace/mempalace)
(ADR-0016), and without it the Library reports two degradations naming
`pip install mempalace` and falls back to a full-text rung. That is the harness
working as designed — a missing optional is disclosed, never silently absent —
and you can ignore it or install it.

On first launch the harness creates `~/.ephesus/` and
writes the files it needs, then tells you it did:

| File | What it decides | If you delete it |
|---|---|---|
| `config.json` | Window bounds, company mode | Recreated with defaults |
| `gate-policy.json` | The company-wide autonomy ceiling and which classes are held for a human | Everything is held and every profile is clamped to `manual`, reported as a degradation |
| `authority.json` | What Artemis may decide without you (FR-5.5) | She decides nothing and every routine call queues for you |
| `github-app.json` | The company's GitHub identity (optional, ADR-0022) | No company identity; the activation screen says which grants the broker cannot supply |

`~/.ephesus/` is **yours**. Ephesus writes a file there only when it is absent
and never edits one you already have, so anything you change stays changed.

**To run against a different home**, set `EPH_HOME` to any directory:

```bash
EPH_HOME=/tmp/eph-scratch npm run dev
```

```powershell
$env:EPH_HOME = "$env:TEMP\eph-scratch"; npm run dev
```

That is how you get a genuinely clean company without touching the one you
already have — useful for trying something out, and required by
[the M8 exit script](./docs/EXIT-M8.md).

**And whatever goes wrong, read `DIAGNOSIS.md` in that home first.** The
harness rewrites it every minute and once more on the way out: what is working,
what is not and why, and — the part that matters — what has simply never been
exercised, which is not the same as fine.

**4. Say go.** Nothing is hired until you do. On first launch the app shows a
banner above everything else saying the company is not working yet, and
naming exactly what starting it would do: which agent gets hired on which
engine, that its turns spend tokens against **your** subscription, what the
company-wide daily ceiling is — or that there is none — and which schedules
start and how often. Press **START THE COMPANY** and it begins in that same
window; no restart, and you are never asked again.

Leave it closed and everything else stays readable: the panels, the book of
record, the settings. Nothing runs, and the status strip says so rather than
looking like a company that has finished its work.

**Stopping it.** Stop Electron by process, not by the `npm run dev` wrapper.
Killing the wrapper leaves the Electron children alive, and a second
`npm run dev` then runs a second harness against the same `~/.ephesus/` — two
instances, one book of record, two committers where the design allows one
([ADR-0004](./docs/adr/ADR-0004-agora-single-committer.md)).

```powershell
Get-Process electron | Where-Object { $_.Path -like "*ephesus*" } | Stop-Process -Force
```

```bash
pkill -f 'electron.*ephesus'
```

### What the shipped gate policy allows

The ceiling ships at `autonomous` so a profile's own declaration governs, with
every irreversible class held at `supervised` — attempted with you able to see
and stop it, never silently:

```
destructive · prod-facing · scope-change · outbound · spend    supervised
needs-human                                                    manual
everything else                                                the profile decides
```

Autonomy composes **stricter-wins**: a profile can only ever be more cautious
than this file, never less. Edit `gate-policy.json` to tighten the whole
company at once.

### Your first crew

The app is running and nobody is doing anything. That is correct — Ephesus
ships with no crew, because which agents exist and what they are allowed to do
is a decision, not a default. You get from here to a company watching your
repository in four steps.

**1. Check the orchestrator came up.** The agent dock along the bottom should
show **artemis**. She is the only agent hired at boot; she routes work and
scribes the board, and she does nothing on her own until there is something to
route. If she is not there, the status strip will say why — most often
`claude auth status` reporting no session.

**2. Open PROFILES.** A *profile* is a mission bundle: the agents it hires,
what each may do, and what wakes them
([ADR-0012](./docs/adr/ADR-0012-mission-profiles.md)). Two ship with the app:

| Profile | What it is for |
|---|---|
| **Skeleton Crew** | watches a repository's CI, turns failures into incidents, triages them and reports back |
| **Front Office** | drafts outbound messages and holds them at a gate until you approve |

Start with Skeleton Crew. It is the one M8's exit review is written around.

**3. Point it at a checkout.** Choose the profile, then give it the path to a
local clone of the repository you want watched — a real one, with CI that runs
on push. The activation screen then shows you the whole plan **before anything
happens**: which agents get hired, what each may do without asking, which
triggers get armed, which declared secrets the broker cannot supply, and which
repository it would watch. Read it. It is the last point at which nothing has
started.

You need `gh` installed and authenticated (`gh auth status`) for the repository
half to work at all — that is how Ephesus reads CI runs, issues and pull
requests. Without it the crew hires fine and ingests nothing, which the app
reports as a degradation rather than as silence.

**4. Activate.** The crew is hired, each agent in its own git worktree so
nothing runs in your own checkout, and each on its own engine install so no
agent inherits your CLI's memory, plugins or hooks. From here on, a CI failure
on the watched repository becomes an incident, the incident is routed to whoever
is on call for it, and what they report comes back to the **INCIDENTS**
section at the bottom of the **PROFILES** tab (it lives there rather than on
a tab of its own because an incident belongs to a profile instance) —
including every refusal, shown as a refusal.

To take it all down: deactivate the instance from PROFILES. To watch a second
repository, activate the same profile again against a different checkout.

### Watching a repository

A mission profile is activated against a target repository from the **Profiles**
tab. The activation screen shows what would happen before anything does: which
agents get hired, what they may do, which triggers get armed, which declared
secrets the broker cannot actually supply, and **which repository it would
watch**.

You do not have to tell it which repository that is — Ephesus reads the target
checkout's git remote and says what it found and where it found it. Two cases
where it will not guess, and says so on the screen instead:

| What it finds | What it does |
|---|---|
| one GitHub remote | watches that repository |
| a fork (`origin` and `upstream` at different repositories) | refuses, names both, asks you to pick |
| no remote, or no GitHub remote | says the instance will watch nothing, and why |

In either of those, type the `owner/repo` into the repositories box before
reading the plan. Whatever the bundle's own `harbor.json` declares wins over the
checkout; what you type wins over both.

An instance that comes up watching nothing still hires its crew and arms its
schedules — but it can ingest no CI run, issue or pull request, so it will raise
no incident, and that shows up as a degradation rather than as silence.

## Documentation map

This repository is a complete, self-contained documentation suite. Read in this order:

| Document | What it answers |
|---|---|
| [`docs/srs/SRS.md`](./docs/srs/SRS.md) | **Software Requirements Specification** — actors, use cases, functional requirements (FR-1…FR-11), non-functional requirements, acceptance criteria. *What must the system do?* |
| [`docs/adr/`](./docs/adr/README.md) | **Architecture Decision Records** — 15 ADRs covering every load-bearing decision, each with context, options considered, and consequences. *Why is it built this way?* |
| [`docs/sdd/SDD.md`](./docs/sdd/SDD.md) | **Software Design Description** — component architecture, data models, on-disk formats, message schema, IPC contracts, sequence flows. *How is it built?* |
| [`docs/design/UI-DESIGN.md`](./docs/design/UI-DESIGN.md) | **Visual & interaction design** — design tokens, the floor, panels, typography, motion rules. |
| [`docs/design/VOICE-DESIGN.md`](./docs/design/VOICE-DESIGN.md) | **Voice & conversation design** — the Herald's persona, wake word, barge-in, briefing scripts, error behavior. |
| [`docs/ENGINEERING-STANDARDS.md`](./docs/ENGINEERING-STANDARDS.md) | Coding standards, repo conventions, review rules, security rules, definition of done. |
| [`docs/TEST-STRATEGY.md`](./docs/TEST-STRATEGY.md) | Test pyramid, what gets unit/integration/E2E coverage, agent-behavior evals, CI gates. |
| [`docs/IMPLEMENTATION.md`](./docs/IMPLEMENTATION.md) | Phased implementation plan (M0–M7) with exit criteria, risk register, and build order. |
| [`BUILD-PROMPT.md`](./BUILD-PROMPT.md) | Ready-to-paste prompt that directs a coding agent to implement this design milestone by milestone, doc-grounded and verification-gated. |
| [`docs/AUTOMATION.md`](./docs/AUTOMATION.md) | The Claude Code automation installed in this repo (hooks, skills, subagents, CI) — what exists, why, and what's deferred. |
| [`docs/gymnasium/LEDGER.md`](./docs/gymnasium/LEDGER.md) | The self-improvement ledger — every Gymnasium proposal from evidence to measured outcome. |
| [`docs/stoa/WATCHLIST.md`](./docs/stoa/WATCHLIST.md) | The research watchlist — the external sources the Architect has registered for study, and the briefs they produce. |

## Where the build stands

**M8's thirteen packages have all landed — and M8 has not closed.** M6 and M7
landed the spoken company and the two outward missions; M8 is the hardening
milestone that runs before shipping, because the suite was green while Closing
Time had never once run in the shipped app, the standup read the oldest 500 log
entries, and the dock showed an overnight run's first 300 events. Its exit is
not a checklist: it is [SRS §6.1](./docs/srs/SRS.md)'s one-hour company test on
a real repository, run by **a developer who is not the author, from a clean
clone, following only this README**, and surviving a deliberate restart
mid-run. That run has not happened, so the row is open — as M7's own exit has
been since 2026-09-01, for the same reason. The script for it is
[`docs/EXIT-M8.md`](./docs/EXIT-M8.md).

<!-- landed: M8.0 M8.1 M8.2 M8.3 M8.4 M8.5 M8.6 M8.7a M8.7b M8.8 M8.9 M8.10 M8.11 M8.12 M8.13
     Checked by scripts/check-readme-current.cjs against docs/PROGRESS.md: every
     package ticked there must be listed here, and listing one is a claim that
     the prose below actually says what it did. The check catches the oversight
     — a package landing while nobody touched this file — which is the failure
     that made this section two milestones stale at M8.4 and three packages
     stale again by M8.9. It cannot catch someone editing this line without
     writing the sentence, and is not meant to. -->
Landed so far: a coverage baseline and the seam rule that enforces it (a wiring
seam with no test is a defect, not a gap); a quit path that actually runs, with
one door to the renderer and one ordered, isolated shutdown sequence; a
degradation channel where every give-up is visible, durable and countable; the
log-derived surfaces reading the whole book instead of its oldest 500 entries;
the setup cliff — the config files the harness needs are now created,
documented and reported, and an engine with no session says so instead of
pretending to work; and a mission activated against a repository now actually
watches it, because the checkout is asked which repository it is rather than a
bundle that ships an empty list being the only source of the answer.

Since then: **every hire works in its own git worktree**, so a crew no longer runs
git operations and file edits concurrently in your checkout — a spawn that cannot
be isolated is refused rather than quietly falling back into it — and a breaker
stop at the top rung now outlives the process it stopped, so an exhausted budget
stops instead of cycling. **Every hire also runs its own engine install**, with
its own config directory: a hired agent does not inherit your CLI's memory,
plugins, hooks or MCP servers, and the harness is the only author of the hooks
that install runs. What a target repository legitimately offers — its skills and
subagents — the harness re-supplies by name, because a hire template declares
what it may read. And **a restart no longer silently un-hires the company**:
active missions, open gates with their settled verdicts, the trigger clock and
the drafts an outbound gate is holding all come back, with anything that could
not be restored reported rather than absent. The agents themselves are not
respawned automatically — engine session recovery is the follow-on — so you
reactivate, and the company tells you that is what happened.

And most recently, **the work the company does is something you can see**. An
incident the crew was handed now has a surface: what was raised, who is on call,
what they reported in their own words, whether anybody checked the diagnosis —
and, above all, **every refusal, shown as a refusal rather than as an absence**.
That last part is why the panel was worth building: on the first repository this
was pointed at, twelve of twenty-one triage attempts were refused and every
root-cause verdict the company ever received was thrown away for being too long,
and all of it was written down where nobody would ever look. Those two refusals
now say what rule they are enforcing and what to do about it, instead of
answering an agent's plain English with a JSON parse error. The status strip also
learned to tell a hung harness from an idle one: it asks the main process
whether it is still there, on a deadline rather than a promise, because a
harness whose event loop is stuck never answers and never fails either.

And now **the company survives being left running**. The book of record rotates:
`log.jsonl` is sealed into numbered archive segments once it grows past a few
megabytes, which is a rename and nothing else — the segments and the live file
concatenated are byte for byte the file that used to be there. **No surface sees
less.** That was the whole design constraint, because the incident board drops an
incident whose opening row it cannot find, so a rotation that quietly moved
history out of view would have emptied the panel rather than aged it; every
reader still folds the entire history, and the ones that only ever wanted the
newest few rows stopped paying for all of it — on a 28 MB log, the Activity
feed's read went from 200 ms to 26 ms, on the same loop that carries your agents'
keystrokes. Alongside it: a spawn no longer re-reads a week of transcripts on
every tick to work out what it has spent, one agent with an oversized memory no
longer stops reflection for everyone whose name sorts after it, the roster
finally records which mission profile hired each agent, and **mail addressed to
an agent that is no longer running is now visible as such** — it is neither
bounced nor dropped, because an agent can come back, but it is no longer a
silence.

And most recently, **the front door says what actually ships**. Ephesus registered
three engines and advertised five, two of which have never had an adapter at all.
That gap was not a missing feature but a set of silent wrong answers: on either
partial adapter the autonomy ceiling you granted was dropped on the floor; with no
Stop hook there was no continuation loop, so the agent stopped after one turn; and
with no hook stream at all its avatar asserted a confident `idle` for it for ever.
None of it failed — it just quietly happened, and the activation screen printed
"on codex" without a word. A hire on any engine but `claude` is now **refused at
activation**, naming the engine, the reason and the one edit that fixes it. The two
partial adapters stay in the tree, unregistered, because they are what keeps the
adapter seam honest. And the hook grade `pty-heuristic`, which named a mechanism
nobody ever built, is now called `none`, which is what it is.

And finally, **the company asks before it starts.** Booting Ephesus used to hire
an agent: `artemis.start` ran unconditionally at the end of boot, the scheduler's
first tick fired sixty seconds later, and nothing anywhere asked anybody first —
on a machine where spending is unbudgeted by default and the tokens are yours.
Now a first launch shows what starting the company would do, in the specifics of
*your* configuration, and does nothing until you say go; the answer is
remembered, and a withheld company is reported as a state rather than looking
like one that has finished its work. Consent covers the schedules too, not only
the hire — the two are different products, and a gate on the hire alone leaves
the standup, the retro and the metric check firing on the first tick anyway.
Alongside it, the README finally covers the gap between "the app booted" and "a
crew is watching my repo", the book of record's readers no longer lose a row to
a duplicate sequence number left behind by two harness instances sharing one
home, and [`docs/EXIT-M8.md`](./docs/EXIT-M8.md) is a script somebody who has
never seen this repository can follow, with the place each acceptance clause's
evidence lands named by hand.

And, added after the first attempt at that exit run: **the company writes down
what is wrong with it.** Every harness home now carries a `DIAGNOSIS.md`,
rewritten at boot, every minute, and once more on the way out. It says what is
working, what is broken and why, what is waiting on you — and, the part that
earns it, what has simply **never been exercised**, which is not the same as
fine. Nothing is stored to produce it: it is a reading of the degradation
channel and the book of record, both of which already existed, and it keeps
writing even while the company itself is stopped, because a diagnostic that
stops when its subject stops is not a diagnostic. The point is that when you
come back to a machine you left running — or hand it to somebody else — the
first file they open already answers the question, instead of them guessing from
a quiet screen.

That same exit attempt found this README sending people to two panels that do
not exist, and a Node version the lockfile does not accept. Both are fixed here,
which is what the exercise is for.

M7's own exit (SRS §6.1 on a real repository) remains open and is independent
of M8. The same run is owed to both.

---

*The previous milestone's story:*

**M5b complete — the learning company, on a licensed floor.** The Stoa is in
the product: repositories the Architect registers by URL on the **reading
desk** (tagged, licensed, pinned), a researcher plan that is read-only and
secret-free *by construction*, briefs whose every finding must cite a path at
the pinned commit or die before a human sees them, and proposals that must
cite the brief they descend from. Company modes gate autonomy: `improving`
cannot be switched on until the §6.9 proof gate reads its evidence off the
ledger, the mode is visible everywhere, and a rung-3 breaker stop on
improvement work reverts it. The floor now paints from the purchased LimeZu
packs — [see it](./docs/demo/m5b-floor-limezu.png) — with the sheets kept out
of the repo per licence and the credit on the status strip.

```
EVIDENCE registered: src-munder-difflin pin=b91a49f license=MIT
EVIDENCE plan: commit=b91a49f readOnly=true envGrants=[]
EVIDENCE brief archived: RB-001 "Closing time and the hook-return…"
EVIDENCE ledger: GYM-001 … status=proposed cites=RB-001
```

The M5b demo view is in [`docs/demo/`](./docs/demo/): the reading desk and a
brief on screen (`m5b-stoa-desk` · `m5b-stoa-brief`), the three cycle captures
(`m5b-cycle-1/2/3`), the LimeZu floor, and — from the close-out audit — the
research cycle re-run against a **real, remotely-verifiable pin**
([`m5b-cycle-real-source.txt`](./docs/demo/m5b-cycle-real-source.txt)): the
audit caught the original demo citing a commit that existed in no repository,
the record was amended, and the chain re-proven end to end. Four in-milestone
defects were found by running the demo; the audit added five more fixes, every
one with a named regression test. Evidence trail in
[`docs/PROGRESS.md`](./docs/PROGRESS.md); full record in
[the M5b record](./docs/implementations/2026-08-28-m5b-stoa-and-modes.md).

Next: **M6 — the floor's face + the Herald** (citizens at the MD-grade §5.1
spec, stations that are facts, act-colored envelope flights — then the spoken
company). The art spec landed as UI-DESIGN v2 at the M5b close.

---

*The previous milestone's story:*

**M5 complete — the accountable company.** A `review:deck` task is
*mechanically unclosable* until its deck is archived; a new dependency is held
at the choke point until a memo exists and is verdict-ed — Artemis decides
within her delegated classes and **countersigns**, everything else queues for
the Architect, and a rejection reverses the action. Briefings are compiled
facts first, narrative second: a sentence without a resolvable ref refuses the
whole brief. Meetings enforce turn order (an early answer is held, not lost)
and file their minutes; the org layer computes every metric from `log.jsonl`
alone and writes a weekly retro that decides nothing. And the Gymnasium runs
governed: proposals without a falsifiable metric never reach a human,
verdicts are Architect-only, authority-widening is refused before any
approver could say yes.

```
DEMO 1 close before the deck: todo      ← refused; the task did not move
DEMO 1 close after the deck:  done
DEMO 2 action held by: new-dependency
DEMO 2 rejection reverses the action: denied
DEMO 3 every sentence carries refs: true
DEMO 4 held (said early): [ agent.scribe ]
```

The demo view is in [`docs/demo/`](./docs/demo/): the six panel screenshots
(`m5-briefs-tab` · `m5-decks-tab` · `m5-memos-tab` · `m5-odeon-meeting` ·
`m5-org-metrics` · `m5-gymnasium`), a real archived deck
([`m5-deck-artifact.html`](./docs/demo/m5-deck-artifact.html)), and
[the retro report](./docs/demo/m5-retro-report.md) generated from this
company's own records. Alongside M5, the **Stoa** ran its first full cycle:
a research brief over the upstream inspiration ([RB-001](./docs/stoa/briefs/RB-001-munder-difflin-orchestration-autonomy.md))
became two Architect-approved, landed improvements (hook-boundary steer,
closing time) — the ledger's first proof-gate evidence. M5 was closed by the
two-agent audit (execution + design conformance); it re-proved every exit
criterion and caught one real ledger-column defect, fixed with regression
tests. Evidence trail in [`docs/PROGRESS.md`](./docs/PROGRESS.md); full
record in [the M5 record](./docs/implementations/2026-08-28-m5-accountable-company.md).

## License & lineage

Ephesus is an original work inspired by the MIT-licensed
[Munder Difflin](https://github.com/chaitanyagiri/munder-difflin). Architectural patterns
are reused with attribution (see each ADR's "Prior art" section); no upstream code or
assets are vendored. The Jarvis-style voice is a *style* (a composed, understated British
assistant persona), not a clone of any actor's voice or any studio's character.


---


> [!NOTE]
> **Inspired by [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin)** — the
> "office of your clones" agent harness. Ephesus reuses its strongest architectural ideas
> (two data planes, a file-based hive with a single git committer, the Stop-hook autonomy
> loop) and re-imagines the product around a different thesis: *you are the architect of a
> small company, and the company reports to you* — by voice, in briefings, in design
> reviews, and in decision memos.


