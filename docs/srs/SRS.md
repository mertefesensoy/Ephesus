# Ephesus — Software Requirements Specification (SRS)

**Version:** 1.0 · **Status:** Approved for implementation · **Owner:** the Architect (project owner)
**Conforms loosely to:** IEEE 29148, trimmed to what a one-architect project actually needs.

---

## 1. Introduction

### 1.1 Purpose
This SRS defines the requirements for **Ephesus**, a desktop multi-agent harness that
wraps terminal coding-agent CLIs into a coordinated "company" of agents, governed by a
single human acting as software architect. It is the contract between the Architect and
any implementing engineer (human or agent). The companion SDD describes *how* these
requirements are met; ADRs record *why* the load-bearing choices were made.

### 1.2 Scope
Ephesus SHALL:
- Spawn, attach, visualize, and control multiple terminal-agent CLI sessions
  (Claude Code first; Codex, Gemini CLI, Grok, OpenCode, and custom commands after).
- Coordinate agents through a file-based messaging layer (**Hermes**) over a shared
  on-disk coordination space (**the Agora**) with persistent per-agent memory
  (**the Library**).
- Provide a single orchestrator agent (**Artemis**) as the human's primary interface,
  with a voice front-end (**the Herald**).
- Make the company *accountable*: standup briefings, milestone slide reviews, decision
  memos with human sign-off, and live meetings (**the Odeon**).
- Ship three pre-wired mission profiles: **Skeleton Crew** (keep the Architect's apps
  alive), **Front Office** (run a project's outward-facing operations), and
  **Recursive Improvement** (the standing self-improvement mission packaged as a
  profile: Stoa research over Architect-presented repositories, gated proposals,
  delivery as Architect-merged pull requests — ADR-0019).
- Provide safety controls: human gates, budgets, a circuit breaker, and a secret broker
  (**the Watch**).
- Support remote command: chat bridge + push briefings + remote approvals (**the Harbor**).
- Pursue **self-improvement as the company's primary standing mission** (**the
  Gymnasium**): the system SHALL continuously look for ways to improve itself — its
  playbooks, prompts, tooling, docs, tests, and code — through a governed
  observe → propose → gate → land → measure loop (ADR-0015).
- Feed that loop **external evidence** (**the Stoa**): study Architect-registered
  repositories and turn what is learned into provenance-cited research briefs
  (ADR-0017); and expose an explicit, Architect-only **company mode** that turns
  standing autonomous self-improvement on only after a recorded proof gate
  (ADR-0018).

Ephesus SHALL NOT (v1):
- Replace the underlying agent CLIs (they remain the runtime).
- Run agents on remote machines over SSH.
- Provide multi-user/team access; it is a single-operator system.
- Train or fine-tune models.

### 1.3 Definitions
| Term | Meaning |
|---|---|
| **Architect** | The human owner-operator of the system. The only human actor. |
| **Agent** | A real CLI process (e.g. `claude`) in a PTY, with identity, memory, mailbox, and an avatar. |
| **Artemis** | The privileged orchestrator agent; the Architect's proxy and the company's chief of staff. |
| **Hermes** | The message routing subsystem: outbox → router → inbox delivery with speech-act messages. |
| **Agora** | The on-disk shared coordination space (git repo, single committer): registry, blackboard, task ledger, event log. |
| **Library** | The memory subsystem: per-agent `memory.md` + shared semantic index + reflection. |
| **Odeon** | The accountability subsystem: briefings, slide reviews, decision memos, live meetings. |
| **Herald** | The voice interface: STT + TTS + conversation policy, provider-pluggable. |
| **Harbor** | External integrations: GitHub, chat bridges, webhooks, remote command. |
| **Watch** | Safety subsystem: gates, budgets, circuit breaker, secret broker, telemetry. |
| **Terraces** | The 2D Pixi.js office-floor visualization. |
| **Mission profile** | A pre-wired company configuration (roles + triggers + playbooks) for a recurring mission. |
| **Decision memo** | A structured mini-ADR filed by an agent for a non-trivial choice, requiring Architect review. |
| **Hire** | A role template (name, engine, system prompt, skills, budget) that can be spawned as an agent. |
| **Gymnasium** | The self-improvement subsystem: the governed loop and permanent ledger through which the company improves itself (ADR-0015). |
| **Improvement proposal** | A single scoped, evidence-backed change to the company itself, carrying a measurable success metric and a rollback; filed to the Gymnasium ledger. |
| **Stoa** | The research subsystem: studies Architect-registered external sources and files provenance-cited research briefs as Gymnasium evidence (ADR-0017). |
| **Watchlist** | The Architect-curated registry of external sources the Stoa may study; each entry tagged with what to learn, its license, and a pinned commit. |
| **Research brief** | A single-source findings artifact whose every claim cites `repo@commit` + file path; admissible Gymnasium evidence, never a change itself. |
| **Company mode** | The Architect-set operating mode: `directed` (default — improvement cycles run on demand) or `improving` (the Stoa/Gymnasium cadences run autonomously; approval authority unchanged) (ADR-0018). |
| **Proof gate** | The recorded ledger evidence required before `improving` can first be enabled (§6.9). |
| **Company identity** | The single GitHub machine account the harness acts through (ADR-0020): agent PRs are authored by it with per-agent co-author trailers; it can never merge, and it is never the Architect's identity. |

