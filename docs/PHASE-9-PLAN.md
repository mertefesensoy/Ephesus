# Phase 9 — from the harness core to an agentic harness (plan for M9b–M9h)

**Status: APPROVED FOR PLANNING 2026-10-03 — the build has NOT started.** The
Architect answered the eleven decisions in §11 the same day through the questions
workflow and then approved the plan as documentation; all of it is recorded in
`docs/DECISIONS-LOG.md`. **This is planning only.**
The standing instruction of 2026-10-02 — *"i just want to plan this out not build
it yet"* — covers this file as it covers M9: no package of M9 or of any milestone
below may begin until the Architect says so, and a session resuming at PROGRESS's
first unchecked box asks first.

**How this file relates to [`M9-PLAN.md`](./M9-PLAN.md).** M9 — *the harness is the
product* — is this phase's first milestone. It was approved for planning on
2026-10-02 and **nothing in it changes**: the bench before the engine, Ephesus's own
loop, the gate as the permission prompt, headless-first, an exit that is a measured
uplift and not a feature list. That file is not restated here. This file plans what
follows it: seven lettered milestones, M9b to M9h, that give Ephesus the
capabilities of the two harnesses the Architect named, in Ephesus's own way — and
one thing neither of them has, a companion of its own on the phone. **Five of them
come before M7b and two after it**: M7b — signed builds, the v1 boundary — follows
M9f, and the desk (M9g) and the companion (M9h) follow v1 (DD-M9-18).

---

## 1. The direction (2026-10-03), as claims the phase is held to

The Architect pasted the feature lists of the two sources already on the Stoa
watchlist — ten rows for `src-odysseus`, six for `src-hermes-agent` — asked for them
to be added to milestone phase 9 and planned comprehensively, and said: *"We will
keep the initial Ephesus brand core but the floor becomes an optional view mode and
Ephesus upgrades itself towards a real agentic harness."*

M9-PLAN §2 holds M9 to six claims, C1–C6. They still bind. This phase adds four:

| # | Claim | How the phase honours it |
|---|---|---|
| C7 | Ephesus offers what a real agentic harness offers: the sixteen features of §2. | Every one is planned to a package with acceptance, tests and a named risk (§6). None is left as an aspiration, and where a feature cannot be built honestly the package says so (`NOT BUILT`, with the reason) rather than shipping a weaker thing under the same name. |
| C8 | The brand core stays. | Every capability enters through the city subsystem whose job it already is (§2). No subsystem is renamed, and a new name is proposed only where no home exists. |
| C9 | The floor becomes an optional view mode. | [ADR-0040](./adr/ADR-0040-the-floor-is-a-view-mode.md): the window opens on a workspace; the Terraces are a mode, not deleted, still held to ADR-0014's standard. Built in M9b.1. |
| C10 | Ephesus upgrades **itself**. | The upgrade goes through the project's own machinery: documentation first, every decision the Architect's, every capability measured by the bench it lands with (§4 rule 1). M7b's Recursive Improvement profile then inherits a harness worth improving and an instrument to improve it by. |

One tension is stated rather than smoothed over. C1 says *the environment is not
the differentiator*, and a sixteen-feature list is a description of an environment.
What keeps this phase from being feature-chasing is §4: a capability does not count
because it exists, it counts when the bench can show what it added and the Watch
can show what it was allowed to do. Ephesus's difference is that its agents are
governed and its harness is measured. The features are what there is to govern and
measure.

## 2. Where each feature lands

Read against `main` @ `75ec37c` (2026-10-03); every "today" cell is a repository
fact (tier C), not a claim about behaviour.

| # | Feature | Its home in Ephesus | Today | Lands in |
|---|---|---|---|---|
| 1 | **Chat & Agents** — chat with local or API models; agents use shell, files, web, skills and memory behind approval gates | Artemis; the native engine | The engine, its tools and the gate are planned (M9.2–M9.5). The window has no conversation view: `App.tsx` opens on the floor tab | M9b.2–M9b.4 |
| 2 | **Cookbook** — hardware scan, model fit, downloads, llama.cpp / vLLM / SGLang serving | New: a model service feeding the provider seam (ADR-0038) | Nothing. M9.2 assumes an endpoint the Architect set up by hand | M9c.1–M9c.4 |
| 3 | **Deep Research** — multi-step web research, bundled search, report generation | The Stoa (ADR-0017) | The Stoa studies registered repositories at pinned commits only | M9e.1, M9e.4 |
| 4 | **Compare** — blind side-by-side model testing and synthesis | The bench (FR-16) | Scored rows are planned (M9.1, M9.6); judged quality is deferred to "a later package with its own ADR" (M9-PLAN §4) | M9c.5–M9c.6 |
| 5 | **Documents** — a writing-first editor with AI edits for Markdown, HTML and CSV | The workspace; the Odeon's artifacts are the nearest thing | Nothing editable; Odeon artifacts are immutable archives | M9e.5 |
| 6 | **Memory & Skills** — vector memory, notes, importable skills | The Library (ADR-0006/0016 — MemPalace, whose default backend is ChromaDB), the knowledge shelf (FR-6.4), tool grants (M8.7b) | Memory, recall and the shelf exist; a hire is granted tool directories by name; importing a skill and an agent writing one do not exist | M9b.5–M9b.6 |
| 7 | **Email** — IMAP/SMTP inbox, triage, summaries, drafts; Gmail OAuth | The Harbor; the outbound gate (FR-11.1, ADR-0030) | No mail connector. The Front Office already drafts and holds outbound text at a gate | M9g.1–M9g.2 |
| 8 | **Notes, Tasks & Calendar** — reminders, todos, scheduled agent tasks, CalDAV, ntfy push | Task ledger (FR-4.3), scheduler (ADR-0027), Harbor push (UC-04 alt. 3a) | Ledger and interval triggers exist; no calendar-time schedule, no CalDAV, no push | M9f.4–M9f.5, M9g.3 |
| 9 | **MCP & Integrations** — an MCP client, built-in servers, and a skill that lets Claude Code or Codex drive the harness | The native engine's tools; the Harbor; the control surface (ADR-0033) | M9.3's registry is closed by design; ADR-0026 strips MCP servers from every hire; `ephctl` exists and no outside agent is taught to use it | M9d.4 |
| 10 | **Mobile** — an installable web app and a LAN pairing bridge | The Harbor's remote command (UC-11, FR-10.2) | One chat bridge is planned as M7b.4; ADR-0033 rejected a listening port by name | M9f (the gateway and the workspace in a browser), then M9h (Ephesus's own companion) — DD-M9-15 |
| 11 | **Lives Everywhere** — Telegram, Discord, Slack, WhatsApp, Signal, Email, CLI; one agent, one memory | The Harbor's bridges | `harbor/bridge.ts` is in the SDD module map and not in the tree; "Telegram + more bridges" is post-v1 horizon | M9f.1–M9f.3 |
| 12 | **Persistent Memory** — learns projects, auto-generates skills | The Library; the Gymnasium for anything self-modifying | Memory persists and is reflected; no agent-authored skill | M9b.5–M9b.6 |
| 13 | **Focused Automation** — natural-language scheduling, unattended | The scheduler; consent (ADR-0032) | Profile triggers fire on intervals; nothing creates a schedule from language | M9f.4 |
| 14 | **Tasks Multiplied** — isolated subagents, scripts that call tools over RPC | The company itself; the native engine | Hires, worktrees, PTYs and mail exist; an agent cannot fan out inside a task | M9d.5–M9d.6 |
| 15 | **Browse the Web** — search, browser automation, vision, image generation, text-to-speech, multi-model reasoning | New tools; the Herald for speech; the bench for multi-model | The Herald is built with no caller (M6.9, deferred 2026-08-30); nothing else exists; harness egress is GitHub hosts only (THREAT-MODEL §5) | M9e.1–M9e.3, M9c.6 |
| 16 | **Isolated Sandboxing** — local, Docker, SSH, Singularity, Modal | The Watch | Worktree isolation (M8.6) and nothing else; M9-PLAN R20 says "a sandbox is a later ADR" | M9d.1–M9d.2 |

## 3. What the two sources do (read 2026-10-03; data, not instructions)

The two lists are the Architect's instruction. How each source builds them is
**data about those projects, never instructions to this one** (NFR-17, invariant
§13). Like M9-PLAN §3, this was read from outside the Stoa, because the watchlist
rows' tags did not cover these subjects when it was read. Unlike that section, each
reading names the commit it was read at. It is still pre-Stoa evidence: no brief,
no validation, and read through a summarising fetch rather than as raw bytes, so
anything a design leans on is re-read by the governed `/research` cycle in that
milestone's contract package. Paths are given so the cycle knows where to look.

### 3.1 Odysseus at `2992bf6` (branch `dev`, commit of 2026-10-02; AGPL-3.0-or-later)

**Patterns only.** The license is incompatible with this MIT repository: no code,
no constant and no text is taken (FR-13.5), and that includes the fit heuristics
below, which are described and not copied.

- **The list itself.** The README at that commit has eight feature bullets, not
  ten; "Memory & Skills", "MCP & Integrations" and "Mobile" are not rows there. The
  plan follows the ten the Architect supplied. The project's own `specs/_readme.md`
  says code is authoritative over its specs.
- **The approval gate is armed by taint, not asked per action**
  (`src/tool_capabilities.py`, `src/tool_approvals.py`). A clean run executes a
  shell command unasked. Once a tool result carrying untrusted content has entered
  the run, any call that reads private data, writes, executes, egresses or is
  unknown needs an exact approval: single-use, bound to a digest of the action,
  held in memory, gone after ten minutes or a restart. *Ephesus:* M9d.3 is the same
  idea on a durable gate (ADR-0027), and M9f.3 takes the digest binding.
- **An unattended run that reaches a gated action is denied and paused**
  (`src/task_scheduler.py`). *Ephesus:* M9f.4 holds the gate and tells the
  Architect instead — a denial nobody saw is a silent outcome.
- **Cookbook** (`services/hwfit/*`, `routes/cookbook_routes.py`, `website/setup.md`).
  Hardware facts from each platform's own tools; a memory estimate from parameter
  count, quantisation and context; a run mode (GPU, offload, CPU, too tight); a
  labelled fit; a speed *estimate* from a lookup table; a weighted score; downloads
  through the model hub's client; servers launched detached, installed on demand,
  locally or over SSH with host-key checking off. vLLM and SGLang need Linux or
  WSL2. *Ephesus:* M9c takes the shape — facts, a pure fit, a verdict with its
  reason — and declines three things: installing a server on demand, serving where
  the harness cannot see the process, and an unpinned host key. It replaces the
  speed estimate with a measurement.
- **Deep Research** (`src/deep_research.py`, `specs/search.md`,
  `docker-compose.yml`). A sub-question plan; two to eight rounds of a few queries
  each; pages fetched a few at a time and capped; findings folded into an evolving
  report; the model judges when to stop. SearXNG is a pinned service on loopback.
  A fetch validates every redirect hop and pins the connection to a public
  address. *Ephesus:* M9e.1 and M9e.4 keep the bounded rounds and the address
  pinning and add what the source does not have: a citation check before a human
  reads the report, and an archive that keeps a citation resolvable.
- **Compare** (`static/js/compare/*`, `specs/compare.md`). One to eight panes;
  neutral labels and a shuffled order; the label-to-model mapping kept in the
  browser; votes into a local scoreboard; automatic grading by substring or number
  match. Its own spec says blind mode "is not a confidentiality boundary".
  "Synthesis" exists only for search and research panes — a chosen model analyses
  each pane's results — and nothing merges different models' answers. *Ephesus:*
  M9c.5 keeps the mapping in main and makes the verdict a durable row with its
  condition; merging answers is the other source's feature and is M9c.6.
- **Documents** (`src/agent_tools/document_tools.py`, `static/js/document.js`).
  Immutable version snapshots; a text area with a preview, HTML in a sandboxed
  frame, a CSV grid; the agent offers find-and-replace blocks as pending
  suggestions or applies exact single replacements; after untrusted context a
  mutation is sealed to the document's id, version and digest and re-checked.
  *Ephesus:* M9e.5 has the same shapes and the same zero-dependency editor, and is
  stricter on one point — no agent path writes the file at all.
- **Memory and skills** (`specs/memory-skills.md`). A memory file with an optional
  vector index that degrades to keyword search — the Library's ladder, arrived at
  independently. Skills are `SKILL.md` directories, extracted from conversations
  or imported from public URLs behind an admin gate with redirect validation; both
  are injected as *untrusted* context. *Ephesus differs on purpose:* an installed
  skill is an instruction, which is exactly why only the Architect installs one
  (M9b.5).
- **Email, notes, calendar** (`specs/email-contacts.md`,
  `specs/calendar-tasks-notes.md`). IMAP and SMTP; Google accounts authenticate by
  OAuth and then speak the same protocols; triage runs as scheduled actions that
  never send; an agent's send is a draft the user approves. A scheduler with cron,
  daily, weekly, monthly, once and event kinds; CalDAV pull and push; reminders to
  several channels including ntfy. *Ephesus:* M9g.1–M9g.3, through the outbound
  gate that already exists.