### 1.4 References
- Munder Difflin `HIVE.md`, `SPEC.md`, `DESIGN.md` (upstream inspiration; patterns credited in ADRs).
- Claude Code hooks reference (`Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `stop_hook_active`).
- Stanford *Generative Agents* (Park et al., 2023); Hearsay-II blackboard; FIPA-ACL speech acts.

---

## 2. Overall description

### 2.1 Product perspective
Ephesus is a new, self-contained Electron application. It sits *above* agent CLIs the
Architect already licenses, and *below* the Architect's judgment: it never takes
critical actions (spend, destruction, scope) without an explicit gate. Two data planes
feed one renderer (ADR-0002): a **terminal plane** (node-pty byte streams) and an
**event plane** (CLI lifecycle hooks → local socket → router/state).

### 2.2 User class
One user class: the Architect — an expert software engineer who wants leverage, not a
toy. Implications: keyboard-first UX, no dumbed-down abstractions, raw terminals always
one click away, every automation inspectable and reversible.

### 2.3 Operating environment
- macOS (primary), Windows and Linux (supported). Node 18+, C/C++ toolchain for node-pty.
- At least one supported agent CLI on `PATH`.
- Optional: ElevenLabs and/or OpenAI API keys (voice), local LLM endpoints, GitHub CLI.

### 2.4 Constraints
- **C-1** Agents communicate only via files they own; only the main process commits to git (ADR-0004).
- **C-2** No cloud backend of our own: all state is local; external calls are only to providers the Architect configured.
- **C-3** Secrets never transit the renderer and are never readable back out of the broker (write-only) (ADR-0010).
- **C-4** The harness must degrade gracefully: no voice keys → text-only; no semantic index → markdown memory; no GitHub CLI → Harbor features off, floor still works.

### 2.5 Assumptions
- The Architect's CLI subscriptions impose their own rate/usage limits; Ephesus schedules around them but cannot lift them.
- Agent CLIs expose a hook or wrapper mechanism sufficient to detect lifecycle events; where they don't, PTY-output heuristics are an accepted fallback with reduced fidelity.

---

## 3. Use cases

Actors: **Architect** (human), **Artemis** (orchestrator agent), **Worker** (any
non-orchestrator agent), **Harbor peer** (GitHub/Slack/webhook counterparty),
**Scheduler** (internal clock/trigger service).

### UC-01 — Spawn an agent from a hire template
**Actor:** Architect. **Goal:** a new worker exists on the floor.
1. Architect opens *Hire* and picks a role template (or imports a shared hire link; import only pre-fills — a human always confirms the spawn).
2. Architect confirms engine, working directory, budget, and permission mode.
3. System creates the agent's Agora home (`identity.md`, `memory.md`, mailboxes), spawns the CLI in a PTY with hooks wired, registers it in the roster, seats its avatar.
4. Artemis is informed (`inform` message) and updates the org chart.

**Postcondition:** agent is `idle` on the floor, hive-aware, visible in the roster.
**Alternate 3a:** CLI binary missing → system offers to run the installer in the visible terminal and continues on success.
**Alternate 2a:** worktree isolation requested → agent gets its own git worktree of the target repo.

### UC-02 — Delegate a goal through Artemis
**Actor:** Architect. **Goal:** work happens without micromanagement.
1. Architect tells Artemis (voice or text): "Get the flaky checkout test fixed and ship 1.4.2."
2. Artemis decomposes into tasks in the ledger, selects assignees by capability from the roster, and sends each a `request` with a self-contained spec.
3. Workers execute; inter-agent questions flow through Hermes; Artemis adjudicates routine ones itself.
4. On completion Artemis verifies results against the ledger, updates the blackboard, and reports (Odeon debrief).

**Postcondition:** ledger tasks `done` with result refs; a debrief exists.
**Alternate 3a:** a task requires a critical action → UC-08.
**Alternate 3b:** two agents ping-pong past the hop cap → Hermes escalates to Artemis, who resolves or splits the task.

### UC-03 — Watch the floor and inspect an agent
**Actor:** Architect.
1. Architect watches avatars: walking = tool in use at a station; envelope = message in flight; wave = blocked on human.
2. Architect clicks an avatar → side panel with live terminal (xterm.js), files, git history, memory, and message threads.
3. Architect types directly into the agent's terminal (subject to the message-queue rule: unsent Architect text holds Hermes deliveries to that agent).

### UC-04 — Morning standup briefing (voice)
**Actor:** Scheduler → Artemis → Architect.
1. At the configured time, the Scheduler wakes Artemis with the standup trigger.
2. Artemis compiles the brief from the event log, ledger, budgets, and overnight Harbor traffic: what finished, what's blocked, what needs a decision, spend vs budget.
3. The Herald speaks the brief; the same content renders as a card in the Odeon tab.
4. Architect interrupts at any point (barge-in) to drill in or issue directives; directives become ledger tasks.

**Alternate 3a:** Architect away → brief is delivered as a push message via the Harbor with a link/summary; voice replay available later.

### UC-05 — Milestone slide review
**Actor:** Worker → Architect.
1. A worker completes a ledger task flagged `review:deck`.
2. The worker generates a short HTML slide deck from the review template: goal, what was built, decisions made, trade-offs, evidence (diffs/screenshots/test output), open questions.
3. The deck is archived in the Odeon; Artemis queues it for the Architect with a spoken one-line summary.
4. Architect opens the deck in-app; approves, or files comments that become follow-up tasks.

### UC-06 — Decision memo review (architect sign-off)
**Actor:** Worker → Architect.
1. Mid-task, a worker faces a non-trivial choice matching memo policy (new dependency, schema change, public API change, security posture change).
2. The worker files a decision memo (structured mini-ADR: context, options, recommendation, blast radius) into the Odeon queue and continues on non-dependent work, or parks if blocked.
3. Artemis triages: memos within its delegated authority it decides itself and countersigns; the rest surface to the Architect (badge + optional voice note).
4. Architect approves / rejects / amends. The verdict is delivered back as a Hermes message; the memo is archived as an immutable record.

**Postcondition:** an auditable decision trail exists; agent proceeds accordingly.

### UC-07 — Live meeting in the Odeon
**Actor:** Architect + selected agents.
1. Architect convenes a meeting: picks attendees, states an agenda line.
2. The floor visualizes attendees walking to the Odeon room; a meeting panel opens.
3. Architect asks questions (voice/text); Artemis chairs — it routes each question to the right attendee, enforces turn order, and keeps minutes.
4. Attendees answer in turn (their replies stream into the meeting panel; the Herald can read them aloud).
5. On close, minutes + action items are written to the blackboard and the ledger.

### UC-08 — Critical-action escalation (human gate)
**Actor:** Worker → Artemis → Architect.
1. A worker needs a gated action (spend above threshold, destructive op, scope change, prod deploy).
2. The request routes to Artemis (`needs_human` flip). Artemis packages context: what, why, blast radius, rollback.
3. The gate surfaces natively in Artemis's session and in the approvals UI; remotely it is pushed via the Harbor.
4. Architect approves/denies (click, keyboard, voice confirmation with explicit repeat-back for destructive ops).

**Postcondition:** the action proceeds or is refused; either way the event log records the full chain.

### UC-09 — Skeleton Crew: incident response
**Actor:** Harbor peer (monitor/webhook) → agents → Architect.
1. A health check or CI webhook signals a failure in one of the Architect's apps.
2. The Skeleton Crew profile's on-call agent picks it up: triages, reproduces, attempts the playbook fix (restart, rollback, patch + PR).
3. If the playbook resolves it: `inform` to Artemis; the incident is logged and appears in the next standup.
4. If not, or the fix requires a gated action: UC-08 escalation with an incident summary; the Herald can announce a severity-1 aloud immediately.

### UC-10 — Front Office: issue and PR triage
**Actor:** Harbor peer (GitHub) → agents.
1. New issues/PRs flow into the Front Office queue.
2. The triage agent labels, deduplicates, drafts replies, and routes real bugs to the ledger; a docs agent keeps changelog/docs in sync with merged work.
3. Outbound comments above a configured autonomy level require Architect approval (batched into the standup by default).

### UC-11 — Remote command
**Actor:** Architect (away from desk).
1. Architect messages the bridge (chat) or triggers a briefing.
2. Artemis answers with status, accepts directives, and forwards gate requests as approvable messages.
3. All remote directives are echoed in the desktop activity log with a `remote` source tag.

### UC-12 — Agent performance review & retro
**Actor:** Scheduler → Artemis → Architect.
1. On a cadence (e.g. weekly), Artemis compiles per-agent metrics: tasks completed, rework rate, memo quality, budget efficiency, escalation rate.
2. Artemis proposes actions: adjust a system prompt, change a role's model, retire or split a role.
3. Architect reviews in the org panel; accepted changes update hire templates (versioned).

### UC-13 — Gymnasium self-improvement cycle
**Actor:** Scheduler/Artemis → Worker → Architect. **Goal:** the company gets measurably better at its job.
1. On the Gymnasium cadence (or when a review/retro/breaker report surfaces recurring friction), Artemis mines the company's records — org metrics, `log.jsonl`, breaker trips, memo-rejection patterns, budget burn, drift audits — for improvement candidates.
2. Artemis (or an assigned worker) files **one** improvement proposal: evidence with refs, the concrete change, cost/risk, a measurable success metric with a measurement window, and a rollback.
3. The proposal is gated per the ADR-0015 authority table — every class requires Architect approval; Artemis may pre-screen and rank but never approve (nothing self-approves).
4. On approval, the change lands through the normal task/memo machinery; the ledger row flips to `landed`; the Scheduler books the metric check.
5. At the window's end, the metric is measured against its declared target: `validated` (kept) or `regressed` (rolled back per the proposal). The outcome is recorded permanently and reported in the next standup.

**Postcondition:** the Gymnasium ledger holds a complete proposed→measured record; rejected and regressed entries are retained as inputs to future proposals.
**Alternate 2a:** during the build phase, the same loop runs through the repository (`/improve` skill, `docs/gymnasium/`) with the build's friction records as evidence.
**Alternate 5a:** metric unmeasurable at window end → treated as `regressed` (an unmeasurable improvement is not an improvement); rollback and a ledger note on why measurement failed.

### UC-14 — Stoa research cycle
**Actor:** Scheduler/Artemis → Researcher → Artemis → Architect. **Goal:** the company learns from sources the Architect chose, on the record.
1. The Architect registers external sources on the watchlist with tags describing what to learn (register/retire are Architect-only actions; agents may propose entries but never register them).
2. On the Stoa cadence (mode-gated, FR-14.4) or on demand ("study X for Y"), a researcher agent studies **one** source at its pinned commit, scoped to the entry's tags — read-only, in an isolated checkout, no secret grants, treating the source strictly as data.
3. The researcher files **one** research brief: source\@commit, findings each citing file paths, applicability mapped to Ephesus subsystems (cross-referenced to internal friction records where they exist), candidate improvements, and a license note.
4. The harness validates the brief's shape — a finding without a citation is rejected before any human sees it; valid briefs archive immutably in the Agora.
5. Artemis reviews the brief, ranks its candidates, and files (or assigns a worker to file) Gymnasium proposals citing the brief; from there UC-13 runs unchanged — Artemis pre-screens, the Architect verdicts.

**Postcondition:** the brief is archived and linkable from every proposal it seeded; the Stoa's health metrics (approved proposals per brief; validated ratio of Stoa-seeded proposals) accumulate for UC-12 retros.
**Alternate 2a:** source unreachable, pin missing, or license unverifiable → the study is refused with a visible reason, never silently skipped.
**Alternate 3a:** the source contains instructions addressed to the reader ("ignore your instructions…") → reported as a finding, never followed (NFR-17, S-STOA).
**Alternate 1a:** during the build phase, the same loop runs through the repository (`/research` skill, `docs/stoa/`) with the Architect as registrar and approver.

### UC-15 — Enable improve-company mode
**Actor:** Architect. **Goal:** standing autonomous self-improvement, switched on deliberately and provably.
1. The Architect requests the mode change `directed → improving`.
2. The harness checks the proof gate (§6.9) against the Gymnasium ledger and event log only. Evidence missing → the change is refused with the exact missing items listed.
3. On success the mode flips: the status strip shows it, the next standup brief states it, and from then on every record produced by autonomous initiative (task, brief, proposal, log event) carries the mode tag.
4. In `improving`, the Scheduler runs the Stoa and Gymnasium cadences autonomously; gating is unchanged — every proposal still reaches the Architect per UC-13.
5. The Architect may revert to `directed` at any moment as a single ungated action; a breaker stop (rung 3) attributable to Gymnasium/Stoa work reverts the mode automatically and reports it.

**Postcondition:** every mode change is in the ledger and log with its actor and reason; no agent or harness path can set `improving`.

### UC-16 — Recursive Improvement delivery
**Actor:** Architect → Scheduler → Researcher/Improver → Artemis → Architect. **Goal:** the company improves itself continuously, and every change crosses the Architect's desk as a pull request.
1. The Architect activates the **Recursive Improvement** profile (FR-9.5). Activation is refused unless the company mode is `improving` (FR-14.3's gate having been met), with the missing evidence listed.
2. The Architect presents repositories to study by URL in the app's Stoa panel — each becomes a tagged watchlist entry under FR-13.1's unchanged authority (Architect registers; agents may only propose).
3. On the profile's cadences, the Stoa produces briefs (UC-14) and Artemis ranks their candidates and files proposals (UC-13); the Architect verdicts each proposal.
4. For an approved proposal, an improver agent implements the change in its own worktree on an `agent/<name>/<topic>` branch and opens a **pull request under the company identity** (FR-10.5), carrying evidence and citing the proposal and brief ids it descends from.
5. The Architect reviews and merges (or rejects) the PR — merge authority is the Architect's alone, and no auto-merge path exists. On merge the ledger row flips `landed` and the metric check is booked (UC-13 step 5 unchanged).

**Postcondition:** the full chain — watchlist entry → brief → proposal → PR → merge → measured outcome — is reconstructible from the ledger, the log, and the PR history.
**Alternate 1a:** mode is `directed` → activation refused; the refusal names the proof-gate evidence still missing (§6.9).
**Alternate 5a:** PR rejected → the improver revises on the same branch, addressing review comments point-by-point (ENGINEERING-STANDARDS §7); the proposal stays `approved`, never silently abandoned.

---

## 4. Functional requirements

Requirements use SHALL (mandatory), SHOULD (strong default), MAY (optional). IDs are
stable and referenced by the SDD, test strategy, and implementation plan.

### FR-1 — Agent lifecycle & terminal plane
- **FR-1.1** The system SHALL spawn each agent as a real CLI process in a dedicated PTY (node-pty), streaming output to an xterm.js view byte-for-byte.
- **FR-1.2** The system SHALL support Claude Code as the reference engine, and SHALL define an engine adapter interface such that additional CLIs (Codex, Gemini CLI, Grok, OpenCode, custom command) are added without core changes (ADR-0009 prior-art seam).
- **FR-1.3** The system SHALL let the Architect type into any agent's terminal, with interrupt (Escape) and queue-until-idle semantics when the agent is mid-tool.
- **FR-1.4** The system SHALL detect a dead/exited process, mark the avatar `ghost`, and archive it after a grace period; session resume SHOULD be offered where the engine supports it.
- **FR-1.5** The system SHALL support optional per-agent git worktree isolation. Isolation SHALL survive the agent's death: a respawn SHALL reuse the agent's own surviving checkout, and SHALL NOT be refused by a worktree path that holds no work. A path holding anything else SHALL still be refused, with the reason naming what was found, and nothing at the path SHALL be deleted to make room.
- **FR-1.6** The system SHALL offer to install a missing engine CLI in the agent's own terminal and continue into the new binary on success.
- **FR-1.7** The system SHALL prevent an agent process from upgrading the engine install the company runs on (ADR-0028). Engine upgrades are the Architect's, performed between runs.
- **FR-1.8** The system SHALL suppress the engine’s own attribution in every artefact an agent produces in a TARGET repository — commit trailers, pull-request bodies and session links alike — so that §6 criterion 10’s “no Architect or vendor identity anywhere” holds where the company’s work actually lands. Note that the repository-history attribution scan named in ENGINEERING-STANDARDS §2 checks THIS repository only, and structurally cannot see a target’s commits.
- **FR-1.9** A hire that declares no budget SHALL be treated as **unbudgeted**, not as zero, and no shipped profile SHALL declare one (ADR-0029). Unbudgeted disables the breaker's burn-rate signal for that agent and nothing else: the repeated-call, hop-cap and pathology signals, ADR-0023's wall-clock wake cap, and the cost ledger's reporting all continue to apply. A ceiling SHALL remain expressible per hire, and `gate-policy.json`'s `maxDailyTokens` SHALL act as the company-wide ceiling — absent meaning none. It SHALL compose stricter-wins, the same way the autonomy ceiling has since ADR-0012: a hire declaring nothing receives it, a hire declaring more is clamped down to it, and a hire declaring less keeps its own figure. A company ceiling any profile could exceed would be a setting that looks like a limit and is not.

### FR-2 — Event plane (hooks)
- **FR-2.1** The system SHALL run a local hook endpoint (Unix domain socket; named pipe on Windows) receiving lifecycle events from engine hook shims.
- **FR-2.2** The system SHALL map hook events to avatar states (idle/alert/thinking/working/waiting/blocked/success/ghost/compacting/looping) exactly as specified in SDD §6.
- **FR-2.3** Hook payload schema drift SHALL be surfaced as a visible warning, with degraded PTY-heuristic fallback rather than silent failure.

### FR-3 — Hermes (messaging)
- **FR-3.1** Messages SHALL be single JSON files using the speech-act schema (SDD §5.3): `id, conversation, in_reply_to, from, to, act, subject, body, hops, requires_reply, needs_human, created_at`.
- **FR-3.2** Agents SHALL write only inside their own `agents/<id>/` directory; the router (main process) SHALL deliver outbox → inbox atomically (temp file + rename).
- **FR-3.3** Only `request`/`query`/`propose` obligate replies; `hops` SHALL increment per reply; past the hop cap Hermes SHALL escalate to Artemis instead of delivering.
- **FR-3.4** Delivery to a missing/archived inbox SHALL bounce with a logged `refuse`, never drop silently.
- **FR-3.5** An idle agent holding unread inbox mail SHALL be woken (inbox wake watchdog); the `Stop`-hook loop SHALL drain inboxes with `stop_hook_active` and a block-cap guard against infinite loops.
- **FR-3.6** Processed messages SHALL move to `inbox/.done/` and be idempotent via a per-agent cursor.
- **FR-3.7** `broadcast` and `to:"human"` addressing SHALL be supported; `to:"human"` routes to Artemis as the Architect's proxy.

### FR-4 — The Agora (coordination space)
- **FR-4.1** The Agora SHALL be a local git repo committed **only** by the main process, with retry/backoff and stale-lock cleanup.
- **FR-4.2** It SHALL contain: `registry.json` (roster), `board.md` (blackboard, single scribe = Artemis), `tasks.json` (ledger), `log.jsonl` (append-only event feed), and per-agent homes.
- **FR-4.3** The task ledger SHALL support dependencies, assignee, status, priority, result refs, and review flags (`review:deck`, `review:memo`), and SHALL drive the kanban UI.
- **FR-4.4** Every Hermes delivery, gate verdict, memo verdict, and lifecycle event SHALL append to `log.jsonl`; the activity UI and briefings SHALL be derived from it (single source of truth).

### FR-5 — Artemis (orchestrator)
- **FR-5.1** Artemis SHALL be an ordinary engine process (intelligence) coordinated by harness mechanism (routing, git, sockets) — never a hardcoded rules engine.
- **FR-5.2** Artemis SHALL own: roster & routing, adjudication of routine inter-agent requests, blackboard scribing, the task ledger, and packaging of escalations.
- **FR-5.3** Artemis's escalation policy (what is "critical") SHALL live in its system prompt and be editable by the Architect from the UI (the primary control surface).
- **FR-5.4** Artemis SHALL auto-spawn at startup into its reserved seat and re-spawn on crash with its memory intact.
- **FR-5.5** Artemis SHALL hold *delegated authority* levels configurable per domain (e.g. may approve memos touching test code; may not approve spend), and SHALL countersign everything it decides.

### FR-6 — The Library (memory)
- **FR-6.1** Each agent SHALL read its `identity.md` + `memory.md` at task start and append learnings; memory survives process death and respawn.
- **FR-6.2** A semantic recall index over all memory SHOULD be maintained (local embeddings), searchable by agents and by the Architect from the UI; absence of the index SHALL degrade to markdown + FTS, never break.
- **FR-6.3** A reflection job SHALL periodically condense `memory.md` files to bound growth, preserving a dated archive of what was condensed.
- **FR-6.4** The Architect MAY register reference documents (policies, style guides, runbooks) into a shared knowledge shelf queryable by any agent.

### FR-7 — The Odeon (accountability) — *differentiator*
- **FR-7.1 Briefings.** Artemis SHALL deliver standup briefings on schedule and on demand ("what's the status?"), compiled strictly from Agora data (ledger, log, budgets, Harbor queue) — never from free recollection. Briefings SHALL be available as speech (Herald), as an in-app card, and as remote push.
- **FR-7.2 Slide reviews.** A ledger task flagged `review:deck` SHALL require the assignee to produce an HTML slide deck from the standard template (goal, built, decisions, trade-offs, evidence, open questions) before the task can close; decks archive immutably in the Odeon with the task ref.
- **FR-7.3 Decision memos.** The system SHALL enforce memo policy: choices matching configured triggers (new dependency, public API/schema change, security posture, spend) SHALL be filed as structured memos before the change lands. Memos flow: agent → Artemis triage (within delegated authority: decide + countersign) → Architect queue. Verdicts (approve/reject/amend) SHALL return as Hermes messages and archive immutably.
- **FR-7.4 Live meetings.** The Architect SHALL be able to convene a meeting with selected agents: Artemis chairs, enforces turn order, routes questions, and files minutes + action items to the blackboard and ledger. Attendee avatars SHALL visibly gather in the Odeon room.
- **FR-7.5** Every Odeon artifact (brief, deck, memo, minutes) SHALL be linkable from the task it concerns and discoverable chronologically.

### FR-8 — The Herald (voice) — *differentiator*
- **FR-8.1** The voice layer SHALL be a provider-agnostic seam (STT, TTS, and optional duplex realtime) with: **ElevenLabs** as the reference TTS/conversation implementation, **OpenAI Realtime** as the automatic fallback, and room for local engines (Piper/Kokoro) with no code change outside the seam (ADR-0007).
- **FR-8.2** Failover SHALL be automatic on provider error/latency breach, mid-session, with a one-line spoken/visible notice ("switching voice provider").
- **FR-8.3** The Herald SHALL support: push-to-talk always; an optional local wake word; barge-in (Architect speech immediately stops TTS playback and is captured).
- **FR-8.4** Voice SHALL reach: Artemis conversation, briefings, meeting narration, and approvals. Destructive/spend approvals by voice SHALL require an explicit repeat-back confirmation ("Confirm: delete branch release/9 — say *confirm delete branch release 9*"). The repeat-back token SHALL carry the gate's whole subject, so that two gates differing only in their tail — `release/9` and `release/10`, `$80` and `$8000` — never share a token; for a spend gate the amount SHALL be in the token, since the amount is what is being approved. The spoken answer SHALL match the token **exactly** (case- and punctuation-insensitive); an utterance that merely contains the token SHALL NOT confirm, because a refusal quotes the token it is refusing. Each repeat-back SHALL be single-use and SHALL lapse, so the same words cannot approve a gate twice or answer a stale asking. *(Amended 2026-08-29 at the M6 close-out audit, which proved by execution that the previous first-three-words token collapsed distinct gates onto one string and that substring matching let the spoken refusal "no, do not confirm delete branch release 9" approve the deletion. The earlier example, "say confirm delete", is preserved here as the wording this clause replaced.)*
- **FR-8.5** The persona is a composed, understated, dryly-witty British-styled assistant — an *homage style*, not a clone of any actor or character; persona text lives in config, not code.
- **FR-8.6** Without configured voice keys the entire system SHALL function fully in text.

### FR-9 — Mission profiles — *differentiator*
- **FR-9.1** A mission profile SHALL be a declarative bundle: roles (hires), schedules/triggers, playbooks (markdown runbooks agents follow), Harbor wiring, budgets, and autonomy levels — versioned files, shareable, and inspectable before activation.
- **FR-9.2 Skeleton Crew profile.** SHALL ship built-in with: health-check watcher, CI babysitter (watch runs, retry/triage failures, open fix PRs), dependency-update agent (batched PRs), and incident-response playbooks with severity-based escalation (UC-09).
- **FR-9.3 Front Office profile.** SHALL ship built-in with: issue/PR triage, reply drafting with configurable autonomy (draft-only → auto-post), docs/changelog sync, and release-prep checklists (UC-10).
- **FR-9.4** Profiles SHALL be per-target (per app/repo) instantiable, and multiple profiles SHALL coexist on one floor.
- **FR-9.5 Recursive Improvement profile.** SHALL ship built-in with: a researcher role running the Stoa cadence over the watchlist, improver role(s) implementing approved proposals in isolated worktrees, Artemis's ranking/pre-screen duties, and delivery playbooks. Its default target is the company's own repository. Activation SHALL be refused outside company mode `improving` (FR-14.3), and deactivation (or a mode revert) SHALL stop its triggers. Every change it lands SHALL be delivered as a pull request under the company identity (FR-10.5) on an `agent/` branch, citing the proposal and brief it descends from; merge authority SHALL rest with the Architect alone and the profile SHALL contain no auto-merge path. Its work runs inside the Gymnasium budget slice (FR-12.5).

### FR-10 — The Harbor (in/out)
- **FR-10.1** GitHub: ingest issues, PRs, and CI runs for registered repos; act via the `gh` CLI under the agent's own auth.
- **FR-10.2** Chat bridge: at least one chat integration (Slack-compatible webhook/bot) through which the Architect can converse with Artemis remotely, receive briefings, and approve gates (UC-11); inbound webhooks MAY spawn ephemeral workers that are torn down after replying.
- **FR-10.3** Every remote-originated directive SHALL be tagged `remote` in the event log.
- **FR-10.4** Shareable hires: export/import a role template via link/file; import only pre-fills the spawn form — a human always confirms.
- **FR-10.5 Company identity.** The system SHALL support acting on GitHub through a single Architect-owned machine account (ADR-0020): its token SHALL live write-only in the secret broker and reach only roles whose hire template declares the grant; agent commits SHALL be authored as the company account with a per-agent co-author trailer, never as the Architect and never as any vendor identity; the account SHALL hold write access only (no admin, no merge — `main` stays PR-and-review protected); and every remote action it takes SHALL be logged. Revoking the token SHALL disable delivery without affecting any other capability.

### FR-11 — The Watch (safety, budgets, org)
- **FR-11.1 Gates.** Spend above threshold, destructive ops, scope changes, prod-facing actions, and **outbound public communication** SHALL require Architect approval (native tool-permission prompts + the approvals UI + remote push). Defaults are conservative; autonomy is opt-in per profile. *(Outbound added 2026-08-31 by Architect decision at M7.5: FR-9.3 requires the Front Office's reply autonomy to be configurable on its own ladder, and folding it into prod-facing would have meant an Architect who enables auto-post also grants autonomous production actions. A gate policy that does not mention `outbound` denies it, so the addition can only ever tighten an existing deployment.)*
- **FR-11.2 Budgets.** Per-agent token/cost budgets SHALL be enforced; real cost SHALL be folded from engine transcripts into a durable ledger (never reset by app restart); the UI SHALL show session and cumulative figures separately.
- **FR-11.3 Circuit breaker.** A steer → constrain → stop ladder SHALL trip on runaway loops, error storms, or budget blowout; trips are logged and surfaced in the next briefing.
- **FR-11.4 Secret broker.** Provider keys SHALL be stored write-only (set/rotate/delete; never read back to UI or agents); agents receive credentials only via environment injection at spawn, scoped to what their role declares.
- **FR-11.5 Org layer.** The system SHALL maintain an explicit org model: departments, roles, hire templates (versioned), per-agent metrics (tasks done, rework, escalation rate, budget efficiency), and scheduled review/retro reports (UC-12).
- **FR-11.6 Telemetry.** Local OTel-style spans and a tool waterfall per agent SHALL be available. Any *outbound* anonymous telemetry SHALL be opt-in, documented, and absent entirely in source builds.

### FR-12 — The Gymnasium (self-improvement) — *primary standing mission*
- **FR-12.1** The system SHALL implement the Gymnasium loop (ADR-0015): observe → propose → gate → land → measure, with every step recorded; improvement candidates SHALL derive only from recorded evidence (org metrics, event log, breaker/budget data, memo patterns, drift audits, and Stoa research briefs — FR-13), never from unreferenced speculation.
- **FR-12.2** Improvement proposals SHALL be single-scoped and SHALL carry: evidence refs, the concrete change, cost/risk, a falsifiable success metric with a measurement window, and a rollback. A proposal missing any of these SHALL be rejected by the harness before reaching a human.
- **FR-12.3** Gating SHALL follow the ADR-0015 authority table: the Architect approves every Gymnasium class; Artemis MAY pre-screen and rank but SHALL NOT approve; no agent approves its own proposal; the Gymnasium SHALL NOT be able to widen its own authority, alter its own gating, or modify accepted ADRs.
- **FR-12.4** The Gymnasium ledger SHALL be permanent and total: every proposal, verdict, and measured outcome (validated/regressed/rejected) is an immutable row; landed changes whose metric regresses or cannot be measured SHALL be rolled back per their proposal.
- **FR-12.5** Gymnasium work SHALL run inside an explicit budget slice (configurable share of time/tokens) reported in standup briefings, so self-improvement can never starve the mission profiles.
- **FR-12.6** The loop SHALL exist in the repository during the build phase (`/improve` skill, `docs/gymnasium/`) and carry into the running system with the same artifact shapes, so the improvement archive is continuous from first commit onward.

### FR-13 — The Stoa (research department)
- **FR-13.1** The system SHALL maintain an Architect-curated **watchlist** of external sources (SDD §4.7), each entry carrying url, tags describing what to learn, the license as verified at registration, a pinned commit, and intent notes. Registering and retiring entries SHALL be Architect-only actions; any agent MAY propose an entry but SHALL NOT register one (the FR-12.3 authority mirror).
- **FR-13.2** A Stoa study SHALL be read-only over a pinned snapshot of one watchlist source, in an isolated checkout, with no secret grants; watched-source content SHALL be treated as untrusted data — instructions found in it SHALL never be followed and SHALL be reported as findings (NFR-17).
- **FR-13.3** Each study SHALL produce exactly one research brief carrying: source\@commit, findings each citing file paths, applicability mapped to Ephesus subsystems, candidate improvements, and a license note. A brief with an uncited finding SHALL be rejected by the harness before reaching a human (the FR-12.2 pattern).
- **FR-13.4** A brief is evidence, never a change: improvements it seeds SHALL flow through UC-13 unchanged (Artemis pre-screens, the Architect verdicts), citing the brief in their evidence refs; briefs SHALL archive immutably and be linkable from the proposals they seeded.
- **FR-13.5** The Stoa SHALL learn patterns, not copy code: any verbatim or derived code intake from a watched source SHALL require a verified license on the watchlist entry, recorded attribution, and a decision memo (ENGINEERING-STANDARDS §5).
- **FR-13.6** Stoa work SHALL run inside the Gymnasium budget slice (FR-12.5) and be reported with it in standup briefings.
- **FR-13.7** The loop SHALL exist in the repository during the build phase (`/research` skill, `docs/stoa/`) with the same artifact shapes, seeded into the Agora at first run (the FR-12.6 pattern).

### FR-14 — Company modes & the proof gate
- **FR-14.1** The system SHALL maintain an explicit company mode — `directed` (default) or `improving` — visible at all times in the UI and stated in every standup brief; every record produced by autonomous initiative SHALL be tagged with the mode it ran under.
- **FR-14.2** Only the Architect SHALL change the mode; no agent or harness path SHALL be able to set `improving`. Reverting to `directed` SHALL always be a single ungated action.
- **FR-14.3** The first enable of `improving` SHALL be mechanically refused until the proof gate (§6.9) is met, with the missing evidence listed; the check SHALL read only the Gymnasium ledger and event log.
- **FR-14.4** In `improving` the Scheduler SHALL run the Stoa and Gymnasium cadences autonomously; in `directed` those cadences SHALL run only on demand. Gating (FR-12.3) SHALL be identical in both modes — the mode governs initiative, never approval.
- **FR-14.5** A circuit-breaker stop (rung 3, ADR-0011) attributable to Gymnasium/Stoa work SHALL revert the mode to `directed` automatically, visibly, and on the ledger; only the Architect can restore `improving`.

---

## 5. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | Performance | Floor animation ≥ 60 fps with 15 avatars on a 2020-era laptop; terminal latency (keystroke → echo) ≤ 50 ms added over raw PTY. |
| NFR-2 | Performance | Hermes delivery (outbox write → inbox visible) ≤ 500 ms p95; hook event → avatar state change ≤ 200 ms p95. |
| NFR-3 | Performance | Voice: barge-in stop ≤ 250 ms; briefing first-audio ≤ 2 s after data compile; provider failover ≤ 3 s. |
| NFR-4 | Scale | 15 concurrent agents supported; 30 tolerated with graceful degradation (reduced animation, batched log rendering). Memory index to 100k chunks. |
| NFR-5 | Reliability | No single agent crash may take down the harness; harness crash SHALL lose no Agora data (all state is committed files); on restart, roster/ledger/memory restore exactly. **The company's live coordination state SHALL restore with them** — active mission instances, open gates *and their settled verdicts*, and trigger last-fired times — and anything that cannot be restored SHALL be reported rather than silently absent (ADR-0027). Agent **processes** are not restored: a restored instance declares its crew *down* and arms no triggers until the Architect rehires it, because without engine session recovery a respawned agent redoes in-flight work and violates §6 criterion 6. State a live subsystem re-derives from a durable source, and state describing a process that no longer exists, are out of scope by ADR-0027 §5. |
| NFR-6 | Reliability | At-least-once Hermes delivery with idempotent consumption (cursor); zero silent message loss (bounce + log on failure). |
| NFR-7 | Durability | Cost ledger, event log, memos, decks, and minutes are append-only/immutable once written; git history of the Agora is never rewritten. |
| NFR-8 | Security | No secrets in renderer, logs, Agora files, or telemetry. Renderer runs sandboxed with contextIsolation; all fs/git access brokered through typed IPC. |
| NFR-9 | Security | Gated actions are deny-by-default; remote approvals require the bridge's authenticated channel; voice approval of destructive ops requires repeat-back. |
| NFR-10 | Privacy | No prompts, code, file paths, or agent output ever leave the machine except to providers the Architect explicitly configured. |
| NFR-11 | Portability | macOS/Windows/Linux from one codebase; platform-specific code isolated behind seams (PTY, sockets, packaging). |
| NFR-12 | Extensibility | Adding an engine, a voice provider, or a mission profile requires no changes outside its adapter/bundle (measured in the test strategy as a conformance suite). |
| NFR-13 | Observability | Every autonomous action is reconstructible from `log.jsonl` alone ("the log is the company's book of record"). |
| NFR-14 | Usability | Any agent's raw terminal is ≤ 1 click away from anywhere; every automated artifact (brief, memo verdict, triage label) links to its evidence. |
| NFR-15 | Accessibility | Full functionality without voice; UI meets WCAG AA contrast within the pixel-art design language; all panels keyboard-navigable. |
| NFR-16 | Maintainability | Typecheck-clean TypeScript throughout; the standards doc's Definition of Done gates every merge. |
| NFR-17 | Security | Watched-source content (FR-13) is untrusted input: it never reaches an executable surface — shell, config, prompts-as-instructions, code — except through a gated Gymnasium proposal; researcher spawns are read-only with no secret grants; instructions embedded in studied content are findings to report, never directives to follow. |
| NFR-18 | Security | **Everything an agent reads is untrusted input, not only watched sources.** Repository content, CI and test output, issue and pull-request text, commit messages and API responses from a TARGET are data: instructions found in them SHALL never be followed and SHALL be reported to the orchestrator with their provenance. The only authoritative instructions are the company protocol and messages delivered to an agent's `inbox/` by the harness. This binds the crew harder than NFR-17 binds the researcher, because a crew agent holds a repository credential and can push, where a researcher is read-only with no grants. |

---

## 6. Acceptance criteria (system level)

The build is *accepted* when, on a clean machine with Claude Code installed:

1. **The one-hour company test.** The Architect activates Skeleton Crew on a real repo, breaks a test on a branch, and walks away. Within the hour: the crew has detected the failure, fixed it or opened a fix PR, filed the required memo if the fix crossed policy, and the next briefing narrates the incident accurately from the log — with zero un-gated destructive actions.
2. **The standup test.** With ≥ 3 agents having worked overnight, "Artemis, what's the status?" produces a spoken brief whose every claim is traceable to a ledger/log entry, in under 90 seconds of audio.
3. **The review test.** A task flagged `review:deck` cannot close without its deck; the deck renders in-app; a comment becomes a follow-up task.
4. **The memo test.** An agent adding a new npm dependency is blocked at the policy trigger until a memo exists; Artemis-approved memos show its countersignature; Architect rejection reverses the change.
5. **The failover test.** Pulling the ElevenLabs key mid-conversation continues the session on OpenAI Realtime within 3 s.
6. **The blackout test.** Kill the harness mid-delivery; on restart nothing is lost, no message is double-processed, and no agent is orphaned.
7. **The gymnasium test.** After two weeks of operation, the company has filed ≥ 1 evidence-backed improvement proposal on its own initiative; an approved one landed, was measured against its declared metric, and its outcome is in the ledger; a proposal attempting to change gating rules or an accepted ADR was mechanically refused; and no improvement landed without an Architect verdict.
8. **The research test.** With the watchlist holding ≥ 1 registered source, one Stoa cycle produces a brief whose every finding cites `repo@commit` + file path; a planted instruction in a fixture source is reported as a finding, not obeyed; a Gymnasium proposal seeded by the brief reaches the Architect queue citing it; a brief with an uncited finding is rejected before reaching a human; and watchlist registration through any non-Architect path is refused.
9. **The proof-gate test.** With the proof evidence absent, enabling `improving` is refused with the missing items listed. The gate is met when the Gymnasium ledger records **≥ 3 proposals through the full loop** (proposed → Architect verdict → landed → measured), **≥ 2 of them `validated`**, **≥ 1 seeded by a Stoa brief**, and **zero gating violations** (no refused-class proposal ever landed). Once met, enabling succeeds; the mode is visible, autonomous records carry the mode tag, a rung-3 breaker stop on gym/stoa work auto-reverts to `directed`, and nothing but an Architect action can enable `improving`.
10. **The recursive test.** With Recursive Improvement active on the company's own repository: one full chain lands — a URL presented on the Stoa panel becomes a watchlist entry, a brief cites it, an approved proposal descends from the brief, and the change arrives as a pull request from the company identity on an `agent/` branch, citing both ids, which the Architect merges. Along the way: activation in `directed` mode was refused; no agent path merged or pushed `main`; the PR's commits are authored by the company account with the agent's co-author trailer and no Architect or vendor identity anywhere.