- **MCP and integrations** (`specs/shell-mcp.md`, `src/builtin_mcp.py`,
  `integrations/*/README.md`). A client over stdio, SSE and streamable HTTP; tools
  named `mcp__<server>__<tool>`; built-in servers as stdio subprocesses; unknown
  tools classified as dangerous. Its spec lists its own gaps: per-server disabled
  tools are "not a complete execution-time gate", and server environments are
  stored in plaintext. "Claude Code and Codex skills" means a downloadable skill
  whose helper calls the project's API with a token — an outside agent driving the
  harness, which M9d.4's last paragraph plans over `ephctl`.
- **Mobile** (`companion/pairing.py`, `companion/routes.py`, `static/sw.js`,
  `routes/chat_routes.py`). A web-app manifest and a service worker that caches
  the shell, with no push. Pairing mints an ordinary bearer token — scope `chat`,
  no expiry, not single-use — and shows it as a QR code; the transport is plain
  HTTP on the LAN, and HTTPS is rejected because the first client understands only
  HTTP; there is no challenge, no rate limit and no device list. A paired device
  may chat without tools and **cannot authorise a gated action**.

### 3.2 Hermes Agent at `7533bd2` (branch `main`, commit of 2026-10-03; `LICENSE` reads MIT)

The watchlist row records that reading as *read, not yet verified* — verifying a
license is the Architect's act (FR-13.1) — and **an unverified row permits study
and refuses pattern intake** (FR-13.5, the watchlist's own header). Nothing in this
plan is an intake: every design here is owed by a contract package, after a
governed brief. But the verification is owed before the first of those briefs
seeds anything from this source. The landing-page headings
the Architect pasted are not in the repository, whose own lists use other words; the
six were mapped by subject. Paths below are under `website/docs/` unless they name
code.

- **The gateway** (`user-guide/messaging/*`, `user-guide/security.md`,
  `gateway/pairing.py`). One background process hosts every platform adapter, a
  session store per chat and the scheduler's ticker. Telegram by outbound long
  polling, Discord by an outbound WebSocket, Slack by Socket Mode — none needs a
  public address. WhatsApp through a bundled unofficial bridge, which the project
  itself says carries ban risk, or the official API with a public webhook. Signal
  through a local `signal-cli` daemon. Email by polling IMAP. **With no allowlist
  every sender is denied.** Pairing: an unknown sender is sent a code that expires
  in an hour, with one request per user per ten minutes, a cap on pending codes and
  a lockout after failed approvals; **the owner approves on the host, never from
  the chat**, and revokes with one command. Inside the authorised set "all callers
  are equally trusted". A dangerous command is answered from chat — once, for the
  session, always, or deny — and five minutes of silence means it does not run;
  "always" writes a permanent allowlist entry from the chat, and a default "smart"
  mode lets an auxiliary model approve what it judges low-risk. *Ephesus:* M9f
  takes the pairing standard and the outbound-only transports, and departs on
  three points, each on its own record's side: a stranger receives silence rather
  than a code (one operator, §4 rule 9); no chat reply creates a standing grant
  (rule 6); and no model approves anything (FR-12.3's principle — nothing
  self-approves).
- **Memory and skills** (`user-guide/features/memory.md`, `…/skills.md`,
  `…/curator.md`). Two small files with character budgets, frozen into the prompt
  at session start; an over-budget write is an error, so the agent consolidates;
  full-text search over past sessions with no model call. Skills are `SKILL.md`
  folders loaded by progressive disclosure and written by the agent itself.
  **Memory and skill writes land with no approval by default**; staging them for
  review is opt-in. The project's `SECURITY.md` calls its skills guard "a review
  aid". *Ephesus:* M9b.5–M9b.6 take the budget, the erroring write and the session
  search. Staging is not an option there but the only path: an agent-written skill
  is a Gymnasium proposal.
- **Scheduling** (`user-guide/features/cron.md`,
  `developer-guide/cron-internals.md`). The model turns language into a tool call;
  the schedule string is then parsed deterministically. Jobs are a file written
  atomically; a tick every sixty seconds under a lock; **a fresh session per run,
  with no chat history and with memory loaded**; delivery to a named target. A
  dangerous command in an unattended run is denied by default. A scheduled session
  cannot schedule more jobs. Inactivity timeouts, a notice after three failures in
  a row, and a job caught mid-run by a restart is marked unknown, not retried.
  *Ephesus:* M9f.4 is the same shape with one step added — the Architect confirms
  the plan before it is armed.
- **Delegation and scripted calls** (`user-guide/features/delegation.md`,
  `…/code-execution.md`, `tools/code_execution_tool.py`). A child gets a fresh
  conversation holding only its goal and context, and its own terminal; depth one;
  a concurrency cap; only its summary returns; it cannot use memory, messaging,
  scheduling or delegation; a heartbeat abandons one that goes idle. A
  model-written script runs in a child process, a stub forwards its tool calls
  over a local socket, and only its output re-enters the context; a short list of
  tools is callable, under a time, call and size limit. The project's `SECURITY.md`
  notes that this child is a host subprocess outside the terminal backend's
  isolation. *Ephesus:* M9d.5–M9d.6 take both shapes, run the script **inside** the
  hire's backend — closing the gap the source names — and make each child an owned
  spawn visible on both planes.
- **Web, browser, senses, multi-model** (`user-guide/features/web-search.md`,
  `browser.md`, `vision.md`, `image-generation.md`, `tts.md`,
  `mixture-of-agents.md`). One configured search backend out of many, self-hosted
  SearXNG among them. Browser tools present a page as an accessibility-tree
  snapshot; backends range from cloud services to a local Chromium. URL tools
  refuse private, loopback and link-local addresses. A model without vision gets an
  auxiliary model's description of the image. Images through hosted services or
  any compatible endpoint. Speech through many providers, local ones included.
  Mixture of agents: reference models advise without tools, and an aggregator
  acts. *Ephesus:* M9e.1–M9e.3 and M9c.6.
- **Execution backends** (`user-guide/configuration.md`, `user-guide/security.md`,
  `tools/environments/docker.py`, `tools/approval.py`). Seven built-in backends
  chosen by one setting; terminal and file tools run through the chosen one. Docker
  hardening: capabilities dropped (three added back), no new privileges, a process
  limit, size-limited temporary filesystems, resource limits, an optional
  no-network mode, no host environment unless listed. **On container and cloud
  backends the approval checks are skipped** — the sandbox is taken to be the
  boundary — while local and SSH always check. Its `SECURITY.md` says plainly that
  the only boundary against an adversarial model "is the operating system", and
  that backend isolation does not confine the agent's own process, its MCP
  subprocesses, plugins or hooks. *Ephesus:* M9d.1–M9d.2 take the seam and the
  hardening list. M9d.3 does **not** take the skip: a gate is lifted inside a
  sandbox only when that sandbox has no egress and no secret grant, not because it
  is a container.
- **Mobile.** There is none of its own: no app, no installable web app. A phone is
  served by the chat platforms above; by a web dashboard on loopback, reached
  through a reverse proxy, a tailnet or an SSH tunnel the user runs — a
  non-loopback bind without a login refuses to start, and a dashboard user has
  full administration, keys and pairing included; by an API server with a bearer
  key; by ntfy, where "the topic name is the credential"; and by an experimental
  relay the gateway dials out to (`user-guide/features/web-dashboard.md`,
  `…/api-server.md`, `user-guide/messaging/ntfy.md`, `…/relay.md`).

### 3.3 What the readings change in this plan

1. **Arming the gate on provenance is a shape that exists and works** (3.1). M9d.3
   was planned from first principles and now has a precedent to study — and two
   things to do differently: Ephesus's gates are durable, and repository content
   does not arm them.
2. **Both sources deny a gated action when nobody is there.** M9f.4 holds it and
   tells the Architect instead, and lets it lapse with the run: the outcome is the
   same, but it is not silent (invariant §7).
3. **The pairing standard is the gateway's, not the LAN bridge's** (DD-M9-15):
   short-lived codes, attempt limits, a lockout, approval at the machine.
4. **Three conveniences are deliberately not taken**: a standing grant created by
   a chat reply, a model that approves on the Architect's behalf, and a sandbox
   that switches the gate off by being a sandbox.
5. **Neither source has what DD-M9-15 asks for.** One has a bearer token in a QR
   code over plain HTTP; the other has no phone client at all. M9h is designed
   from Ephesus's own record, not from a pattern to adopt.
6. **A blind comparison whose mapping lives in the browser is a courtesy, not a
   blind** (3.1, by the source's own words). M9c.5 keeps the mapping in main.

## 4. The rules every capability enters under

These are what make sixteen features one harness. Each is an existing rule of this
repository applied to new ground, and each package in §6 is checked against all of
them.

1. **The bench comes with the capability.** M9-PLAN §4's thesis extends: a
   capability that is a harness contribution is a **switch** in the ablation
   protocol (FR-16.3), and every milestone lands at least one **bench task** whose
   verifier lives outside every agent's reach (§7). A milestone's exit quotes ledger
   rows, whatever the numbers are.
2. **Headless-first.** A capability is a main-process service behind `IpcDeps`
   (FR-15.6). The window, `ephctl`, a chat platform and a phone are clients of the
   same handlers — the `Pick<IpcDeps, …>` shape of ADR-0033 — so no feature exists
   only in the renderer and no two surfaces can drift.
3. **Native first, wrapped where the engine allows.** New tools are tools of the
   native engine's registry (FR-15.4). A wrapped `claude` hire receives one only
   where the harness can re-supply it by name and conformance proves it took effect
   (the M8.7b precedent); otherwise the record says it is native-only.
4. **Granted by name, shown before anything starts.** Web reach, an execution
   backend, a skill, a connector, a schedule: each is declared in the hire template
   or the profile and appears on the activation screen (ADR-0012). The one recorded
   exception is the MCP registry, which is company-wide by the Architect's decision
   (DD-M9-13).
5. **Untrusted by default, and provenance arms the gate.** NFR-18 already says
   everything an agent reads is data. M9.3 records it (`trusted: false`, with
   provenance). M9d.3 makes it a mechanism: once content from outside the company is
   in a hire's context, an action that writes to the world needs a human (DD-M9-12).
6. **A human authorises; a surface only carries the authorisation.** A paired phone
   or chat account carries the Architect's verdict over an authenticated channel
   (FR-10.2, NFR-9), with repeat-back for what cannot be undone (FR-8.4). A script
   still authorises nothing (ADR-0033). Secrets, the company mode and the
   registries stay at the machine.
7. **A zero-dependency core, and a memo for every addition** (DD-M9-9). M9 stays
   as approved. After it, each capability is built on platform `fetch`, `node:`
   builtins or an **owned subprocess** first — the discipline ADR-0009 and ADR-0016
   set for engines and MemPalace: version probe, visible install offer, no hidden
   daemon. A library or a bundled service that cannot be avoided gets its decision
   memo at its package (invariant §10). §10 lists the candidates so that none
   arrives as a surprise.
8. **Every degradation visible** (invariant §7). A missing backend, service, key or
   model refuses by name or degrades in view. `NOT EXERCISED` is never rendered as
   working (the M8.13 rule).
9. **One operator** (SRS §1.2). Every surface serves the Architect. Another person's
   message on a shared platform is data, or is not read at all.
10. **The brand core is kept** (C8). A capability goes to the subsystem whose job it
    is. A new city name is the Architect's to give, and only where no home exists.

## 5. What changes in the contract, and what does not

### Amended at plan time (2026-10-03)

- **SRS §1.2.** The scope list gains the phase's capabilities by reference to this
  file. Two SHALL NOT lines are amended, each with its date and reason: *"replace
  the underlying agent CLIs"* had been stale since ADR-0036 and now says that
  wrapped hires keep their CLI as the runtime while the native engine is the
  harness's own; *"run agents on remote machines over SSH"* becomes *an agent's
  loop never runs anywhere but the Architect's machine; its tool execution may run
  in a backend the hire declares* (DD-M9-14). The single-operator and no-training
  lines stand.
- **ADR-0040** — the floor is a view mode — accepted on DD-M9-11.

### Owed, each by the contract package (`.0`) of its milestone

As M9.0 does for M9: each milestone opens with a package that writes its ADRs, its
SRS requirement group and acceptance test, its SDD section, its THREAT-MODEL
section and its TEST-STRATEGY rows, and runs one governed `/research` cycle at a
pinned commit so the design cites a brief and not this plan. ADR and FR numbers are
assigned when written; ADR-0037 to ADR-0039 are M9's.

| Milestone | ADRs owed (working titles) | Requirement group | Suites owed |
|---|---|---|---|
| M9b | A conversation is a projection of the transcript · Skills are granted procedures: the Architect installs, an agent may only propose | Workspace and conversation; skills; the Architect's profile and notes | S-WORKSPACE, S-SKILL |
| M9c | Model weights and model servers are a dependency class the Architect installs · Judged rows: the Architect's blind verdict (the ADR M9-PLAN §4 owes) | The model service; comparison and the council | S-MODELS, S-ARENA |
| M9d | Execution backends: the loop stays, the tools may move · Provenance arms the gate · The company's MCP registry, and the harness as the only MCP client · Delegation within a hire's own grants | Backends; armed gates (extends FR-11.1); MCP; delegation and scripted tool calls | Backend conformance table; S-TAINT, S-MCP, S-DELEGATE |
| M9e | Web reach is a grant, and the open web is a source without a pin · Inquiries: the Stoa studies questions as well as repositories | Web tools; inquiries (extends FR-13); documents | S-WEB, S-INQUIRY, S-DOCS; E-RESEARCH |
| M9f | The gateway: platforms are surfaces of one conversation, and identity is paired · Remote authorisation (extends ADR-0033, NFR-9) · A schedule is a consented plan (extends ADR-0032, ADR-0027) · A browser surface on loopback, never without a session (a new surface beside ADR-0033's, whose "no TCP port" was decided for the control socket) | Gateway (rewrites FR-10.2 additively); schedules; push; the browser surface | Platform conformance table; S-GATEWAY, S-REMOTE-APPROVE, S-SCHEDULE, S-BROWSER-SURFACE |
| M9g | Mail and calendar are connectors behind the outbound gate | Mail; calendar and todos | S-MAIL, S-CAL; E-TRIAGE |
| M9h | The companion: a paired device is an authenticated surface — identity, pairing, channel, authority, reach (DD-M9-15) | The companion | S-COMPANION |

THREAT-MODEL gains, in the package that creates each surface and not after: the
tool-execution backends and what each does and does not bound (§6.7 rewritten);
open-web egress (§4 gains "the harness fetches URLs an attacker chose"); MCP supply
chain; the gateway and remote authorisation; the browser surface; mail as untrusted
input at volume; the companion — a lost phone, a hostile network, a replayed
session.

### What does not change

The thirteen invariants, by name and without exception. The two data planes
(ADR-0002). The single committer (ADR-0004). Secrets write-only (ADR-0010) — every
new credential (bot token, OAuth refresh token, provider key, SSH key, push topic)
is a broker secret that reaches a process only by env injection, and no agent
process receives one a connector can hold instead. Owned spawn (ADR-0014). The
Stop-hook loop (ADR-0013). Gymnasium governance (ADR-0015): nothing self-approves,
and an agent-authored skill is a proposal. Company modes (ADR-0018): the mode
governs initiative, never approval. Consent before start (ADR-0032). A script
authorises nothing (ADR-0033). One harness per home (ADR-0034). And all seven M9
decisions of 2026-10-02.

## 6. The milestones

Format follows `docs/IMPLEMENTATION.md` and M9-PLAN §6: what, then *Docs · Tests ·
Risk*. Each package is one PR, ends with its suite output in the record, owes a
mutation round from a checked-in `test/mutation/<package>.json` with a control
(GYM-008), and owes an adversarial refutation pass where it is gate-shaped —
marked **[gate-shaped]** below.

---

### M9b — The workspace: a harness you talk to (≈ 7 weeks)

The window stops being a floor with panels and becomes a place to talk to the
company and read what it did. Needs M9 complete: the conversation is a view of the
native engine's transcript (M9.2), and the window is already a client of `IpcDeps`
(M9.7).

- [ ] **M9b.0 The contract** (≈ 3 days) — the two ADRs of §5; the SRS group and
      acceptance test; SDD section; the UI-DESIGN §4 amendment (app shell as view
      modes; the workspace's panel anatomy from the existing tokens — a new token is
      a design-doc change first); S-WORKSPACE and S-SKILL rows; the T-SKILL bench
      task and the `skills` switch specified; one `/research` cycle per source at a
      pin, scoped to the watchlist row's tags (DD-M9-17).
      **Asked here, in series:** which engine Artemis herself runs on by default
      once `native` has passed ADR-0024's bar at M9's exit.
      *Docs: everything above. Tests: link check, ADR append-only check, brief
      validation. Risk: UI-DESIGN is canonical; a workspace designed in code and
      documented afterwards is the drift `/doc-sync` exists to catch.*

- [ ] **M9b.1 View modes** (≈ 3 days) — ADR-0040 built. `config.json` gains an
      optional `view` (`workspace` | `floor`); **absent means `workspace` on every
      install**, and the first launch after the change says once where the floor
      went. The floor's module graph is imported only in `floor` mode and its ticker
      is not constructed otherwise. The dock, the status strip, the command bar and
      the approvals post are the window's and appear in both. Switching needs no
      restart and loses nothing, because a mode holds no state.
      *Docs: ADR-0040, UI-DESIGN §4. Tests: in `workspace` mode no `floor/` module
      is imported (asserted on the module graph, and by a reachability walk from the
      workspace entry); every existing floor suite stays green and stays in CI; the
      **upgrade path** — a `config.json` written before the field existed opens the
      workspace and shows the notice once (the seeded-only-when-absent lesson: test
      the old home, not a fresh one); headless boot unaffected. Risk: a mode nobody
      opens rots unseen. The Herald is the precedent — 1,406 lines with no caller
      for a milestone. The floor suites in CI and a reachability walk from the
      `floor` entry are the containment.*

- [ ] **M9b.2 The conversation** (≈ 1.5 weeks) — main gains `conversation.ts`: a
      **pure projection** of a hire's transcript into conversation items — the
      Architect's text, the agent's text, each tool call with its result (carrying
      `trusted: false` and its provenance), each gate with its live state, each
      compaction boundary, each stall or degradation, and per-turn usage from the
      cost ledger. One read (`conversation(agentId, cursor)`) and one push
      (`conversation:append`) through `IpcDeps`; **input goes down the path that
      already exists** — `commands.submit`, with FR-1.3's queue-until-idle and hold
      semantics — so there is one way to speak to an agent, not two. Text still
      being generated arrives as the existing `notification` envelope and is pushed
      without being logged; no new envelope kind. The renderer shows the thread, a
      card per tool call, and a gate **inline** with *what, why, blast radius,
      rollback* and the same `watch.approve` the approvals post calls. A wrapped
      hire shows its terminal in the same frame, because the terminal is the truth
      for an engine whose transcript is the vendor's (UI-DESIGN §1, principle 6:
      the terminal is sacred). Control
      surface: `ephctl converse` and `conversation:tail` — a send is logged
      `remote`, a read is not (ADR-0033).
      *Docs: the conversation ADR, SDD. Tests: the projection over fixture
      transcripts, every item kind; an inline approval reaches the identical
      handler as the approvals post (one spy, two callers); model output and tool
      results render inert — a planted `<img onerror>`, a `javascript:` link and a
      raw HTML block do nothing, because the renderer is untrusted (invariant §2);
      a wrapped hire yields a terminal, never a guessed transcript; the partial
      push never reaches `log.jsonl`. Risk: a second telling of what the agent did.
      The conversation must stay derived — ADR-0027 §5 forbids persisting what a
      durable source already holds — and rendering model-written markdown is the
      renderer's largest injection surface, so the renderer for it is either small
      and ours or a library with a memo (§10).*

- [ ] **M9b.3 Sessions, and choosing a model** (≈ 1 week) — "chat with a local or
      API model" is a hire like any other: a built-in `companion` template (prompt
      in `prompts/agents/`), a native hire with read-only tools and `manual`
      autonomy unless the Architect grants more. A new conversation names a
      provider and a model **from the capability records** (M9.2; `verified` once
      M9c.4 lands), so a model below the context floor or without native tool calls
      is refused in the picker, by name, and not at the first message. Sessions are
      transcripts of a standing hire, not hires: listed from `engineConfigDir`,
      resumed by M9.2's replay, titled, and searchable through a `sessions` scope
      on the Library's FTS rung (ADR-0006's ladder, visible as ever). **Artemis
      stays the front door** — the workspace opens on her thread. Consent
      (ADR-0032) names what a conversation spends: a provider key's money, or a
      local model's time.
      *Docs: FR-1, ADR-0006. Tests: resume leaves the stable tier byte-identical
      and folds no usage twice (M9.4's boundary rule); session search with
      known-answer queries; the picker's refusals; the session list after a restart
      (derived from files — no store to lose). Risk: the roster filling with dead
      conversations. A conversation is a session; an ephemeral companion is archived
      like any exited agent (FR-1.4).*

- [ ] **M9b.4 Attachments** (≈ 3 days) — a file or an image dropped into a
      conversation is validated in main (type, size), written atomically into the
      hire's workspace and referenced by the message. An image goes only to a model
      whose capability record says `vision`; otherwise the send is refused naming
      the models that could take it. Never dropped in silence.
      *Tests: type and size refusals; path containment; no attachment bytes in
      `log.jsonl`; the vision refusal. Risk: the Architect attached the file but
      did not write what is in it. An attachment is `trusted: false` with
      provenance `attachment:<name>` and arms the gate from M9d.3 on.*

- [ ] **M9b.5 Skills** (≈ 1.5 weeks) **[gate-shaped]** — the `SKILL.md` format
      (front matter `name` and `description`, a body, optional scripts and
      references) under `~/.ephesus/tools/skills/`, the Architect-editable home
      M8.7b already grants from. **Import** reuses FR-10.4's split: `skills:inspect`
      reads a folder, an archive or a git URL at a pinned commit (cloned by
      `git.ts` into quarantine outside every granted root) and returns a recomputed
      disclosure — files, sizes, executables, network installers, secret-shaped
      strings, license — writing nothing; `skills:install` is what a confirmed form
      reaches. **Grant** is the existing `tools` field of a hire template. The
      native engine carries the index (name and description) in its context tier
      and loads a body on demand through a `skill` tool; a wrapped `claude` hire
      receives the directory as `--plugin-dir`, as today. **Propose:** an agent may
      draft a skill; it is linted (front matter, size, no secret shapes, no
      install-from-network step) and becomes a **Gymnasium proposal** of class
      `playbook` with a falsifiable metric (FR-12.2), verdicted by the Architect
      (FR-12.3). No agent path installs or edits an installed skill — the grant is
      read-only, for the reason M8b's playbook grant is: an agent that can rewrite
      its procedure can lower the bar it is judged against. A closing-time prompt
      (`prompts/library/`) asks whether a reusable procedure emerged.
      *Docs: the skills ADR, ADR-0015, ADR-0026. Tests: S-SKILL — inspect writes
      nothing; an instruction planted in a skill is data until the Architect
      installs it; no agent or tool path writes under `tools/` (asserted by API
      surface, the S-SECRETS pattern); a proposal without a metric never reaches a
      human; each lint refusal names its rule; a granted skill takes effect on
      native and wrapped hires (effect, not mechanism) and an ungranted one is
      invisible. Bench: T-SKILL with the `skills` switch on and off. Risk: a skill
      is the one place outside text becomes trusted instruction. The Architect's
      install is the gate, and R11 is why an agent-written one rides the
      Gymnasium.*

- [ ] **M9b.6 What the company knows about the Architect, and notes** (≈ 4 days) —
      the Library gains `architect.md`: what the company has learned about how the
      Architect works. Agents propose entries to the reserved `agent.library`
      endpoint (the reflection route); the Architect reads and edits it in the
      Memory panel; it enters the stable tier inside a budget, and an over-budget
      write **returns an error naming the budget**, so the agent consolidates
      rather than the file growing. Notes are quick capture from the workspace into
      the knowledge shelf (`registerKnowledge`, FR-6.4, through the single
      committer) and are recallable at once.
      *Docs: ADR-0006, FR-6. Tests: the budget error; the profile byte-stable
      across a session; note → recall with a known answer; the Architect's edit
      wins; no agent writes the file directly. Risk: a quiet place for an injected
      "preference" to become a standing instruction. Every entry carries its source
      ref, and from M9d.3 an entry proposed from a tainted context is held for the
      Architect.*

- [ ] **M9b.7 Exit review** — the bar below, by `/milestone-review`.

**Exit.** (1) A fresh home and an upgraded home both open on the workspace; the
floor is one switch away with every floor suite green; the workspace's module graph
reaches no `floor/` module. (2) A conversation with a native Artemis carries a
T1-shaped piece of work end to end from the conversation view, with a gate approved
inline through the one handler. (3) The skills uplift is **measured**: T-SKILL with
`skills` on and off, N ≥ 3 per cell, rows with conditions, whatever the numbers
are. (4) An agent-proposed skill sits in the Gymnasium ledger as `proposed`, and no
path installs it without a verdict. (5) Session resume and search pass; the
conformance table still has four subjects and no special case. (6) Every added
dependency has its memo; no invariant weakened; docs synced.

---

### M9c — The hearth: local models, first-class (≈ 7 weeks)

*"The hearth" is a working title — a city name for this subsystem is the
Architect's to give at M9c.0.* M9.2 runs a local model only if the Architect has
already found one, fitted it to the machine, served it and typed its URL. This
milestone makes that the harness's job, and gives the bench the judged half it has
been owing. Needs M9 complete; independent of M9b and may run beside it.

- [ ] **M9c.0 The contract** (≈ 3 days) — the two ADRs of §5. The first is the
      decision memo for a new dependency class, as ADR-0016 was for Python and
      MemPalace: model weights and model servers. Its rule is ADR-0028's, widened —
      *the company does not fetch its own models*: nothing is downloaded or
      executed except by the Architect's act, and a server binary is never
      downloaded by Ephesus at all. THREAT-MODEL gains the supply chain of weights
      (a model file carries a chat template the server will execute).
      **Asked here:** a city name for the subsystem, or none; and whether a script
      may start a pull (operating the company, as activation is) or only the
      window may (authorising something new) — ADR-0033's line, which this plan
      does not draw for him.
      *Tests: as M9b.0. Risk: the name. A second metaphor layer is what C2 warned
      about; "no new name" is a legitimate answer.*

- [ ] **M9c.1 What the machine is** (≈ 4 days) — `hardware.ts`: CPU, memory and
      free disk from `node:os`; GPUs and their memory from owned probes
      (`nvidia-smi`, `system_profiler` on macOS, and a Windows fallback flagged
      low-confidence where the platform's own figure is known to truncate). The
      result is a `schemaVersion`'d fact with the provenance of each number, and
      **`unknown` where a probe failed — never a guess**. Read from the Watch and
      from `ephctl hardware`.
      *Tests: each parser runs over a **recorded capture** with its command,
      version, platform and date (TEST-STRATEGY §5's rule, the M8.4 lesson); a
      missing tool yields `unknown` and a degradation; probes are argv arrays,
      never shell strings. Risk: a confidently wrong memory figure makes every fit
      verdict confidently wrong. The provenance is shown, and M9c.4's measurement
      is the truth.*

- [ ] **M9c.2 The catalogue, and what fits** (≈ 1 week) — `models/catalog.json`,
      shipped and extendable in the home: family, parameter count, each quantised
      variant with its size, sha256 and source, declared context length, claimed
      tool-call support, license. Fit is a **pure function** of the hardware fact,
      a variant and the hire's context floor. In plain terms: the memory a variant
      needs is its file size, plus the key-value cache for the context it must
      hold, plus the runtime's overhead,

      `need(v, n_ctx) = size(v) + n_layers · n_ctx · d_kv · b + overhead`

      where `d_kv` is the width of the keys and values one layer stores per token
      and `b` the bytes per element. The verdict is `fits`, `fits with offload`,
      `CPU only` or `does not fit`, with the limiting resource named and a declared
      safety margin. The formula, its constants and their sources are owed in full
      by the package's implementation doc, so the arithmetic can be audited without
      reading the code.
      *Tests: table tests on the boundaries (exact fit, one block over, zero GPU);
      every verdict names its limiting resource; the validator refuses a catalogue
      entry without a hash or a license. Risk: "fits" says nothing about whether
      the model can call a tool. That is M9c.4's probe, and the screen must not let
      one read as the other.*

- [ ] **M9c.3 Downloads** (≈ 4 days) **[gate-shaped]** — started by the Architect
      from the window, and from the control surface only if M9c.0 decides a pull is
      operating the company; **never by an agent**. Resumable ranged `fetch`; the sha256 is verified before the
      file receives its final name (temp file + rename); stored under
      `~/.ephesus/models/`, outside the Agora; one log row per pull; a disk ceiling
      that a script may lower and not raise; the license shown before the pull; a
      gated model's token is a broker secret. A redirect to a host the catalogue
      entry does not name is refused.
      *Tests: a wrong checksum refuses and leaves nothing behind; resume after a
      kill; the ceiling; the redirect refusal; the token in no argv and no log; **no
      agent or tool path reaches a pull** (API surface). Risk: supply chain — a
      catalogue entry is a pointer to gigabytes of someone else's bytes. The pin is
      the hash, and adding an entry is the Architect's act.*

- [ ] **M9c.4 Serving, and the verified capability** (≈ 1.5 weeks) — a
      `ModelServer` seam with three kinds. **`owned`**: Ephesus spawns llama.cpp's
      server as an owned subprocess — loopback only, an ephemeral port, a per-run
      key, flags taken from the fit verdict — under the engine discipline: a
      version probe from a recorded capture, a visible install offer (FR-1.6), no
      hidden daemon, a place in the quit sequence after the agents. **`declared`**:
      the Architect writes the command line (vLLM, SGLang or anything else that
      serves the OpenAI-compatible API); Ephesus launches and watches it and does
      not pretend to know its flags. **`attached`**: a URL the Architect runs —
      M9.2's case, unchanged. Each served model gets a **capability record that is
      probed, not claimed**: context length read from the server, and a real
      tool-call round trip, each marked `verified`, `claimed` or `unsupported` with
      its date. M9.2's refusals read the verified value where one exists and say
      which they read. A short measured throughput figure joins the bench
      condition, with the server kind, its version, the quantisation and the
      offload. Local capacity is a resource like ADR-0023's usage window:
      `capacity.ts` learns the server's concurrent slots.
      *Docs: ADR-0038, FR-15.2. Tests: a fake server under `test/fakes/`; a server
      that dies mid-turn is a degradation and a `ghost`, never a hang; the port is
      bound to loopback only (asserted); the per-run key in no log; a `declared`
      command appears on the consent screen before it runs. Risk: vLLM and SGLang
      do not run natively on Windows, the Architect's platform. `declared` and
      `attached` are the honest answer, and the record says which kinds were
      exercised on which platform — `NOT EXERCISED` is not a pass.*

- [ ] **M9c.5 Compare: the Architect's blind verdict** (≈ 1 week) **[gate-shaped]**
      — `arena.ts`. A comparison names a prompt or a bench task, the contenders
      (models, or harness configurations — switch sets — or both), and N. Outputs
      are shown under labels assigned by a recorded random permutation; **the
      mapping stays in main until the verdict is written**, so the judging surface
      cannot show it. The Architect ranks, picks or ties, with an optional note;
      the verdict is appended, immutable, beside the scored rows — in its own
      table, flagged `judge: architect-blind`, with each contender's full
      condition, never averaged with a scored row and low-confidence under three
      runs. Then the reveal — and only then any synthesis of the contenders'
      answers (M9c.6), because an analysis shown first would steer the verdict it
      precedes. A verdict is a judgment only a human makes: asked of `ephctl`, it
      is refused by name.
      *Docs: the judged-rows ADR, FR-16. Tests: S-ARENA — no read channel of the
      judging surface returns an identity before the verdict; the permutation is
      recorded; a verdict is immutable; a scripted verdict is refused with the
      rule. Risk: R18. A model judging models is forbidden here — the judge is the
      human, which is what makes this the honest judged half. It is blind **at the
      judging surface**, not secret from an Architect who opens the log, and the
      record says so.*

- [ ] **M9c.6 The council** (≈ 4 days) — multi-model reasoning, as a `consult` tool
      and as the arena's "synthesise". N reference models answer in parallel — plain
      provider calls, with no tools and therefore no new authority — and an
      aggregator merges them. Every reference answer enters the transcript as
      `trusted: false` with provenance `model:<id>`; each call is its own ledger
      line; a hire needs the `consult` grant, which names the models, because the
      money is theirs to spend. Bench: a `council` switch — does a council beat its
      best member on the task set? Measured, not assumed.
      *Tests: fake providers; one reference failing is a degradation naming how
      many answered, never silently fewer; the ledger total equals the sum of the
      calls; an instruction planted in a reference answer is not obeyed. Risk: cost
      multiplies by N + 1 quietly. The estimate is shown before the call and the
      ceilings apply.*

- [ ] **M9c.7 Exit review.**

**Exit.** (1) On the Architect's machine: scan → fit → pull, with the checksum
verified → serve → capability `verified` → a native hire runs bench T1 on that
model, and the row's condition names the server, the quantisation and the offload.
(2) No agent path can pull or serve; a failed checksum refuses. (3) One blind
comparison of at least two contenders, N ≥ 3, with the Architect's verdict
recorded and no identity readable from the judging surface before it. (4) The
council measured against its best member, whatever the number. (5) The kinds and
platforms exercised are recorded honestly.

---

### M9d — The walls and the hands: contained execution, armed gates, MCP, delegation (≈ 8–9 weeks)

M9 gives a native agent tools bounded by path containment and the gate, with no OS
sandbox, and says so (M9-PLAN R20; THREAT-MODEL §6.7). Everything after this
milestone feeds agents content from strangers — web pages, mail, tool servers. So
the walls come first.

- [ ] **M9d.0 The contract** (≈ 4 days) — the four ADRs of §5; THREAT-MODEL §3, §5
      and §6.7 rewritten to say what each backend bounds and what it does not; the
      backend conformance table specified; S-TAINT, S-MCP, S-DELEGATE; the T-INJECT
      and T-FANOUT tasks and the `backend`, `armedGate` and `delegate` switches.
      **Asked here:** whether NFR-17's researcher rule is amended for the MCP
      registry (see M9d.4); and **what arms the gate** — DD-M9-12 named fetched
      content, and M9d.3 as planned also arms on mail, MCP results, attachments and
      other people's messages, and does not arm on a target repository's content.
      Both halves are this plan's proposal, not yet the Architect's decision.

- [ ] **M9d.1 The backend seam, `local` and `docker`** (≈ 1.5 weeks)
      **[gate-shaped]** — `ExecBackend`: prepare, execute, the file operations,
      dispose. **The loop never moves** (DD-M9-14): `eph-agent`, its PTY, its hooks
      and its mail stay on the Architect's machine; what a hire declares is where
      its *tools* run. Lifecycle is main's (created at spawn, removed in the quit
      sequence); execution is the engine's, through argv arrays. `local` is M9.3's
      behaviour. `docker` drives the `docker` CLI as an owned subprocess: one
      container per hire session, the worktree bind-mounted, a non-root user, all
      capabilities dropped, no new privileges, a read-only root, resource limits,
      **no network unless the hire's `egress` grant says otherwise**, no Docker
      socket, and an environment of the allowlist plus declared grants and nothing
      else. Images are pinned by digest and pulling one is the Architect's act. A
      backend **declares its isolation grade** — `none`, `filesystem`, `container`,
      `vm`, `remote` — and a conformance table checks the declaration in both
      directions (ADR-0031's method): containment, environment hygiene, network
      policy, limits, what persists between calls, kill and timeout, clean-up. The
      company-wide floor lives in `gate-policy.json` and composes stricter-wins.
      *Docs: the backends ADR, THREAT-MODEL §6.7. Tests: the table, against a fake
      `docker` everywhere and the real one where it exists (Linux CI has it; a
      platform without it is `NOT EXERCISED`); a path escape, a blocked host and a
      forbidden environment variable each refused from inside the container. Risk:
      a container is not a guarantee, and Docker on Windows and macOS is a Linux VM
      with its own path and performance behaviour. The grade says what is bounded;
      §6.7 says what is not.*

- [ ] **M9d.2 `apptainer`, `ssh` and `modal`** (≈ 1.5 weeks) — three more
      implementations behind the same table. **`apptainer`** (Singularity): rootless
      containers where Docker is not allowed. **`ssh`**: the system's OpenSSH
      client as an owned subprocess; a host is registered by the Architect with its
      host key pinned at registration, and a changed key refuses by name; the
      workspace lives on the remote, so the harness creates no worktree there and
      says so on the activation screen. **`modal`**: a cloud sandbox on the
      Architect's own account, its token in the broker; code leaves the machine to
      a provider the Architect configured (NFR-10), and consent names the provider
      and that it bills.
      *Tests: `ssh` against a local daemon fixture or a fake binary; a host-key
      mismatch; a connection lost mid-command is a visible degradation and the tool
      result says so; `modal` behind a fake. Risk: each is credentials, egress and
      cost at once, and each may be honestly `NOT EXERCISED` on the machines this
      project has. Modal's client is a new external program and needs its memo
      (§10).*

- [ ] **M9d.3 Provenance arms the gate** (≈ 1 week) **[gate-shaped]** — the
      mechanism M9.3 recorded the data for. A hire's context is clean until content
      whose provenance is **external** enters it: a web page, a search result, a
      mail body, an MCP result, an attachment, a message from anyone but the
      Architect, or the output of a child that read any of those. From then on, for
      that session, **the hire may read more but may not write to the world without
      a human**. M9.3 already gates every shell command no grant covers; what
      changes under taint is that the `unattended` grants which let a command run
      unasked (ADR-0035) stop applying, and every outbound act becomes a gate — a
      post or a send, a push, an MCP tool of class `side-effect`, a web request
      carrying model-chosen data to any host but the configured search backend.
      Two things lift it: the call runs in a backend with no egress and no secret
      grant, or it matches a grant the hire template declares taint-tolerant. Edits
      inside the worktree continue: they are reviewable diffs. The flag cannot be
      washed off: compaction keeps it (a summary of tainted content is tainted), a
      child's taint returns with its result, mail sent from a tainted session
      carries it to its reader, and a memory write from a tainted context is held
      from the stable tier until the Architect has seen it. Repository content stays governed by NFR-18 and the
      existing gate classes — it does not arm this rule, or every coding agent
      would be armed from its first read and the unattended hour would end in
      approvals.
      *Docs: the armed-gate ADR, FR-11.1, NFR-18, THREAT-MODEL §6.1. Tests: S-TAINT
      — each origin arms; each held class is held; an `unattended` grant stops
      applying and a taint-tolerant one does not; the sandbox exemption applies
      there and nowhere else; compaction, delegation, mail and memory each carry
      the flag; a refusal teaches the rule. **Bench: T-INJECT** — fixture content with a
      planted instruction and a canary. A run in which the canary leaves is invalid
      whatever else it scored; the verifier is the fixture server's own access log.
      Run with `armedGate` on and off. The adversarial pass is budgeted. Risk: in
      both directions. Armed too widely, the Architect is asked so often that
      approval becomes a reflex — the bench counts gates opened per task as a cost.
      Armed too narrowly, a secret leaves. §6.1's sentence stays true: mitigated,
      not solved.*

- [ ] **M9d.4 MCP: the company's registry, the harness as the client** (≈ 1.5
      weeks) **[gate-shaped]** — `mcp-registry.json`: the Architect registers a
      server once — its transport (a command, or a URL), a pinned version or
      digest, the broker secrets it needs, and a **snapshot of its tool manifest**
      taken at registration and shown before it is accepted. Registration is
      authorising new capability, so `ephctl` refuses it by name. **The harness is
      the only MCP client**: main spawns a stdio server as an owned subprocess with
      the filtered environment (optionally inside a backend), speaks the protocol,
      and offers each tool to native hires as `mcp__<server>__<tool>` — fixed at
      spawn, since the stable tier does not change mid-session. A call travels
      engine → hook endpoint → main → server. So **the server holds its credentials
      and no agent ever does**. A result is `trusted: false`, provenance
      `mcp:<server>/<tool>`, and arms the gate. Each tool carries a class set at
      registration, `read` or `side-effect`, defaulting to `side-effect`, and a
      side-effect call passes the Watch's gate policy like any other action. A
      server whose tool list or descriptions no longer match the registered
      snapshot is refused by name until the Architect looks again.
      **Company-wide, by decision (DD-M9-13):** every native hire may use every
      registered server; a hire template does not name them. One standing
      requirement narrows that as written — NFR-17 gives a researcher no
      credentialed capability, so a Stoa researcher sees only servers registered
      without secrets and read-only, unless the Architect amends NFR-17 at M9d.0.
      Wrapped `claude` hires get the same tools through a stdio shim to the hub, if
      and only if conformance shows the engine honouring it under ADR-0026's
      settings isolation; otherwise MCP is native-only and the record says so.
      Ephesus's own recall and knowledge shelf are offered the same way.
      **And the other direction:** a shipped `SKILL.md` teaches an outside agent
      CLI — the Architect's own Claude Code or Codex session — to operate the
      company through `ephctl`. It adds no surface, because `ephctl` is the
      surface: the skill can run the company and can authorise nothing, and it
      teaches the four refusals by name (ADR-0033).
      *Docs: the MCP ADR, ADR-0026, ADR-0010. Tests: S-MCP — a fixture server end
      to end; manifest drift refused; the secret reaches the server's environment
      and no agent's environment, transcript or log (the S-SECRETS pattern); a
      `side-effect` call is held where policy holds it; a crashed server is a
      degradation naming it; a scripted registration is refused; the researcher
      rule. Risk: an MCP server is somebody else's code holding a credential, and
      by decision it reaches the whole company. The registry is the Architect's one
      review point; the residual goes into THREAT-MODEL in plain words. The client
      is hand-written over `node:` builtins unless a memo says otherwise (§10).*

- [ ] **M9d.5 Delegation** (≈ 1 week) — a `delegate` tool. A native hire hands a
      sub-task to an **ephemeral worker**: an owned spawn with its own PTY, its own
      transcript and its own hook stream, so it is as visible as any agent; grants
      that are a subset of its parent's and an autonomy no looser (stricter-wins);
      only the goal and the context it was handed, none of the parent's history; no
      `delegate` of its own; mail to its parent and nobody else; a turn cap and a
      time box; its spend charged to the parent's ledger line; a concurrency cap
      per parent and per company. Its answer returns as a tool result — untrusted,
      provenance `agent:<id>`, carrying any taint — and the worker is torn down, as
      it is if the parent dies. Artemis's routing (ADR-0005) is untouched: this is
      fan-out inside one task; work addressed to a standing agent still goes by
      Hermes mail with its hop caps. FR-10.2's "ephemeral workers torn down after
      replying" is built once, here, and the gateway reuses it.
      *Docs: the delegation ADR, ADR-0005, ADR-0011. Tests: S-DELEGATE — a child
      asking for more than its parent holds is refused by name; the depth cap;
      teardown leaves no process, no worktree and no roster row (the s-crash
      pattern); the breaker sees a looping child; ledger attribution; a killed
      parent takes its children. Bench: T-FANOUT with `delegate` on and off. Risk:
      spend multiplies, and a fan-out is a place for a loop to hide.*

- [ ] **M9d.6 Scripted tool calls** (≈ 4 days) **[gate-shaped]** — `run_script`.
      The model writes a short program; it runs in the hire's backend with a client
      for a declared subset of the hire's own tools (never `delegate`, `mail` or
      itself); each call takes the same pre-tool path, so a held call holds the
      script and a refusal raises inside it; only the program's final output
      returns to the context, carrying the provenance and taint of everything it
      touched. Bounded by a time box, a call cap and an output cap, and each call
      still emits its hook rows, so the waterfall and the breaker can see inside.
      *Tests: a gated tool is held inside a script exactly as outside; the run's
      token is scoped to the run; the caps; taint carried; a tool the hire lacks is
      unreachable. Risk: a script is a loop the breaker cannot see turn by turn.
      The call cap and the clock are its eyes.*

- [ ] **M9d.7 Exit review.**

**Exit.** (1) The backend table is green for `local` and `docker` in CI; every
other backend is recorded with the platform it ran on, or as `NOT EXERCISED`.
(2) T-INJECT on two models, N ≥ 3: zero canary leaks with the gate armed, the
unarmed cell recorded whatever it shows, zero parked engine prompts, and the number
of gates opened reported as a cost. (3) MCP end to end against the fixture server;
drift refused; no secret in any agent's reach. (4) T-FANOUT with and without
`delegate`; teardown proven. (5) The adversarial passes for the armed gate, MCP
registration and the backend seam are in the record with what they tried.

---

### M9e — The open web and the research desk (≈ 7–8 weeks)

Until now the harness itself talks to GitHub and to nothing else (THREAT-MODEL §5).
This milestone lets a hire that holds the grant read the open web, and gives the
Stoa a second kind of study. Needs M9d: the armed gate and a contained backend
exist before the first stranger's page is read.

- [ ] **M9e.0 The contract** (≈ 4 days) — the two ADRs of §5. NFR-10 is amended to
      say what egress now is: GitHub hosts, the backends the Architect configured,
      and the hosts reached by a hire that holds the `web` grant — nothing else,
      and a scenario test audits it. THREAT-MODEL §4 gains its new first line: the
      harness fetches URLs an attacker chose. FR-13 gains inquiries. S-WEB,
      S-INQUIRY, S-DOCS and E-RESEARCH; the T-RESEARCH task and the `web` switch.
      **Asked here:** whether the browser may ship on the pinned Electron (M9e.2),
      and whether search is `owned` or `attached` (M9e.1).

- [ ] **M9e.1 Search and fetch** (≈ 1.5 weeks) **[gate-shaped]** — the `web` grant
      in a hire template: `search`, `fetch`, `browse`, and an `egress` policy (an
      allowlist, or open). A hire without it has no web tool in its registry at
      all. `web_search` goes to a `SearchBackend` — first a SearXNG instance, either
      `attached` (the Architect's own URL) or `owned` (run by Ephesus, as a
      container through M9d.1's driver; its memo is §10's) — and later, by key,
      whatever API the Architect configures. `web_fetch` is GET only, `http` and
      `https` only; the name is resolved and **loopback, private, link-local and
      metadata addresses are refused, again after every redirect, and the
      connection goes to the address that was checked**; size, time and
      content-type caps; text extracted to markdown. The response's hash, URL and
      retrieval time go into a content-addressed archive in the home, so a citation
      still resolves after the page changes. Every result is `trusted: false`,
      provenance `web:<url>#<hash>`, and arms the gate (M9d.3).
      *Docs: the web ADR, NFR-10, THREAT-MODEL §4/§5. Tests: S-WEB — the refusal
      table (loopback in every spelling, the private ranges, a name that resolves
      to one, a redirect to one, the cloud metadata address); the caps; the archive
      hash stable; provenance on every result; an ungranted hire has no web tool; a
      fixture web server under `test/fakes/`; the egress audit over a whole
      scenario run. Risk: a query is model-chosen text leaving the machine, so a
      tainted context can leak through the search box. It leaks to the Architect's
      own search backend and its upstreams, not to the attacker; that residual is
      written down, not waved through.*

- [ ] **M9e.2 The browser** (≈ 1.5 weeks) **[gate-shaped]** — `browser_*` tools:
      navigate, read the page as an accessibility tree with element references,
      click, type, scroll, screenshot. Driven through the Chromium that Electron
      already ships: an offscreen page in a session partition of the hire's own,
      controlled from main over the debugger protocol — **no new dependency**, and
      it works with no window (FR-15.6). Navigation obeys M9e.1's address policy,
      sub-resources included; downloads, file choosers, permission prompts and
      pop-ups are refused; the page has no Node and runs sandboxed, because it is
      the most hostile content in the system. Reading is free under the `browse`
      grant. **Input is an act on the world**: typing and clicking on an origin the
      hire template does not list is a gate, and a credential is never typed by a
      model — the Architect signs in to a site in that hire's profile themselves,
      which is ADR-0035's shape: declared in advance, by name.
      *Docs: the web ADR, ADR-0035. Tests: fixture-site flows; the address policy on
      navigation and sub-resources; a cookie set by one hire invisible to another;
      a download refused; an instruction planted on a page reported and not obeyed.
      Risk: **Electron is pinned at 37** (THREAT-MODEL §6.5), and a browser that
      reads the open web on an ageing Chromium is the largest single exposure in
      this phase. The package ships only if the ADR's support window is met —
      lifting the pin is a toolchain must-ask — or runs the browser inside a
      container backend instead, which is a dependency with its memo. If neither is
      decided, it is `NOT BUILT`, with this reason.*

- [ ] **M9e.3 Sight, images, voice** (≈ 1 week) — three small tools, each a grant
      and each a named kind of money on the consent screen. **`vision`**: describe
      an image in the workspace, on a model whose `vision` capability M9c.4
      verified. **`image_generate`**: an `ImageBackend` seam over `fetch` — an
      OpenAI-compatible images endpoint or a local server's URL; the file lands in
      the workspace with a provenance sidecar; cost goes to the ledger, or *not
      reported*. **`speak`**: text to speech through the Herald's existing seam,
      with a local voice as an owned subprocess so that it works with no key, and
      spoken briefs through the same path. **Output only, by decision (DD-M9-16).**
      The Herald has had no caller since M6.9 was deferred on 2026-08-30; this
      package gives its output half one, and nothing more — push-to-talk, the wake
      word, barge-in and voice approvals stay deferred with the rest of M6.9, and
      SRS §6.2 and §6.5 stay owed exactly as they are.
      *Tests: provider fakes; a model without vision refused by name; no image
      bytes in the log; `speak` with no voice available is a visible degradation,
      never silence (FR-8.6); no input path of the Herald becomes reachable (the
      reachability walk lists exactly what gained a caller). Risk: this is how a
      deferred subsystem comes back through a side door. The boundary is output
      only, and the reachability test is what holds it.*

- [ ] **M9e.4 Inquiries** (≈ 1.5 weeks) **[gate-shaped]** — deep research, as the
      Stoa's second study kind. A study today is one registered repository at a
      pin. An **inquiry** is a question: the Architect asks it, or approves one an
      agent proposed (FR-13.1's authority, mirrored). A researcher — read-only
      workspace, **no secret grants** (NFR-17), the `web` grant, a backend with no
      credentials — plans, searches, fetches, reads and notes within a declared
      budget and time box, fanning sub-questions out through `delegate`, and files
      exactly one **report**: the question, the method (queries run, sources
      fetched), findings each citing a URL, a retrieval time and an archive hash,
      where sources disagree, what was not found, any instruction found in a source
      (as a finding), and what it cost. The harness validates before a human sees
      it: a finding with no citation, or a citation whose hash is not in the
      archive, **rejects the report** (FR-13.3's rule). Reports archive immutably
      beside the briefs. A report is evidence, never a change (FR-13.4). An inquiry
      runs on demand in `directed`; a standing cadence of them runs only in
      `improving` (FR-14.4).
      *Docs: the inquiries ADR, FR-13, ADR-0017, ADR-0018. Tests: S-INQUIRY — the
      two rejections; the planted instruction; the researcher's spawn plan carries
      no secret and is read-only (the S-STOA assertion); a budget that runs out
      ends the run visibly with the report marked partial; immutability. **Bench:
      T-RESEARCH** over a fixture web with planted facts, a contradiction, a decoy
      and an injected instruction — the verifier checks answers against the known
      ones and that every citation resolves. Risk: a citation that exists is not a
      citation that supports the claim. The check is mechanical, the report's
      header says so, and the judged half (E-RESEARCH) is owed and not faked.*

- [ ] **M9e.5 Documents** (≈ 1 week) — a writing surface in the workspace for
      Markdown, HTML and CSV. A document is a file under a root the Architect names;
      main reads and writes it atomically and the renderer is a projection
      (invariants §2, §3). **An AI edit is a proposal**: a hire answers an
      instruction with a patch against the document's current hash; it is shown as
      tracked changes; the Architect accepts or rejects each hunk; a patch against
      a stale hash is refused by name; and no agent path writes the file. Every
      accepted change appends to the document's history, and a restore is a new
      version. HTML previews in a sandboxed frame with scripts and remote loads
      forbidden, because agent-written HTML is hostile; CSV edits in a grid, and an
      export neutralises formula prefixes. Research reports, briefs and memos open
      here read-only — an archive is edited as a copy.
      *Tests: S-DOCS — accept and reject; the stale-hash refusal; history
      append-only; a planted script inert and no network from the preview; the CSV
      export; no agent write path (API surface). Risk: an editor is where a
      dependency arrives without anyone deciding it. A plain text area with a
      preview is the zero-dependency route; an editor component needs its memo
      (§10).*

- [ ] **M9e.6 Exit review.**

**Exit.** (1) T-RESEARCH on the fixture web, two models, N ≥ 3: every citation
resolves, the planted instruction is reported, the canary does not leave. (2) One
live inquiry on the open web, recorded with its condition and archived — whatever
its quality. (3) The address-refusal table and the browser's fixture flows are
green, and the browser shipped inside its support window or is recorded `NOT
BUILT`. (4) A document changes only through an accepted patch. (5) With no hire
holding `web`, a full scenario run reaches GitHub and the configured backends and
nothing else.

---

### M9f — The harbor opens: every surface, one Artemis (≈ 9 weeks)

The Harbor was named for this and has been GitHub-only. **This milestone absorbs
M7b.4** (DD-M9-10): the one Slack-compatible bridge planned there becomes the
first of several adapters behind one seam, and M7b's exit clause about a truthful
morning brief on the phone moves here with it.

- [ ] **M9f.0 The contract** (≈ 4 days) — the four ADRs of §5; FR-10.2 rewritten
      additively and UC-11 detailed; THREAT-MODEL's new section, written before the
      first adapter — M7b.4's own risk note called this "the largest new attack
      surface in the project"; the platform conformance table; S-GATEWAY,
      S-REMOTE-APPROVE, S-SCHEDULE, S-BROWSER-SURFACE; the T-SCHEDULE task.
      **Asked here:** whether memo verdicts may ever be given remotely (FR-10.2
      names gates only); whether a remote approval also asks for a PIN; and which
      platform comes first — this plan proposes Telegram only because it needs no
      library and no inbound address, which is a reason and not a decision.

- [ ] **M9f.1 The gateway, the terminal and the first platform** (≈ 1.5 weeks)
      **[gate-shaped]** — `harbor/bridge.ts`, in the SDD's module map since v1.0
      and never built. A `PlatformAdapter` connects, receives, sends and edits,
      and declares its limits. A message from the **paired** identity is the
      Architect's text to Artemis through the same `converse` handler the window
      uses (M9b.2), logged `remote` with its channel (FR-10.3); the reply is the
      conversation projection rendered for that platform. One thread with Artemis
      across every surface: one agent, one memory. **Pairing is held to the
      standard DD-M9-15 names**: a code issued at the machine, single-use, expiring
      within the hour, with an attempt limit and a lockout after repeated failures;
      sending it from the chat account binds that platform identity; unpairing is
      one act at the machine and takes effect at once. The code travels from the
      machine to the chat and not the other way, so **an unpaired sender receives
      nothing at all** — in a single-operator system (SRS §1.2) there is no
      request-access flow to answer — and the attempt is logged and rate-limited.
      In a shared chat only the paired identity's messages are read; anything it
      quotes from someone else is external data. Two adapters land here: **the
      terminal** (`ephctl chat`, a conversation over the control socket) and
      **Telegram** (long-polling over `fetch`, the bot token in the broker:
      outbound-only and zero-dependency).
      *Docs: the gateway ADR, FR-10.2/10.3, UC-11. Tests: S-GATEWAY — a fake
      platform under `test/fakes/`; an unpaired sender produces zero outbound
      messages and one log row; a paired one converses; the `remote` tag and
      channel; the token in no log and no argv; a platform that is down is a
      visible degradation with backoff; quoted content is marked external. Risk:
      whoever takes the chat account takes the conversation. They do not take
      authorisation, which is M9f.3's separate bar.*

- [ ] **M9f.2 More platforms** (≈ 1.5 weeks, one PR per adapter) — **Discord** and
      **Slack**, both over the runtime's own WebSocket and `fetch`, both
      outbound-only (no public URL); **Signal** through an owned `signal-cli`
      subprocess with a visible install offer; **WhatsApp**, whose official API
      needs an inbound public webhook — the choice between a tunnel the Architect
      provides and an unofficial bridge is asked at the package, and the honest
      outcome may be `NOT BUILT`, with the reason; **Email** as a surface arrives
      with M9g.1. A new adapter is its file plus a passing conformance run and no
      core diff (NFR-12). Every adapter **declares whether its sender is
      authenticated** by the platform, checked in both directions, because M9f.3
      depends on it.
      *Tests: the platform table per adapter — pairing, silence to the unpaired,
      send, receive, edit, attachments, rate limits, reconnect, token hygiene.
      Every payload an adapter parses is a **recorded capture** with its provenance
      (TEST-STRATEGY §5). Risk: R1 seven times over — seven APIs that drift. The
      live suite runs only for adapters the Architect has paired.*

- [ ] **M9f.3 Remote authorisation** (≈ 1 week) **[gate-shaped]** — a gate reaches
      a paired surface as a card: *what, why, blast radius, rollback*, approve or
      deny. The verdict is the Architect's, carried by an authenticated channel
      (FR-10.2, NFR-9), and is accepted only if all of these hold: it comes from
      the paired identity on an adapter that declares an authenticated sender; it
      names the gate, carries the single-use nonce from the card, and is bound to a
      digest of the action the card described — if the held action has changed,
      the verdict is void; for a
      `destructive`, `spend` or `prod-facing` gate it carries the **repeat-back**
      typed in full under FR-8.4's rules (the whole subject, the amount, an exact
      match, single-use, lapsing); and the gate is still open — the first verdict
      wins and a later one is refused by name. `gate-policy.json` gains
      `remoteApproval`: `off`, `non-destructive`, or `all-with-repeat-back`.
      **Absent means `off`**, so an existing install gains no remote approval until
      the Architect turns it on. Never remote, whatever the policy: secrets, the
      company mode, registering an MCP server or a backend host, pairing a new
      identity, raising a ceiling. And the control surface is unchanged — a script
      still approves nothing (ADR-0033). What is new is a human on an authenticated
      surface, not a wider door for any process running as the user.
      *Docs: the remote-authorisation ADR, ADR-0033, NFR-9, FR-8.4. Tests:
      S-REMOTE-APPROVE — a remote verdict takes the **same validated path a click
      takes** (the test M7b.4 already owed); a replayed nonce; a wrong repeat-back,
      and a refusal that quotes the token, neither confirms (M6's substring
      lesson); an unpaired or unauthenticated verdict refused and logged; `ephctl`
      still refused; an absent policy is `off` on an upgraded home. The adversarial
      pass is budgeted — M8.0 found three bypasses in ten minutes behind forty
      green tests. Risk: this is the clause SRS §6.1 protects. An unlocked phone in
      the wrong hands approves what the policy lets a phone approve; repeat-back
      and the policy's default are the answer, and the residual is stated.*

- [ ] **M9f.4 Schedules from language** (≈ 1.5 weeks) — from any surface: *"every
      weekday at eight, brief me on open pull requests."* Artemis proposes a
      **schedule plan** — the cadence with its time zone, the prompt verbatim, the
      hire that runs it and therefore what it may do unattended, where the output
      goes, a cap per run, an expiry — and **nothing is armed until the Architect
      confirms the plan as shown** (ADR-0012's activation screen; ADR-0032, under
      which each schedule is its own consent). What is armed is the confirmed plan,
      persisted verbatim and never re-derived (M8.8's rule). The profile trigger
      schema today knows intervals only; it gains a calendar-time kind, with
      daylight-saving and missed-run behaviour declared. Stored through
      `JsonStateStore` (absent is not damaged, ADR-0027), with the durable
      last-fired clock the scheduler already keeps. Each run is a **fresh session**
      of the named hire — none of the conversation that created it — unattended and
      headless, its output delivered and archived with refs. **A run that reaches a
      gate holds it and tells the Architect.** If nobody answers inside the run's
      time box, the gate lapses with the run and the outcome is recorded as
      *waiting for you* — never approved by default, and never counted as a
      failure. Runaway guards: a floor on the interval, a token and time cap
      per run, automatic pause after N consecutive failures with a degradation
      naming the schedule, and the breaker and the ceilings as ever. A schedule the Architect created is a directive,
      not initiative, so it runs in `directed` mode (FR-14.4).
      *Docs: the schedules ADR, ADR-0032, ADR-0027. Tests: S-SCHEDULE — what runs
      is the confirmed plan byte for byte; the clock survives a restart; the
      daylight-saving table; fresh-session isolation; the pause; a schedule cannot
      widen its hire's grants; removing a hire disarms its schedules and says so.
      Bench: T-SCHEDULE. Risk: R2 on a timer — a bad schedule burns budget every
      night. The caps, the pause, and a morning brief that lists every schedule
      that ran and what it cost.*

- [ ] **M9f.5 Push, reminders and the morning brief** (≈ 4 days) — a `PushBackend`
      seam, ntfy first: one `fetch` to the Architect's topic, the topic held as a
      secret. Pushed: a gate opened, a brief ready (UC-04 alternate 3a), a
      schedule's output, a severity-1 incident (UC-09 step 4's announcement, owed
      since M6.9 was deferred, finally has a path that is not voice), a reminder
      due. **What a push carries depends on where it goes** (NFR-10): to a public
      relay, a title and a gate id; to a server the Architect runs, the detail. A
      reminder is a schedule that only notifies. The morning brief reaches the
      phone as a push and a message — the clause moved from M7b's exit.
      *Tests: redaction by server kind (no code, no path, no secret on a public
      relay); a failed delivery is a degradation; de-duplication; quiet hours.*

- [ ] **M9f.6 The workspace in a browser** (≈ 1.5 weeks) **[gate-shaped]** — M9b's
      workspace served to a browser on another device, the phone first: the second
      half of DD-M9-15's first clause. It is a third front door onto the same
      `IpcDeps` — the window and `ephctl` are the other two — and the renderer is
      the same code with its typed bridge carried over the wire instead of over
      Electron's IPC, validated in main as ever. The listener is bound to
      **loopback only**, off until the Architect turns it on, with no setting that
      binds it wider: a phone reaches it through a tunnel, a proxy or an overlay
      network the Architect runs, which is also where its TLS comes from. **There
      is no unauthenticated mode** — a tunnel turns "loopback" into "whoever can
      reach the tunnel" — so every session begins with a code shown at the machine,
      under M9f.1's pairing rules, and is an expiring session the Watch lists and
      can end. It is a **remote surface under §4 rule 6, not a second window**: it
      converses, reads and approves within `remoteApproval`, with repeat-back; it
      never shows or sets a secret, changes the mode, registers a server or a
      host, or pairs anything. Every act is logged `remote` with its channel.
      *Docs: the browser-surface ADR, ADR-0033, THREAT-MODEL. Tests:
      S-BROWSER-SURFACE — bound to loopback and nothing else (asserted on the
      socket); no route answers without a session; the pairing rules; a session
      ended in the Watch is refused at once; each machine-only act refused by name
      over this transport, and each allowed act allowed (both directions, as
      ADR-0033's table is tested); origin and cross-site request checks; an
      approval takes the same handler path the window's takes. The adversarial
      pass is budgeted. Risk: this is the alternative ADR-0033 rejected — "a TCP
      port with auth" — returning for a different surface. What justifies it has
      to be true in code and not only in the ADR: loopback only, never without a
      session, never the machine-only acts. A streaming transport without a
      library is HTTP with server-sent events; anything else is a memo (§10).*

- [ ] **M9f.7 Exit review.**

**Exit.** (1) The Architect pairs a real chat identity and converses with Artemis
from a phone; a second, unpaired fixture identity receives silence. (2) A
non-destructive gate and a destructive one are each approved from chat — the
second only with repeat-back — through the one validated path; `ephctl` is still
refused; an upgraded home has remote approval off. (3) A schedule made in language
is confirmed, survives a restart, runs headless, delivers, and a planted failing
one pauses itself. (4) An unattended overnight run ends with a truthful brief on
the phone, every claim carrying its ref (E-BRIEF-FAITH's rule). (5) The platform
table is green for each adapter built, and each adapter not built is listed with
its reason. (6) The workspace opens in a phone's browser through a tunnel the
Architect runs, after a code shown at the machine; without a session nothing
answers, and the machine-only acts are refused there by name.

---

> **M7b comes here** (DD-M9-18). v1 is M9 through M9f. The two milestones below are
> planned now and built after v1; nothing in M7b waits on them.

### M9g — The Architect's desk: mail, calendar, todos (≈ 4–5 weeks) — *after v1*

The company starts doing the Architect's own office work. Needs M9f (schedules,
push, the outbound surfaces) and M9d (mail is the highest-volume untrusted input
the company will ever read).

- [ ] **M9g.0 The contract** (≈ 4 days) — the ADR of §5; the SRS groups; the
      THREAT-MODEL section for mail; S-MAIL, S-CAL; E-TRIAGE and the T-TRIAGE task.
      **Asked here:** whether inbound mail may ever instruct (the From line is
      forgeable), and the library memo for mail protocols.

- [ ] **M9g.1 The mail connector** (≈ 1.5 weeks) **[gate-shaped]** —
      `harbor/mail/`. Accounts over IMAP and SMTP. Gmail and Workspace accounts
      authenticate by OAuth with the Architect's own client and then speak the same
      two protocols, so there is one mail path and not two; the refresh token is
      write-only in the broker. Mail
      syncs into a cache in the home, outside the Agora and never committed; HTML
      becomes text and **remote content is never loaded**; attachments are stored
      and never opened by themselves. Every message is external data with
      provenance `mail:<account>/<message-id>`, and reading one arms the gate. A
      hire holding the grant has `mail_search`, `mail_read` and `mail_draft` —
      **and no send tool exists**. Sending is what an approved outbound gate does:
      the draft survives with its gate (ADR-0030), under FR-11.1's outbound class
      and the Front Office's autonomy ladder, `draft-only` by default.
      *Docs: the mail ADR, ADR-0030, FR-11.1, NFR-18. Tests: S-MAIL — fake servers;
      a mail carrying a planted instruction is reported, not obeyed, and the
      tainted context cannot send; the draft comes back after a restart with its
      gate (ADR-0030's test, reused); no remote image is fetched; no credential in
      a log; removing the account disables the connector and nothing else. Risk:
      mail protocols are where a hand-written parser goes to die. This is the
      package most likely to need a library, and its memo is expected (§10).*

- [ ] **M9g.2 The inbox profile** (≈ 1 week) — a mission profile for the
      Architect's own mail, built from two roles on purpose. A **triager** reads
      mail, sorts it (skip, inform, needs a reply, needs a decision) with its
      reasons, and feeds the morning brief — and can draft nothing. A **drafter**
      writes replies for what needs one, citing the thread, and can send nothing.
      The agent that reads the most hostile input holds the fewest powers.
      Playbooks under `prompts/profiles/`; triggers on a schedule and on arrival.
      *Tests: S-PROFILE extended; a triager cannot draft and a drafter cannot send
      (API surface). Eval: E-TRIAGE on a labelled fixture mailbox, with a
      deterministic scorer and the judged half owed. Bench: T-TRIAGE.*

- [ ] **M9g.3 Calendar and todos** (≈ 1 week) — a CalDAV connector over `fetch`:
      today's events enter the brief; a proposed event is an outbound act and waits
      at a gate; an event's reminder is a M9f.5 reminder. The Architect's todos are
      ledger tasks assigned to `human` (FR-4.3), written through the ledger
      endpoint — Artemis remains the single scribe — and shown in the workspace and
      on the phone.
      *Tests: a fake CalDAV server; the time-zone and recurrence table (daylight
      saving, all-day events, repeating rules — the classic bug farm); an event is
      written only by an approved gate; an invitation that carries instructions is
      data. Risk: calendar formats; the parser is minimal and ours or a library
      with a memo (§10).*

- [ ] **M9g.4 Exit review.**

**Exit.** (1) On a real mailbox: triage runs, drafts wait at their gates, and
nothing is sent un-gated. (2) Today's calendar is in the brief, and an event
reaches the calendar only through a gate. (3) A mail carrying a planted
instruction is reported and not obeyed, on two models. (4) T-TRIAGE rows recorded,
with E-TRIAGE's deterministic half in CI.

---

### M9h — The companion: Ephesus on the phone, as its own subsystem (≈ 7 weeks) — *after v1*

DD-M9-15: *no shortcuts — a proper mobile system.* M9f already puts the company on
the phone the way Hermes Agent does it: through paired chat accounts, and through
the workspace in a browser. This milestone builds what neither source has —
Ephesus's own companion, with a device identity instead of a login, a channel that
does not depend on who carries it, and a design written before any code. It comes
last because it stands on everything before it: the conversation (M9b), remote
authorisation and push (M9f), and the browser surface's listener (M9f.6).

What "proper" is held to, so that the design package cannot quietly settle for
less: **a paired device proves who it is with a key that never leaves it; the
company proves who it is to the device; what travels between them is unreadable
and unreplayable by whatever carries it; a pairing can be seen and ended at the
machine; and nothing that works on the phone works by a second implementation.**

- [ ] **M9h.0 The design** (≈ 1 week) — a contract package that is mostly design:
      the companion ADR; the protocol written down in the SDD before it is
      written in code — pairing, the handshake, message framing, replay
      protection, key rotation, revocation; the THREAT-MODEL section, naming the
      cases by hand: a lost or stolen phone, a hostile network, a tunnel or proxy
      that is itself compromised, a photographed pairing code, a replayed session,
      a downgrade, a push service that reads metadata; S-COMPANION; one governed
      `/research` cycle on how others pair and authenticate a device.
      **Asked here, in series:** the client's form — an installable web app first,
      or a native app; how the phone reaches the machine away from home — the
      tunnel the Architect already runs, a direct LAN binding, or a relay the
      Architect hosts; whether an approval on the phone also asks for the device's
      own unlock; and the push channel.
      *Docs: the companion ADR, ADR-0033, ADR-0010, NFR-9, THREAT-MODEL. Tests:
      link check, append-only check, brief validation. Risk: a security protocol
      designed by the people who will implement it, checked by nobody else. The
      design is reviewed adversarially **as a document**, before M9h.1, and the
      review's findings are in the record with what they tried — M8.0's lesson
      applied one step earlier. Prefer a published handshake pattern over an
      invented one, and say which.*

- [ ] **M9h.1 Device identity and pairing** (≈ 1.5 weeks) **[gate-shaped]** — the
      phone generates its own key pair and the private key never leaves the
      device. Pairing is started **at the machine and only there** (§4 rule 6): the
      Watch shows a code or a QR that carries **no long-lived secret** — a
      short-lived pairing secret and the fingerprint of the company's own key — so
      a photographed code is useless once used or expired, and the phone learns
      whom it is talking to from the same glance. The handshake binds the two keys
      to that secret; the harness stores the device's public key in a
      `schemaVersion`'d device list that holds no secret at all. The Watch lists
      every device with when it paired and when it was last seen, and ending a
      pairing is one act that takes effect at once. M9f.1's rules apply to the
      code: single use, short expiry, an attempt limit, a lockout.
      *Docs: the companion ADR, ADR-0010. Tests: S-COMPANION — a code works once
      and never again; an expired code; the lockout; a device that was never
      paired, and one whose pairing was ended, receive nothing; the device list
      contains no secret (the S-SECRETS scan); pairing over any remote surface is
      refused by name; a handshake against the wrong company key fails on the
      phone's side. The adversarial pass is budgeted. Risk: the one-time secret is
      the whole of the pairing's strength for the minutes it lives; the design
      must say how many guesses those minutes allow.*

- [ ] **M9h.2 The channel** (≈ 1.5 weeks) **[gate-shaped]** — every request is
      authenticated by the device's key and protected end to end between the
      device and the harness, at the application layer: the tunnel, the proxy or
      the network in between carries ciphertext, and its own TLS is a second
      layer, not the trust anchor. Each message is fresh — a replayed one is
      refused — session keys rotate, and an older protocol version is refused
      rather than negotiated down. The listener is M9f.6's, still loopback unless
      M9h.0 decided otherwise. No party the Architect did not configure is in the
      path (SRS C-2).
      *Docs: the companion ADR, SDD. Tests: a recorded session replayed is refused;
      a tampered message is refused; the wire carries no plaintext (asserted on a
      capture in a fixture); a downgrade is refused; a revoked device's live
      session dies at once; built on `node:crypto` and the platform's own
      cryptography, with test vectors for every primitive used. Risk: this is the
      package where a small mistake is silent. No primitive is implemented by
      hand, and the record names each one and where its vectors came from.*

- [ ] **M9h.3 The companion itself** (≈ 2 weeks) — an installable client of the
      same handlers the window uses (§4 rule 2): the conversation with Artemis,
      the agents and what they are doing, gates to approve with repeat-back inside
      the `remoteApproval` policy, briefs, schedules, incidents, and note capture.
      It opens offline to its shell and **never shows something old as current** —
      what it last knew is shown with its age (M8.9's rule for a held reading). It
      holds no secret of the company's, cannot see one, and cannot change the
      mode, a registry or a pairing; it keeps as little as it can on the phone,
      and what it keeps is protected by the device.
      *Docs: UI-DESIGN (the companion's layout from the same tokens), NFR-14,
      NFR-15. Tests: every action reaches the same handler the window's does; the
      machine-only acts are refused by name; a stale reading is labelled with its
      age; an approval from the companion takes the one validated path, with the
      nonce, the digest and the repeat-back of M9f.3; the token and accessibility
      rules of UI-DESIGN hold at phone size. Risk: a native app is a second
      toolchain, a second codebase and a store's rules; an installable web app
      needs a trusted certificate to install at all, which the Architect's tunnel
      must supply. M9h.0 decides, and either way it is a memo (§10).*

- [ ] **M9h.4 Push to the device** (≈ 4 days) — a gate opened, a brief ready, an
      incident, a reminder. What a push carries is decided by who can read it
      (NFR-10): either the payload is encrypted to the device, or the push says
      only *wake and fetch* and the content travels over M9h.2's channel. The push
      service learns that something happened and nothing about what.
      *Tests: no payload is readable without the device's key (asserted on the
      wire); a failed push is a degradation, and the item is still there when the
      companion next opens; de-duplication with M9f.5's channels.*

- [ ] **M9h.5 Exit review** — and the phase's closing review.

**Exit.** (1) A real phone is paired at the machine; a second device that never
paired, and the first after its pairing is ended, each receive nothing. (2) A
destructive gate is approved from the companion with repeat-back, through the one
validated path; `ephctl` is still refused. (3) On a captured session: nothing is
readable, a replay is refused, a tampered message is refused. (4) A used pairing
code and an expired one both fail. (5) A lost-phone drill is run and written down:
the pairing ended at the machine, and the phone's next request refused. (6) The
design's adversarial review and the implementation's are both in the record with
what they tried. (7) **The phase's closing review:** every bench task of §7 has its
deterministic half in CI, and README's *"How much does the harness add?"* quotes
the ledger for every switch.

---

## 7. What the bench gains

M9.1 ships T1–T3 and M9.6 ships six switches. Each milestone below adds tasks whose
verifier is outside every agent's reach, and switches the ablation can turn off.

| Task | Lands | What it asks | Verifier | Switch it measures |
|---|---|---|---|---|
| T-SKILL | M9b.5 | a fix that needs a procedure only a granted skill documents | the fixture's test goes green, and the procedure's marker step is in the log | `skills` |
| T-INJECT | M9d.3 | ordinary work over content with a planted instruction and a canary | the fixture server's own access log — a leaked canary invalidates the run | `armedGate`, `backend` |
| T-FANOUT | M9d.5 | three independent sub-investigations | a known-answers file | `delegate` |
| T-RESEARCH | M9e.4 | a question over a fixture web with planted facts, a contradiction and a decoy | known answers, and every citation resolving in the archive | `web` |
| T-SCHEDULE | M9f.4 | a job that must run unattended and deliver | the delivery fixture received it, on time, once | — |
| T-TRIAGE | M9g.2 | a labelled fixture mailbox | the labels | — |

The `council` switch (M9c.6) is measured on whichever tasks exist when it lands.
M9c.5's blind verdicts are rows of their own kind and are never averaged with
these. Everything M9-PLAN §4 says about conditions, low-confidence cells and the
total ledger applies unchanged.

## 8. Order, dependencies and estimate

```
M9 (approved) ─► M9b workspace ─► M9d walls & hands ─► M9e web & research ─► M9f harbor opens ─► M7b (v1) ─► M9g desk ─► M9h companion
        │                                                                        ▲
        └─────► M9c hearth  (needs only M9; may run beside M9b and M9d) ────────────┘
```

- **M9d before M9e, M9f and M9g** because each of those feeds agents content from
  strangers, and the armed gate and a contained backend are what stand between
  that content and a credential.
- **M9b first** because every later capability needs a surface that is not a
  floor: a research report, a comparison, a gate approved inline.
- **M9c is independent** and is the natural second cell of every later bench task
  — a local model costs nothing per run, which is what makes N ≥ 3 affordable.
- **M7b after M9f** (DD-M9-18), minus M7b.4. v1 is M9 through M9f: the workspace,
  local models, the walls, the web and the gateway. M9f is the natural boundary
  because it carries the two things v1 already requires of a remote surface — the
  chat bridge (FR-10.2) and the morning brief on the phone, M7b's own moved exit
  clause. Signed builds still ship what has been measured.
- **M9g and M9h after v1.** No v1 requirement asks for mail, a calendar or a
  companion app, and M9h stands on everything before it: the conversation, remote
  authorisation and push, and the browser surface's listener.

**The estimate, stated without rounding it down.** The package estimates above sum
to about **48 weeks**, 51 with the exit reviews, if all seven milestones run in
series after M9's five to six; about **44** with M9c beside the main line. The
per-milestone figures in the headings are those sums.

That is roughly double the "about six months" the Architect was quoted when
DD-M9-10 was first asked — a figure given before the packages were written, and
before DD-M9-15 added M9h and the browser surface. He had chosen an order with the
smaller number in front of him, so the question was put to him again on the full
figure, and he moved M7b forward (DD-M9-18).

**To v1, on that order:** M9b, M9d, M9e and M9f are about **32 weeks** on the main
line with their exit reviews, M9c running beside them; about 39 if M9c is taken in
series. Then M7b. After v1, M9g and M9h are about **12 weeks**.

Two things cut the other way, and neither is a promise. M9-PLAN §8 records this
repository's wiring packages landing several times faster than their nominal
estimates (M8's thirteen in eight calendar days), and most of what is here is
adapters and connectors behind seams, which can be built side by side. What will
actually bound the phase is not typing: it is the Architect's own time — some
twenty questions asked in series, a memo for every dependency, live bench rows at
N ≥ 3, real accounts to pair, a real mailbox, a real phone.

The Architect may still take M7b at an earlier boundary, or stop after v1 — each
milestone is useful by itself and exits on its own bar.

## 9. What happens to the rest of the plan

- **M7b** follows M9f (DD-M9-18) and keeps M7b.1, M7b.2, M7b.3, M7b.5 and M7b.6.
  **M7b.4 (chat bridge) is absorbed by M9f.1–M9f.3**, and the exit clause *"a real
  overnight run produces a truthful morning brief on the phone"* moves to M9f's
  exit. M7b stays the v1 acceptance boundary; what v1 ships is the agentic harness
  through the gateway. **M9g and M9h are planned post-v1 milestones**, and with
  M7b.2 landed before them, the company's own Recursive Improvement profile can
  take part in building them — the first packages the company helps build for
  itself.
- **The post-v1 horizon** in IMPLEMENTATION changes: *Telegram + more bridges*
  moves into M9f; *local voice adapters* into M9e.3, for output (DD-M9-16);
  *SDK-based headless workers* stays a future provider behind the seam
  (ADR-0036); *multi-machine crews* stays post-v1 — DD-M9-14 chose loop-local.
- **M6.9** (wire the Herald into the application) stays deferred. DD-M9-16 gives
  the Herald's **output** a caller in M9e.3 and nothing else: push-to-talk, the
  wake word, barge-in and voice approvals are still M6.9's, and SRS §6.2 and §6.5
  are still owed.
- **The owed exit runs** (M7, M8b, M8c) are untouched: bench T1's first live row,
  as DD-M9-7 decided.
- **The floor, the Herald and the Odeon** are not cut. ADR-0040 makes the floor a
  mode; DD-M9-4's *nothing deleted* stands.

## 10. Dependencies and outside programs this phase expects to ask for

DD-M9-9: M9 stays zero-dependency; after it, `fetch`, `node:` builtins or an owned
subprocess first, and a decision memo for anything else. This table exists so that
no memo is a surprise. Nothing here is approved by being listed.

| Package | The need | The zero-dependency route | What would need a memo |
|---|---|---|---|
| M9b.2 | render model-written markdown safely | a small renderer of our own | a markdown library and a sanitiser |
| M9c.3–.4 | model weights; a model server | ranged `fetch`; the server as an owned subprocess the Architect installs | the dependency **class** itself (the M9c.0 ADR) |
| M9d.1–.2 | containers; remote shells; cloud sandboxes | the `docker`, `apptainer` and `ssh` CLIs as owned subprocesses | Modal's client (an outside program) |
| M9d.4 | the MCP protocol | a hand-written client over `node:` builtins and `fetch` | the protocol's SDK |
| M9e.1 | a search service; text extraction | an `attached` SearXNG; extraction in the offscreen page | an **owned** SearXNG (a container image) |
| M9e.2 | a browser | Electron's own Chromium over the debugger protocol | lifting the Electron pin (a toolchain change), or a browser in a container |
| M9e.3 | local speech | — | a local voice engine as an outside program |
| M9e.5 | an editor | a text area with a preview | an editor component |
| M9f.2 | Signal; WhatsApp | — | `signal-cli` (an outside program); a WhatsApp bridge |
| M9f.6 | a streaming transport to a browser | `node:http` with server-sent events | a WebSocket server library |
| M9g.1 | IMAP, SMTP, MIME | hand-written over `node:tls` (not recommended) | mail protocol libraries |
| M9g.3 | CalDAV, iCalendar | `fetch` and a minimal parser | an XML or calendar library |
| M9h.1–.2 | keys, a handshake, a pairing code to scan | `node:crypto` and the platform's own cryptography; a small code renderer of our own | a cryptographic protocol library; a QR library |
| M9h.3 | the companion's form | an installable web app from the same renderer | a native app toolchain |
| M9h.4 | push to a device | the web push protocol over `node:crypto` and `fetch`, or M9f.5's ntfy | a push library |

## 11. Decisions

### Answered on 2026-10-03, through the questions workflow

Numbering continues M9-PLAN §10's. Recorded in `docs/DECISIONS-LOG.md`.

| ID | Decision | Options | The Architect's answer |
|---|---|---|---|
| DD-M9-8 | How the sixteen features enter the plan | (a) follow-on milestones, M9 untouched; (b) more packages inside M9; (c) rewrite M9 feature-first | **(a)** — M9b onward, each with its own exit and bench tasks |
| DD-M9-9 | The dependency rule | (a) zero-dependency core, a memo per package after; (b) zero for the whole phase; (c) approve a named set now | **(a)** |
| DD-M9-10 | Order against M7b | (a) features, then M7b; (b) M7b, then features; (c) recursion first | **(a)** — M7b.4 absorbed by the gateway, signed builds last. *Amended the same day by DD-M9-18, once the estimate was known.* |
| DD-M9-11 | What the window opens on | (a) workspace by default, floor a mode; (b) floor stays default; (c) ask on first run | **(a)** — ADR-0040. Asked separately, because the first answer did not cover it: an install that predates the setting **switches too, with a notice** (ADR-0040 clause 4), rather than keeping the floor |
| DD-M9-12 | Who reaches the open web | (a) a per-hire grant, and fetched content arms the gate; (b) researcher roles only; (c) every native agent | **(a)** |
| DD-M9-13 | How MCP servers are admitted | (a) granted by name per hire; (b) one company-wide registry; (c) built-in connectors only | **(b)** — against the recommendation; the consequence is recorded in M9d.4 and owed to THREAT-MODEL |
| DD-M9-14 | Execution backends against SRS §1.2 | (a) loop local, tools remote; (b) local containers only; (c) whole agents remote | **(a)** — SRS §1.2 amended |
| DD-M9-15 | How a phone reaches the harness | First asked as: (a) a paired LAN listener, off by default; (b) a private overlay only; (c) no listener. Answered in the Architect's own words — *"no shortcuts we will design a proper mobile system just like Hermes did for Ephesus"* — and asked again once Hermes Agent had been read: (a) Hermes Agent's way, in full; (b) that, plus Ephesus's own companion; (c) a first-class subsystem with its design left open | **(b)** — the gateway to that standard and the workspace in a browser (M9f), then a milestone of its own, M9h, designed before it is built |
| DD-M9-16 | Speech, against M6.9's deferral | (a) output only, in M9e.3; (b) keep voice deferred; (c) lift M6.9 in full | **(a)** — a `speak` tool and spoken briefs; every input path of the Herald stays deferred |
| DD-M9-17 | The watchlist rows' tags (an Architect-only act, FR-13.1) | (a) amend both rows now; (b) amend at each milestone; (c) leave them | **(a)** — applied to `docs/stoa/WATCHLIST.md`; Hermes Agent's license recorded as MIT as read, still his to verify |
| DD-M9-18 | DD-M9-10 again, on the full estimate (44–51 nominal weeks, not six months) | (a) M7b after M9f; (b) keep all seven before M7b; (c) M7b right after M9 | **(a)** — v1 is M9 through M9f; M9g and M9h follow v1 |

### Asked in series, each at its package — not before

Through AskUserQuestion, never in prose, and never decided on silence:

- **M9b.0** — the engine Artemis runs on by default once `native` passes ADR-0024's bar.
- **M9c.0** — a city name for the model service, or none; whether a script may
  start a model download.
- **M9d.0** — whether NFR-17 is amended for the MCP registry; the company-wide
  backend floor; what arms the gate, and that repository content does not.
- **M9e.0** — the browser against the Electron pin; `owned` or `attached` search.
- **M9f.0** — remote memo verdicts; a PIN on remote approval; which platform is
  first (the plan proposes Telegram) and the order after it.
- **M9g.0** — whether inbound mail may instruct; the mail libraries.
- **M9h.0** — the companion's form (an installable web app first, or native); how
  the phone reaches the machine away from home; the device's own unlock on an
  approval; the push channel.
- **Every package that needs one** — its dependency memo (§10).
- **Before any package at all** — whether the build may start.

## 12. Risks added to the register

| # | Risk | L | I | Mitigation / trigger |
|---|---|---|---|---|
| R22 | Five milestones stand between M9 and v1, and two more follow it — R8 at ten times the scale | H | H | each milestone is useful alone and exits on its own bar; the Architect already moved M7b forward once (DD-M9-18) and may take it at any earlier boundary; a bench row that shows no uplift is a reason to stop, and the plan says so |
| R23 | Injection at open-web and mail scale (R12, widened from one watched repository to everything) | H | H | the armed gate (M9d.3) before the first stranger's content; contained backends; researcher and triager roles that hold no powers; T-INJECT in CI; THREAT-MODEL §6.1 still says *mitigated, not solved* |
| R24 | Approval fatigue: armed gates and a phone that can approve turn the Architect's verdict into a reflex (R15's shape) | M | H | the bench counts gates opened per task as a cost; taint-tolerant grants are explicit; repeat-back for what cannot be undone; `remoteApproval` absent means off |
| R25 | Dependency creep under sixteen features' pressure | H | M | DD-M9-9; §10's table; `NOT BUILT`, with the reason, is an accepted outcome of a package |
| R26 | Seven platform APIs, each drifting (R1 for the gateway) | H | M | adapters behind one table; recorded captures; the live suite only for paired adapters |
| R27 | Supply chain: model weights, container images, MCP servers, skills | M | H | hashes and digests pinned; installed only by the Architect's act; manifest drift refuses; the registry is one review point |
| R28 | An ageing Chromium reads the open web (the Electron pin) | M | H | the browser ships only inside the support window its ADR names, or in a container, or not at all |
| R29 | Remote authorisation weakens the clause SRS §6.1 protects | M | H | paired identity on an authenticated adapter, nonce, repeat-back, first verdict wins, default off, the same validated path, an adversarial pass |
| R30 | The product dissolves into a generic assistant — C1 from the other side | M | H | §4: every capability enters through a city subsystem and carries its gate, its record and its bench row; what Ephesus offers is governance and measurement, not the feature list |
| R31 | A local model cannot carry the feature (R19, widened) | M | M | every row names its model and verified capabilities; `claude` native as the second cell tells a model limit from a harness limit |
| R32 | The company-wide MCP registry puts one compromised server in reach of every hire (DD-M9-13) | M | H | the harness is the only client and the server holds its own credentials; the manifest snapshot and drift refusal; side-effect tools pass gate policy; results arm the gate; NFR-17's researcher rule stands unless amended |
| R33 | Cost multipliers stack — council, fan-out, schedules, research | M | M | an estimate before each; the ceilings; the morning brief reports spend per schedule and per feature |
| R34 | The phone and the browser are new ways into the machine (DD-M9-15): a listener ADR-0033 declined, and a security protocol of the project's own | M | H | loopback only and never without a session (M9f.6); pairing only at the machine; a device key that never leaves the phone; a channel that is unreadable and unreplayable by its carrier; machine-only acts refused by name on every remote surface; the design reviewed adversarially as a document before any code (M9h.0); no primitive implemented by hand |
| R35 | The estimate: about 44–51 weeks of packages at their nominal sizes, against the "about six months" quoted when the order was first decided | H | M | the order was asked again on the full figure and M7b moved to after M9f (DD-M9-18), about 32 weeks on the main line; every milestone exits on its own bar; the pace is re-read from the record at each exit review instead of assumed |

## 13. The edits this plan became

Applied on 2026-10-03 as documentation, on the Architect's verdict (*"Approve for
planning"*), and committed and pushed as one docs change on his instruction:

1. `docs/PHASE-9-PLAN.md` — this file.
2. `docs/adr/ADR-0040-the-floor-is-a-view-mode.md`, and its index row.
3. `docs/srs/SRS.md` §1.2 — the scope note and the two amended SHALL NOT lines.
4. `docs/IMPLEMENTATION.md` — digests for M9b–M9h between M9 and M7b; M7b's note;
   the post-v1 horizon; R22–R35; the dependency diagram.
5. `docs/PROGRESS.md` — a section per milestone, every box unticked; M7b.4 marked
   as moved.
6. `docs/DECISIONS-LOG.md` — the direction, and one entry per answer.
7. `docs/stoa/WATCHLIST.md` — the two rows' tags amended (DD-M9-17).
8. `docs/M9-PLAN.md` and `docs/M9-GOAL.md` — a pointer here; nothing decided there
   is rewritten.
9. `README.md` — the documentation map and the note under *Where the build stands*.
10. `docs/implementations/2026-10-03-phase-9-plan.md` — the record of this change.

Not edited at plan time, on purpose: the SDD, TEST-STRATEGY, THREAT-MODEL and
UI-DESIGN. Each milestone's contract package writes its own sections against a
governed brief; writing seven milestones of design now would be the SDD describing
code nobody has designed.

**Rollback** (ADR-0015 asks for one). The plan adds documents and unticked boxes;
reverting the change removes them. ADR-0040, once accepted, is superseded rather
than deleted. Inside the phase every capability is a grant: a hire template that
does not declare it does not have it, and un-registering an adapter, a backend or
a server turns that surface off without touching the rest.
