# Ephesus — Software Design Description (SDD)

**Version:** 1.0 · **Status:** Approved for implementation
**Satisfies:** [SRS](../srs/SRS.md) FR-1…FR-12, NFR-1…NFR-16 · **Justified by:** [ADR-0001…0015](../adr/README.md)

This document describes *how* Ephesus is built: process architecture, module map, data
models, on-disk formats, IPC contracts, state machines, and the key runtime sequences.
Where a design choice needs justification, it cites the ADR rather than re-arguing it.

---

## 1. Process architecture

Three OS-level tiers (ADR-0001, ADR-0002):

```
┌────────────────────────────────────────────────────────────────────────┐
│ Electron MAIN (Node, privileged)                                        │
│  pty.ts hermes.ts agora.ts artemis.ts library.ts odeon.ts herald/      │
│  harbor/ watch/ engines/ hooks.ts scheduler.ts db.ts config.ts ipc.ts  │
├────────────────────────────────────────────────────────────────────────┤
│ PRELOAD (contextBridge) → typed window.eph API — the ONLY renderer door │
├────────────────────────────────────────────────────────────────────────┤
│ RENDERER (React, sandboxed, no Node)                                    │
│  Terraces floor (Pixi) · Terminal views (xterm) · Command Center ·      │
│  Odeon panels · Org panel · Approvals · Memory panel · Settings         │
└────────────────────────────────────────────────────────────────────────┘
          ▲ per-id IPC: pty bytes, events, state snapshots
          │
   ┌──────┴───────────────┐     ┌───────────────────────────────┐
   │ Agent processes      │     │ Hook shims (eph-hook et al.)  │
   │ (claude/codex/… in   │────►│ POST lifecycle JSON to        │
   │  node-pty PTYs)      │     │ ~/.ephesus/events.sock        │
   └──────────────────────┘     └───────────────────────────────┘
```

**Trust boundaries.** The renderer is untrusted (renders agent/internet-derived
content): no Node, no fs, no secrets (NFR-8; ADR-0010). Agent processes are
semi-trusted (prompt-injectable): least-privilege env, gated actions, redaction filter.
The hook socket is `0600` with a per-spawn token in each payload.

### 1.1 Main-process module map

| Module | Owns | Key ADR |
|---|---|---|
| `engines/` | `EngineAdapter` registry: `claude.ts` (reference), `codex.ts`, `gemini.ts`, `grok.ts`, `opencode.ts`, `custom.ts`. `claude.ts` alone implements `trustWorkspace` (ADR-0021/0025) — the engine's own per-workspace trust record is a Claude Code fact, and core never learns what a project key looks like | 0009, 0021, 0025 |
| `agents.ts` | `AgentManager`: spawn ordering (probe → token → identity → settings → process), FR-1.6 install offer, exit unwind (settings restored, token revoked) | 0009, 0010 |
| `pty.ts` | `PtyManager`: spawn/write/resize/interrupt/kill/resume; PATH resolution for spawn plans (`which.ts`); the redaction filter on outbound streams, wired in `pty-stream.ts` (split out so it is testable without node-pty) | 0014, 0010 |
| `avatars.ts` | `AvatarDirector`: hook events → §6 avatar snapshots, the walk clock (`arrive`) and the §6 timers | 0002 |
| `commands.ts` | `CommandQueue`: FR-1.3 queue-until-idle, held text, two-write submit | — |
| `prompts.ts` | `PromptStore`: harness-home-first prompt/template loading, seeded from the bundled copies | — |
| `hooks.ts` | UDS/named-pipe server; payload validation; schema-drift warnings; PTY-heuristic fallback registration | 0002 |
| `hermes.ts` | Outbox watchers, delivery (temp+rename), hop-cap diversion, bounce, broadcast fan-out, wake watchdog, Stop-hook decisioning | 0003, 0013 |
| `git.ts` | The **only** module that invokes `git` in the app, worktree isolation (UC-01 2a) and `readRemotes` (M8.5, a read of the target checkout — commits nothing) included. ADR-0004's single-committer claim lives here, and CI fails on a `git` call anywhere else — except the named development-repo tools in `check-invariants.cjs`'s allowlist, which run outside the app process and never touch a harness home | 0004 |
| `eventlog.ts` | `log.jsonl` appender/reader: seq recovery, append-only writes, tolerance of a torn tail from a killed harness, and the readers a consumer needs beyond a cursor window — `tailOf` (the newest, for a live view) and the unbounded read behind `Agora.readLogAll`/`readLogSince` (for the standup, the org metrics and the proof gate, which must see everything) | 0004 |
| `settings-registry.ts` | Durable record of settings files written into an agent's repo, so a force-killed harness can undo them on the next boot | 0009 |
| `agora.ts` | On-disk layout, registry/ledger/board accessors, `log.jsonl` appender AND its publish/subscribe (`onAppend` — the single writer publishes, so no appender has to remember to notify anybody), the whole-log readers with their cost reported, the single git committer (queue, retry+backoff, startup reconcile) | 0004 |
| `ledger.ts` | The task-ledger endpoint (§7.1): validates Artemis's `propose` acts and writes `tasks.json` and `board.md` through the single committer — agents never touch either file | 0005, 0004 |
| `artemis.ts` | Orchestrator lifecycle: auto-spawn, reserved seat, respawn-with-memory, prompt/config assembly, delegated-authority table. The backoff ladder itself moved to `respawn.ts` at M8.6; what stays here is the orchestrator's own policy — that a company with no orchestrator is a degradation the Architect must be told about, and that her roster seat is cleared when she will not be coming back | 0005 |
| `respawn.ts` | `RespawnLadder` (one agent's attempts, backoff, stability window, capacity hold and the standing-decision veto), `CrewSurvival` (one ladder per hire that declared `onExit: "respawn"`) and `createCrewSurvival` (the log kind, the degradation causes and the "still down" reading, kept out of `index.ts` so they are testable). Added M8.6: FR-5.4's ladder had exactly one user while three crew agents logged terminal exits four, five and five times in a day and nothing brought any of them back | 0011 |
| `library.ts` | Memory read/write helpers, the corpus, the recall ladder and its visible state, MemPalace driver (`eph-recall`, archive ingestion), reflection scheduler, knowledge shelf. `library-fts.ts` holds the FTS rung's behaviour (mtime gate, scoring, scope) and `library-fts-sqlite.ts` its SQLite FTS5 storage, split so the native module stays out of the test runner; `library-mempalace.ts` drives the MemPalace CLI under ADR-0009's subprocess discipline (version probe, visible install offer, no daemon flags, engine-side auto-save hooks forced off) | 0006, 0016 |
| `odeon.ts` | Briefing compiler, deck-gate on task close, memo policy engine + queues + verdict routing, meeting driver (turn-taking, minutes) | 0008 |
| `herald/` | `seam.ts` (STT/TTS/Duplex interfaces), `policy.ts` (wake word, barge-in, repeat-back, failover), `elevenlabs.ts`, `openai-realtime.ts` | 0007 |
| `harbor/` | `github.ts` (issues/PRs/CI via `gh`), `bridge.ts` (chat bridge), `webhooks.ts`, `hires.ts` (export/import) | — |
| `watch/` | `gates.ts` (approval queue + policy), `budgets.ts` + `ledger.ts` (durable cost), `breaker.ts` (ladder), `telemetry.ts` (OTel spans, waterfall), `secrets.ts` + `cipher.ts` (write-only broker, OS-keychain seam) | 0011, 0010 |
| `profiles.ts` | Profile load/validate/activate/instantiate; schema versioning. Since M8.5 the activation preview is asynchronous, because it READS the target checkout's remotes rather than remembering them, and an instance that comes up watching no repository reports it (`onWatchesNothing`). The pure half — parsing a remote URL, and refusing to choose between a fork's two — is `shared/repo-remote.ts` | 0012 |
| `org.ts` | Departments, hire-template versioning, per-agent metrics, review/retro reports | — |
| `gymnasium.ts` | Improvement-proposal validation (metric + rollback required), ledger accessors, gate classification, metric-check scheduling, rollback driver | 0015 |
| `stoa.ts` | Watchlist accessors (Architect-only mutation, enforced in the handler like `gym.verdict`), researcher spawn plans (read-only checkout, no secret grants), brief validation (uncited finding ⇒ rejected pre-human), brief archive. The cadence tick itself is `stoa-cadence.ts` (a scheduler client, mode-gated — shipped body, exercised by the suites) | 0017, 0018 |
| `modes.ts` | `CompanyModes` (ADR-0018): mode persistence through `config.json`'s atomic path, the §6.9 proof-gate check over the gym ledger + log (constants in `shared/mode.ts`), ledgered mode changes, the breaker's rung-3 revert (roles per `isImprovementRole`) | 0018 |
| `scheduler.ts` | Cron-like triggers (standups, reflection, reviews, profile triggers) with idempotent ticks — a trigger fires at most once per interval and is never re-entered while running. `reflection.ts` is its first client: it asks an agent to condense its own memory (ADR-0006 layer 3) and applies what the agent proposes back to the reserved `agent.library` endpoint — the harness never summarizes (ADR-0005) | 0006, 0005 |
| `db.ts` | SQLite: app-local state (window bounds, command history) + cost ledger | 0004, 0011 |
| `config.ts` | Harness home setup, config persistence (text assets are loaded by `prompts.ts`) | — |
| `home.ts` | The harness home's shape: `HOME_DIRS`, creation, `config.json` load with a visible warning on a corrupt file, and the first-boot seeding of the files the harness requires — `gate-policy.json` and `authority.json`, written from schema-validated values, only when absent, and reported so the Architect learns they exist (M8.4) | — |
| `fsx.ts` | `writeFileAtomic` — temp file + rename, the one write path for anything another process reads (invariant §3) | 0003 |
| `degradations.ts` | The degradation channel (M8.2): one entry per CAUSE rather than per occurrence, the bounded ladder that decides what reaches `log.jsonl`, the clear, and the boot replay that marks a surviving condition as carried over. The model and the line the Architect reads are `shared/degradation.ts` | 0004 |
| `index.ts` | Boot and wiring: constructs every module above, connects the two planes, registers IPC, and hands the quit to `shutdown.ts`. Holds no logic of its own | 0001 |
| `shutdown.ts` | The quit sequence (M8.1): closing time, then the agent unwind, then the stops, each phase isolated so one failure never skips the next; idempotent, Electron-free, and driven by the scenario suite as well as by `index.ts` | 0001 |
| `ui-bridge.ts` | The one door from main to the renderer (M8.1): owns the window, forgets it when it closes, refuses to send to a destroyed one, and is the `PtySink` the terminal stream writes to. A `webContents.send` anywhere else fails `check-invariants` | 0001, 0014 |
| `ipc.ts` | Registers every handler behind the typed preload surface | 0001 |

---

## 2. On-disk layout (the harness home)

```
~/.ephesus/
  config.json                # app config (no secrets)
  secrets.enc                # broker store (0600): ciphertext only, never plaintext,
                             #  never in the Agora or SQLite (ADR-0010, NFR-8)
  gate-policy.json           # the Watch's gate policy (SDD §9). Absent or unreadable
                             #  ⇒ deny-all: it can only ever loosen, never tighten
  authority.json             # Artemis's delegated-authority table (FR-5.5). Absent or
                             #  unreadable ⇒ no delegated authority: everything escalates
  known-targets.json         # targets a profile has been activated against before, so the
                             #  panel offers one instead of asking for a long path again.
                             #  Absent or unreadable ⇒ offers nothing (the opposite failure
                             #  mode to gate-policy: a convenience that cannot be read must
                             #  not stop an activation). NOT a restore list — choosing one
                             #  fills the form and still goes through preview and activate
  events.sock                # hook socket (0600) — also answers `POST /recall`
                             #  for the agent-facing `eph-recall` CLI (ADR-0006
                             #  layer 2): one socket, one per-spawn token registry
  db.sqlite                  # app-local + cost ledger
  prompts/                   # versioned text assets: artemis system prompt, block-reason
                             # template, reflection prompts, herald persona & phrase book
  profiles/<name>/           # mission profile bundles (ADR-0012 layout)
  agora/                     # ← git repo, single committer (ADR-0004)
    PROTOCOL.md              # agent-facing contract: how to remember, message, file memos
    registry.json            # roster (see §4.1)
    board.md                 # blackboard — Artemis is sole scribe
    tasks.json               # ledger (see §4.2)
    log.jsonl                # append-only event feed (see §4.3)
    knowledge/               # the shelf: architect-registered reference docs
    odeon/
      briefs/<ts>.md         # briefing artifacts (+ source refs)
      decks/<taskId>-<ts>.html
      memos/<memoId>/memo.md + verdict.json
      minutes/<meetingId>.md
      retros/<ts>.md         # weekly retro reports (UC-12, write-once — M5.6;
                             #  events ride the `orchestrator` log kind)
    gymnasium/
      LEDGER.md              # permanent self-improvement ledger (seeded from the
                             #  repo's docs/gymnasium/ at first run — FR-12.6).
                             #  Carries the proposals table AND, below it, the
                             #  `## Mode changes` section (ADR-0018, FR-14.5).
                             #  Everything under the table survives a rewrite
      proposals/GYM-*.md     #  repo's docs/gymnasium/ at first run — FR-12.6)
    stoa/
      watchlist.json         # architect-curated external sources (§4.7); mutated
                             #  only via architect-verified IPC (FR-13.1)
      briefs/RB-*.md         # provenance-cited research briefs, immutable once
                             #  archived (seeded from docs/stoa/ — FR-13.7)
    agents/<agentId>/
      identity.md            # role, capabilities, env grants (mirrors hire template)
      memory.md              # long-term memory (Library layer 1). Append-only,
                             #  except for reflection's condensation (layer 3),
                             #  which is allowed to rewrite it only because the
                             #  sections it removes are copied verbatim to
                             #  memory-archive/ FIRST and the union is checked
      memory-archive/        # reflection condensation output, `<date>-<seq>.md`
      inbox/  inbox/.done/   # Hermes delivery targets
      outbox/                # agent-written, router-drained
      cursor.json            # { lastProcessed }
  worktrees/<agentId>/       # isolated checkouts of an agent's TARGET repo
                             #  (UC-01 alternate 2a). Never of the Agora, which
                             #  ADR-0004 gives exactly one working copy. A clean
                             #  one is removed when the agent exits; a dirty one
                             #  is kept and reported — `--force` is never used
  index/                     # MemPalace store root (Library layer 2 + company archive,
                             #  ADR-0016) and `fts.sqlite`, the SQLite FTS5 keyword
                             #  rung below it. All derived state — disposable and
                             #  rebuildable from markdown, which is why it is NOT in
                             #  db.sqlite: SDD §10 repairs a corrupt index by deleting
                             #  it, and db.sqlite holds the append-only cost ledger
```

Rules: agents write only inside their own `agents/<id>/` and their assigned worktrees;
`board.md` only via Artemis; `log.jsonl` and `odeon/` only via the harness; the `index/`
directory is derived state and excluded from the Agora repo.

---

## 3. Engine adapter surface

Defined normatively in ADR-0009. Runtime notes:

- `SpawnPlan` composes: argv, cwd (target repo or worktree — a spawn requesting
  `worktree: true` has its cwd replaced by an isolated checkout before anything
  is written, so grants, settings install and transcripts all follow it), env = base ∪ role-declared
  secret grants (ADR-0010) ∪ `EPH_AGENT_ID`/`EPH_HOOK_TOKEN`, and settings injection
  (e.g. writing hook shims into `<cwd>/.claude/settings.local.json`, backed up, with
  uninstall).
- **Who asks for `worktree: true` (M8.6, `src/shared/isolation.ts`).** A bare
  `agents.spawn` (UC-01, where the Architect typed the working directory and
  confirmed one agent) keeps the schema's optional-false default. A PROFILE
  activation — several hires from one confirmation — composes it, in the shape
  `composeAutonomyTable` already uses for autonomy: hire template → profile
  document → built-in default, then the Architect's per-activation choice
  (`as-declared` / `isolate-all` / `none`), then a clamp for a target that has
  no repository to make a worktree of. **The built-in default is `worktree`**:
  a bundle that declares nothing gets isolation rather than the Architect's
  checkout, which is what both shipped bundles did for their entire production
  life. `PlannedHire.spawn.worktree` is DERIVED from `PlannedHire.isolation.effective`
  in one expression, so the sentence the activation screen renders and the flag
  the spawn carries are the same decision; a test asserts that equality for
  every planned hire under every choice. Whether the worktree can actually be
  made is deliberately not pre-checked — the create is the truth, and a screen
  that says "ok" before a `git worktree add` that fails is two code paths that
  can disagree (the M8.5 lesson).
- **Isolation moves the agent, so the engine's workspace trust must follow it**
  (ADR-0025, M8.7). Claude Code asks once per working directory whether a human
  trusts it, keyed on the exact resolved path, and it asks BEFORE a session
  exists — so no hook fires and a parked agent reports nothing. ADR-0021 answers
  that at activation with the target; once M8.6 made isolation the default, the
  target was no longer where any hire worked. `ProfileActivations` therefore
  calls `beforeHires(plan)` after the plan is fixed and before the first
  process, and `index.ts` trusts every directory in
  `plannedWorkspaces(plan, worktreePathFor)`: the target (`must-exist`, resolved
  through `realpath` in full) and one entry per isolated hire
  (`will-be-created`, whose leaf git has not made yet, so the PARENT is resolved
  and the leaf appended — the parent is `<home>/worktrees`, which the harness
  owns). Both the trusted set and the spawned set come from the one plan object;
  a second derivation would put the record at a path nothing reads, and the only
  symptom of that is an agent that hangs. Trust is still written from an
  activation and nowhere else — never from spawn, respawn or a wake (ADR-0021,
  unchanged).
- **A hire also declares what happens when it dies** (`onExit: "offer" | "respawn"`,
  same two layers, default `offer` = SDD §10's own word). Both fields are
  additive and optional on `hireTemplateSchema` and `profileDocumentSchema`, so
  every document written against the previous shape still validates — the same
  reasoning `budget` carried at M7.1 — and neither costs a `schemaVersion` bump.
  The two shipped bundles declare theirs explicitly and took a version bump for
  it, because ADR-0012 makes the profile version a record of what an Architect
  approved.
- **Identity injection:** at spawn the adapter arranges for `identity.md` +
  `PROTOCOL.md` + the agent's **memory layer** to reach the agent (engine-native
  context file, `--append-system-prompt`, or first-prompt injection — adapter's
  choice, conformance-tested for effect not mechanism). The memory layer arrives
  on `AgentSpawnConfig.memory` as text the Library has already composed and
  budgeted (ADR-0006 layer 1): an adapter never decides how much of a long
  `memory.md` a spawn can carry.
- **Hook fidelity grades** (`native` | `wrapper` | `pty-heuristic`) surface on the agent
  card and scale down floor detail and breaker sensitivity (ADR-0011, 0014).
- `TranscriptReader` yields token/cost facts folded into the ledger (FR-11.2).

---

## 4. Data models

### 4.1 Registry (`registry.json`)
```jsonc
{
  "schemaVersion": 1,
  "orchestratorId": "agent.artemis",
  "agents": {
    "agent.artemis": {
      "name": "Artemis", "role": "orchestrator", "engine": "claude",
      "isOrchestrator": true, "seat": "temple",
      "capabilities": ["routing","adjudication","scribe","briefing","chair"],
      "profile": null, "target": null,
      "status": "idle",             // mirror of avatar state, coarse
      "hookFidelity": "native",
      "envGrants": [], "budget": { "dailyTokens": 2000000 },
      "spawnedAt": "ISO-8601", "lastSeen": "ISO-8601"
    },
    "agent.mason": {
      "name": "Mason", "role": "ci-babysitter", "engine": "claude",
      "profile": "skeleton-crew", "target": "repo:myapp",
      "capabilities": ["ci","test-triage","git"], "seat": "terrace-3",
      "envGrants": ["GH_TOKEN"], "budget": { "dailyTokens": 500000 },
      "hire": { "template": "ci-babysitter", "version": 3 }
    }
  }
}
```

### 4.2 Task ledger (`tasks.json`)
```jsonc
{
  "schemaVersion": 1,
  "tasks": [{
    "id": "t-2026-08-26-041",
    "title": "Fix flaky checkout test",
    "spec": "…self-contained; written by Artemis…",
    "assignee": "agent.mason",
    "status": "in_progress",       // todo|in_progress|blocked|review|done|stalled
    "priority": 2,
    "deps": ["t-…-040"],
    "review": ["deck"],            // Odeon gates: deck and/or memo refs required
    "gates": [],                   // open Watch gate ids blocking this task
    "artifacts": { "deck": null, "memos": ["m-102"], "resultRef": null },
    "source": { "kind": "directive", "via": "voice", "log": "log#8842" },
    "createdAt": "…", "updatedAt": "…"
  }]
}
```
The harness rejects `status→done` while `review` obligations lack artifacts (ADR-0008)
or `gates` is non-empty.

### 4.3 Event log (`log.jsonl`) — one JSON object per line
```jsonc
{ "ts": 1724668800123, "seq": 8843, "kind": "message",
  "from": "agent.mason", "to": "agent.artemis", "act": "inform",
  "subject": "checkout test green", "msgId": "…", "conversation": "conv-7f3" }
```
`kind ∈ { message, delivery, bounce, spawn, exit, ghost, hook, task, gate, memo,
brief, deck, meeting, breaker, budget, memory, orchestrator, remote, secret-rotated, profile,
gym, stoa, shutdown, capacity, respawn, error, degradation }`. `capacity` carries the provider's usage
limit (`src/shared/capacity.ts`): parked (with the engine's own refusal text and
the retry it is waiting for), resuming (and by which of the two continuations),
cleared. It is distinct from `breaker` and from `exit` on purpose — one is our
ladder, one is a dead process, and this is a healthy agent the provider declined
to serve. `degradation` carries a CONDITION the company is running under rather than an
event that happened (M8.2): `source`, a stable `cause` (`<source>/<slug>`), the
latest `detail`, the `count` the row accounts for and `since`; the row with
`event: 'cleared'` says it ended and `forMs` how long it lasted. It is distinct
from `error` on purpose — "delivery threw" happened once, "recall is on the grep
rung" is still true, and only the second can be cleared or replayed. A repeating
cause reaches the file on a bounded ladder (the first occurrence, then each power
of ten, then the clear), so a check that reports every second costs five lines
rather than thousands; the exact count stays live in the UI, which reads the ring
rather than the file. At boot the log tail is replayed, so a condition that
outlived the last quit is shown as carried over rather than as a clean slate
(invariant §7; the model is `src/shared/degradation.ts`).
`respawn` carries the harness bringing an agent back (M8.6, `src/main/respawn.ts`):
`scheduled` with its `attempt` and `waitMs`, `respawned`, `deferred`/`released`
around a capacity hold, and `blocked` when a standing rung-3 stop refuses the
return. Its own kind rather than another `spawn`, because the question actually
asked of it — *did the company survive the night* — has to be answerable from
the log alone; it was answerable before only for the orchestrator, under
`orchestrator`, which is how "46 respawn-scheduled rows, all Artemis, zero crew"
could be established at all. The orchestrator's rows keep their historic
`orchestrator` names, so a year of log files stays readable.


`shutdown` carries closing time (GYM-003):
begin / ack / complete, with the shortfall named. `stoa` carries the research
cycle (§7.7): study started, brief accepted/rejected, watchlist changes. `orchestrator` carries Artemis's lifecycle (respawn ladder, down) and
FR-5.5's countersignatures and escalations.
Every kind carries enough refs to reconstruct the action (NFR-13). The activity UI,
briefing compiler, metrics, and forensics consume only this file + git history.

### 4.4 Hermes message (normative schema — ADR-0003)
```jsonc
{
  "id": "2026-08-26T14-03-11-123Z-a1b2",   // time-sortable unique
  "conversation": "conv-7f3",
  "in_reply_to": null,
  "from": "agent.mason",
  "to": "agent.artemis",                    // agentId | "broadcast" | "human"
  "act": "request",                         // request|inform|propose|query|agree|refuse|done
  "subject": "need staging DB creds decision",
  "body": "…markdown or structured payload…",
  "hops": 1,
  "requires_reply": true,                   // derived: act ∈ request|query|propose
  "needs_human": false,                     // router/Artemis may flip
  "created_at": "ISO-8601"
}
```

### 4.5 Decision memo (`odeon/memos/<id>/memo.md` + `verdict.json`)
Memo body is templated markdown: **Context / Options (≥2) / Recommendation / Blast
radius / Rollback**. Verdict:
```jsonc
{ "memoId": "m-102", "trigger": "new-dependency",
  "verdict": "approved",                    // approved|rejected|amended
  "decidedBy": "agent.artemis",             // or "architect"
  "countersigned": true, "authority": "delegated:test-code",
  "notes": "pin the version", "decidedAt": "ISO-8601", "taskId": "t-…-041" }
```

### 4.6 SQLite (app-local, never agent-visible)
`window_state`, `command_history`, `cost_ledger(agent, session, model, day, in_tokens,
out_tokens, cost_usd, source)` (append-only; ADR-0011). The org layer keeps no
`metrics_rollup` table after all: M5.6 chose recompute-on-read from `log.jsonl` +
the cost fold (DECISIONS-LOG 2026-08-28), so metrics can never disagree with the
book of record.
The recall keyword index is deliberately *not* here — it lives in `index/fts.sqlite`
(§2), because it is derived state a repair may delete and this file is not.

### 4.7 Stoa watchlist (`stoa/watchlist.json`) and research briefs (ADR-0017)
```jsonc
{
  "schemaVersion": 1,
  "sources": [{
    "id": "src-hermes-agent",              // stable, slug-derived
    "url": "https://github.com/NousResearch/hermes-agent",
    "kind": "git",                          // v1: git only; field leaves room for more
    "tags": ["agent-loop", "tool-use"],     // what to learn — scopes every study
    "license": "MIT",                       // as verified at registration; "unverified"
                                            //  ⇒ study allowed, pattern intake refused
                                            //  (FR-13.5)
    "pin": "8c1f2ab",                       // commit each study runs against; briefs
                                            //  cite this pin. Architect advances it.
                                            //  NULL until the first study sets it:
                                            //  FR-13.2 needs a pinned snapshot, so an
                                            //  unpinned entry is registered but NOT
                                            //  studiable (M5b.1)
    "registeredBy": "architect",            // only ever "architect" (FR-13.1)
    "registeredAt": "ISO-8601",
    "notes": "why this source; what the Architect wants learned"
  }],
  "retired": []                             // retired entries, VERBATIM (M5b.1). A
                                            //  sibling of `sources`, not a flag on an
                                            //  entry, so `sources` holds only studiable
                                            //  sources by construction and a consumer
                                            //  that forgets to filter cannot study a
                                            //  retired one. Same idiom as §2's
                                            //  inbox/ → inbox/.done/: processed, never
                                            //  deleted — a brief still cites its source
}
```
A **research brief** (`stoa/briefs/RB-<NNN>-<slug>.md`) is templated markdown with
required sections, validated by `stoa.ts` before archiving (an uncited finding
rejects the brief pre-human — FR-13.3): **Source** (watchlist id + `repo@commit`) /
**Question** (which tags this study served) / **Findings** (each with file-path
citations into the pinned commit) / **Applicability** (mapped to Ephesus subsystems,
cross-referenced to internal records where they exist) / **Candidate improvements**
(seeds for GYM proposals — candidates, not proposals) / **License note**. Briefs are
immutable once archived; proposals cite them by id in their evidence refs.

---

## 5. IPC contract (`window.eph`)

Typed, promise-based, all validated in main. Grouped surface (abridged — the `.d.ts`
generated from `ipc.ts` is normative once code exists):

```
agents:   list() spawn(cfg) kill(id) interrupt(id) resume(id) card(id) send(id, text)
          respawn(id)                               // M8.6: accepts the card's
          // RespawnOffer (§10). Rejects with the reason when a standing rung-3
          // stop refuses it — the same guard both ladders ask, so the human
          // path and the automatic ones cannot disagree
pty:      write(id, data) resize(id, cols, rows) onData(id, cb) onExit(id, cb)
avatars:  list()                                     // §6 snapshots; push on state:avatars
commands: list() submit(id, text)                    // FR-1.3 queue-until-idle
hooks:    state()                                    // event-plane health + drift warnings
agora:    registry() tasks() board() log(afterSeq, limit) memory(id)
          recall(query, scope, limit) knowledge() registerKnowledge(name, text)
          // recall answers on the best rung that will answer and says which
          // (ADR-0006's ladder, visible); registerKnowledge writes the shelf
          // file and commits it through the single committer (FR-6.4, ADR-0004)
hermes:   threads(filter) compose(msgDraft)          // human-authored mail goes via Artemis
odeon:    briefs() decks() deck(ref) comment(ref, text) memos(queue) verdict(memoId, v, notes?)
          convene(meeting) meeting() meetingSay(text) meetingClose() retros() generateRetro()
          // deck(ref) is the viewer's read of one archived artifact; comment()
          // files an Architect review comment as mail to the orchestrator — it
          // never writes the ledger, which is hers (FR-5.2, UC-05 step 4)
herald:   pttStart() pttStop() speakBrief(id) config()
watch:    approvals() approve(gateId, v) budgets() humanQueue() dismiss(id) waterfall(id) breakerState()
          breakerStops() clearBreakerStop(agentId, expectedAt)
harbor:   repos() bridgeStatus()
          hireExport(profile, hire) profileExport(name)
          importInspect(blob) importInstall(blob)
          // FR-10.4's export/import, split because the requirement is: "import
          // only pre-fills the spawn form — a human always confirms". INSPECT
          // reads a blob and returns a RECOMPUTED disclosure, writing nothing;
          // INSTALL is what a confirmed form reaches, and it writes files
          // without activating. There is deliberately no channel that does both
          // and none that activates — an imported profile is inert until
          // `profiles:activate`, which is its own Architect action (M7.6)
profiles: list() inspect(name) activate(request) deactivate(instanceId)
          preview(request) instances()
          // list() rows an INVALID bundle too (`valid: false`) — a profile that
          // vanished when its JSON broke would look uninstalled. inspect() is
          // pure: it activates nothing. `request` is `{ profile, target:
          // { kind, id, path } }` — no document says how a target ref resolves
          // to a local path, so the Architect names the directory, as they
          // already do for a bare spawn, and main validates it. preview()
          // returns the SAME plan activate() executes (hires, grants, budgets,
          // composed autonomy, triggers, repos), so the screen ADR-0012's
          // safety story rests on cannot drift from the act. Added at M7.1/M7.2
          // under the M3.1 rule: a doc line and a DECISIONS-LOG entry, or it
          // does not ship
org:      chart() orgMetrics()                       // reviews()/applyReview land with
                                                     // UC-12's full loop (M7-era)
gym:      ledger() proposal(id) verdict(id, v) metricResult(id, r)   // verdicts: architect-only (FR-12.3)
          mode() setMode(m)                  // company mode (ADR-0018): setMode is
                                             // architect-only; first `improving`
                                             // enable checked against the proof gate
stoa:     watchlist() register(entry) retire(id) briefs() brief(id)
                                             // register/retire: architect-only (FR-13.1)
secrets:  set(name, value) status(name) test(name) delete(name)   // write-only (ADR-0010)
config:   get() set(patch) prompts.get(name) prompts.set(name, text)
```

Events pushed to the renderer: `pty:data:<id>`, `pty:exit:<id>`, `state:agents`,
`state:avatars`, `state:commands`, `state:tasks`, `log:append`, `odeon:queue`,
`gate:open`, `breaker:trip`, `herald:transcript`.

---

## 6. Avatar/agent state machine

States: `idle · alert · thinking · working · waiting · blocked · success · ghost ·
compacting · looping`. Transitions (event-plane driven; ADR-0002):

```
idle ──prompt-submitted──► alert ──pre-tool──► thinking(→station) ──arrive──► working
working ──post-tool──► thinking(→desk|→next station)
working|thinking ──stop(no pending)──► success ──250ms──► idle
stop(pending mail/task) ──block──► alert            (autonomy loop, ADR-0013)
any ──gate-opened──► blocked (wave at Watch post) ──verdict──► prior state
any ──waiting-on(agent|artemis)──► waiting
any ──breaker rung 1──► looping (tint) ──recover──► prior ──rung 3──► stopped
any ──process-exit──► ghost ──30s──► archived
compaction events ──► compacting (boxes animation) ──done──► prior state
```

Station map (tool class → floor station): file tools → shelf; shell → terminal bench;
web → portal; MCP → harbor kiosk; task/ledger writes → agora board; meetings → odeon.

---

## 7. Key sequences

### 7.1 Directive → delegated work (UC-02)
```
Architect ─voice/text─► Herald policy ─► Artemis session (prompt)
Artemis: reads roster + board ─► writes tasks.json entries (via its ledger tool = files
  in its own outbox as `propose` to harness ledger endpoint) ─► Hermes `request` to each
  assignee with self-contained spec
Router: delivers ─► log.jsonl ─► committer batch ─► inbox wake if assignee idle
Worker: Stop-hook drains inbox ─► works ─► `done` + resultRef ─► Artemis verifies ─►
  board update ─► (review flags? → Odeon gates) ─► debrief queued
```

### 7.2 Standup briefing (UC-04)
```
scheduler ─trigger─► odeon.briefingCompiler:
  window = since last brief
  facts = ledger deltas + log events + budget deltas + harbor queue + open gates/memos
  each fact carries source refs (log seq / task id / memo id)
─► Artemis renders facts → narrative (template forbids unref'd claims)
─► artifact odeon/briefs/<ts>.md (+refs) ─► Herald speaks (barge-in live)
─► remote: bridge push with summary + link
```

### 7.3 Memo-gated action (UC-06)
```
Worker action ─► Watch gate policy match (e.g. package.json dependency add)
  ─► action held; worker notified with memo template ref
Worker files memo ─► odeon.memoQueue ─► Artemis triage:
  in delegated authority? ─ yes ─► verdict + countersign ─► gate release/refuse
                          ─ no ──► Architect queue (badge, optional Herald note,
                                    remote push) ─► verdict ─► same path
verdict ─► Hermes message to worker ─► memo archived immutable ─► log event
```

### 7.4 Voice failover (FR-8.2)
```
herald.policy streams TTS via ElevenLabs adapter
  ├─ adapter error / 401 / p95 latency breach detected
  ├─ policy: cancel stream, mark provider degraded (cooldown),
  │          re-issue utterance tail on OpenAI Realtime adapter
  └─ one-line notice (spoken + UI chip). Failback: manual from Settings.
```

### 7.5 Incident (UC-09, Skeleton Crew)
```
webhook/health trigger ─► profile trigger binding ─► on-call agent task (auto)
agent follows playbooks/incident.md: triage → reproduce → playbook fix
  fix ok ─► inform Artemis ─► log ─► next brief
  needs gated action ─► §7.3 path with incident context; severity-1 → Herald announces now
```

### 7.6 Gymnasium improvement cycle (UC-13, ADR-0015)
```
scheduler (gym cadence) ─or─ retro/breaker/memo-pattern signal
  ─► Artemis mines records (org metrics, log.jsonl, breaker/budget, drift audits)
  ─► ONE proposal drafted (evidence refs · change · cost/risk · metric+window · rollback)
  ─► gymnasium.ts validates shape — missing metric or rollback ⇒ rejected pre-human (FR-12.2)
  ─► gate classification (ADR-0015 authority table) ─► Architect queue
       (Artemis may rank/pre-screen; may NOT verdict — enforced in gym.verdict handler)
verdict approve ─► ledger row `approved` ─► lands via normal task/memo machinery (§7.1/§7.3,
  inside the gym budget slice, FR-12.5) ─► row `landed` ─► scheduler books metric check
metric check ─► measured vs declared target
  ─ met ──► row `validated`
  ─ missed/unmeasurable ──► row `regressed` ─► rollback per proposal ─► log kind:gym
every transition ─► log.jsonl kind:gym ─► next standup brief (§7.2) reports gym slice + outcomes
Mechanically refused regardless of verdict: proposals altering gym gating, accepted ADRs,
or the Watch's global maxima (FR-12.3 — the Gymnasium cannot widen its own authority).
```

### 7.7 Stoa research cycle (UC-14, ADR-0017) and the mode gate (UC-15, ADR-0018)
```
scheduler (stoa cadence — fires autonomously only in mode `improving`) ─or─ on-demand
  ─► stoa.ts picks ONE watchlist source (architect-registered; license recorded; pin set)
  ─► researcher spawn: read-only checkout at the pin · no secret grants · tags injected
       as the study question · source content is DATA (NFR-17 — embedded instructions
       become findings, never actions)
  ─► ONE brief drafted (source@commit · cited findings · applicability · candidates
       · license note)
  ─► stoa.ts validates shape — uncited finding ⇒ rejected pre-human (FR-13.3)
  ─► brief archived immutably (stoa/briefs/) ─► log.jsonl kind:stoa
  ─► Artemis reviews + ranks candidates ─► GYM proposal(s) filed citing the brief
  ─► from here §7.6 unchanged: Artemis pre-screens, the Architect verdicts

Build state (M5b, recorded at the close-out audit): the cadence half above is a
HEARTBEAT — `stoa-cadence.ts` picks a source, builds the plan, and logs
(`cadence-fired`, mode-tagged); the researcher-SPAWN leg that turns the plan
into a running study is M7's, with the Recursive Improvement profile (§7.8).
Until then, autonomous cycles produce visible records, not briefs.

mode change (UC-15): architect requests `improving`
  ─► modes.ts (`CompanyModes`) checks the proof gate (SRS §6.9, constants in
     shared/mode.ts) against gym ledger + log ONLY
       ─ evidence missing ──► refusal listing exactly what is missing
       ─ met ──► mode flips · status strip + next brief state it · autonomous records
                 tagged with the mode from here on (FR-14.1)
revert to `directed`: always one ungated architect action; breaker rung 3 on gym/stoa
work reverts automatically and lands on the ledger (FR-14.5)
```

### 7.8 Recursive Improvement delivery (UC-16, ADR-0019/0020)
```
architect activates the Recursive Improvement profile
  ─► profiles.ts checks company mode — `directed` ⇒ refusal naming §6.9's missing
       evidence; `improving` ⇒ triggers armed (deactivation / mode revert disarms)
architect presents a repo URL on the Stoa panel ─► watchlist entry (FR-13.1 unchanged)
stoa cadence ─► brief (§7.7) ─► Artemis ranks ─► proposal filed ─► architect verdict (§7.6)
verdict approve
  ─► improver takes the task in its own worktree, branch agent/<name>/<topic> (git.ts)
  ─► commits authored as the COMPANY identity + per-agent co-author trailer
       (token: broker env-grant to the improver role only — ADR-0010, NFR-17)
  ─► PR opened via harbor/github.ts under the company account, body citing
       GYM-<NNN> + RB-<NNN> ─► log.jsonl (remote-tagged) ─► architect's queue
architect merges ─► ledger row `landed` ─► metric check booked (§7.6 unchanged)
architect rejects ─► revision on the SAME branch (ENGINEERING-STANDARDS §7)
Mechanically absent: any agent merge path — the account holds write, main is
PR-and-review protected, so the host enforces what the harness promises.
```

---

## 8. The Herald — component design (ADR-0007)

```
┌ policy.ts ──────────────────────────────────────────────┐
│ modes: PTT (always) · wake word (optional, local) ·      │
│ conversation policy: barge-in (≤250ms stop), repeat-back │
│ for destructive/spend approvals, provider selection +    │
│ failover state machine (healthy→degraded→cooldown)       │
└───┬───────────────┬───────────────┬─────────────────────┘
    │ SpeechToText  │ TextToSpeech  │ DuplexVoice
    ▼               ▼               ▼
 elevenlabs.ts   elevenlabs.ts   openai-realtime.ts
 (streaming STT) (streamed TTS,  (speech↔speech session;
                  cancelable)     used as full fallback)
```

Audio I/O lives in main (device policy) with a thin renderer visualizer. The Herald
never mutates state directly: recognized intents become ordinary Artemis prompts /
gate verdicts through the same IPC-validated paths as clicks (ADR-0007 consequence).
Persona (voice id, style prompt, phrase book) loads from `prompts/herald/*`.

---

## 9. The Watch — enforcement points

- **Gate policy** evaluates at three choke points: engine tool-permission prompts
  (native), Hermes `needs_human`, and harness-mediated actions (Harbor posts, spend).
  Deny-by-default; profile autonomy levels can only *loosen* up to global maxima —
  stricter wins (ADR-0012).
- **Budgets**: pre-flight burn-rate projection per task + post-hoc ledger folding
  (§4.6). Breaker signal wiring per ADR-0011. Rung 1's corrective sentence rides
  the hook boundary on `native`-grade engines — the next `post-tool` reply
  carries it as a decision the shim already relays, so it lands mid-turn — and
  falls back to the FR-1.3 command queue below that grade; the channel taken is
  a `breaker`/`steer-channel` log event (GYM-002, `watch/steer-notes.ts`).
- **A rung-3 stop is sticky** (M8.6, B11). `Breaker` keeps a `BreakerStop` per
  agent — the signals and the numbers that caused it — recorded *before* the
  stop is performed, since the process is about to exit and the exit forgets
  the session. `forgetSession` (what an exit calls) drops the spans and the
  rung; `forgetAgent` (decommissioning) drops the stop too; `clearStop` is the
  Architect's, and returns the agent to rung 0, releasing delivery and budget
  constraints. Stops now persist in app-local `breaker-stops.json` (schema 1)
  through atomic replacement before stopping. Both initial hires and respawns
  refuse a standing stop. Unreadable storage blocks starts and is surfaced.
  Watch lists stops even without live cards; `clearBreakerStop(agentId, expectedAt)`
  validates the reviewed decision, persists removal and refreshes the offer
  without emitting another lifecycle exit. Clearing never itself spawns an agent.
- **Telemetry**: every tool call becomes a span (agent, tool, duration, outcome) →
  waterfall UI; spans are local-only (NFR-10).
- **Company mode** (ADR-0018): `directed`/`improving` lives in `config.json`
  (with `everEnabledImproving`, since the proof gate is a FIRST-enable check —
  M5b.3); every change is written to a **`## Mode changes` section under the
  Gymnasium ledger's proposals table**, not as a row in it: a mode change is not
  a proposal and would corrupt the eight columns the parser reads. The scheduler
  consults the mode through a `Trigger.enabled()` predicate, so autonomy is
  switched off at the one place that STARTS autonomous work rather than inside
  each cadence.
  `gym.setMode` is architect-verified in the handler (the `gym.verdict` pattern);
  the first `improving` enable is checked against the proof gate (SRS §6.9) read
  from the gym ledger + log only; the scheduler consults the mode before firing
  the Stoa/Gymnasium cadences; a rung-3 breaker stop attributable to gym/stoa
  work reverts the mode (FR-14.5). Researcher spawns get read-only checkouts and
  no secret grants — enforced here, not by convention (NFR-17). The Recursive
  Improvement profile (FR-9.5) activates only in `improving`, and the company
  GitHub token (FR-10.5) is a broker grant declared only by improver roles.

---

## 10. Error handling & recovery invariants

| Failure | Behavior |
|---|---|
| Agent process crash | ghost → archive; ledger tasks back to `todo` with note (the note is a `task`/`returned` entry in `log.jsonl` — `tasks.json` carries no notes field); respawn offer on the agent card (`resumable` only where the adapter has `resume` *and* the event plane saw a session; `memorySections` from ADR-0006 layer 1). **Amended M8.6:** the offer is now RENDERED — it had zero references outside main until then, so a dead crew agent had no way back — and it carries `blockedBecause`, so a card never shows a control for a respawn that would be refused. A hire whose bundle declares `onExit: "respawn"` additionally gets a backoff ladder (`respawn.ts`, three rungs, five-minute stability window); the default stays `offer` |
| Agent stopped by the breaker at rung 3 | The stop is a decision about the AGENT, not about the process: it is recorded before the stop is performed and outlives the exit it causes (M8.6, B11). It refuses every respawn path — the crew's ladder, the orchestrator's ladder, and the Architect accepting the offer — until a human clears it (`Breaker.clearStop`), which also returns the agent to rung 0. Before this, `forget` ran on every exit including the one rung 3 had just caused, so an exhausted budget cycled instead of stopping: 21 climbs to rung 1 against exactly one completed stop across a 24.9M-token day |
| Worktree isolation requested and unavailable | The spawn is REFUSED, naming git's own reason, and the agent id is released so the Architect can fix the repository and activate again (M8.6, Architect decision 2026-09-04). It used to log the failure and continue in the Architect's own checkout; that fallback was the harm isolation is requested to prevent. Profile activation is all-or-nothing, so one refused hire refuses the instance rather than leaving a partial crew |
| Harness crash | On start: committer reconciles uncommitted Agora files; cursors prevent re-processing; PTYs are gone — agents relisted as `ghost`, resumable ones offered |
| Hook socket down | Engine shims fail-open (agent unaffected); floor freezes with a visible "events stale" banner, never invents motion |
| Message to dead agent | bounce `refuse` + log (FR-3.4) |
| Git lock contention | impossible by construction (single committer); stale locks from crashes cleaned at startup (ADR-0004) |
| Voice provider down | failover §7.4; both down → text-only banner, zero feature loss outside audio (FR-8.6) |
| Recall index corrupt | delete + rebuild from markdown (derived state, §2) |
| Schema drift (hooks/profile) | validate, warn visibly, degrade per FR-2.3 / refuse activation with diff |
| Orderly quit with live agents (GYM-003, `closing.ts` + `shutdown.ts`) | **Every quit gesture runs one sequence, once** (amended M8.1): `before-quit` holds the exit, `shutdown.ts` runs closing time → agent unwind → the stops, and only then does the app go. Closing time is *offered*, never forced: on accept, every live agent gets a `request` from `agent.closing` (park WIP, append state to `memory.md`, acknowledge); acks route back as an endpoint hand-off; teardown proceeds when all ack or at the hard deadline, with every silent agent named in the report and `log.jsonl` (`kind: shutdown`). "Quit now" and an empty floor skip straight to teardown. Each phase is isolated: a closing that cannot start must not stop the unwind, and an unwind that fails must not leave the PTYs running or the database open. On macOS closing the last window leaves the company running and `activate` re-attaches the bridge to the new one; elsewhere it quits, through the same sequence |

---

## 11. Performance budget allocation (NFR-1…NFR-4)

- Floor: one Pixi ticker, sprite batching, animations pause when window hidden; log
  rendering virtualized + batched (30-agent degradation mode: 30 fps floor, coalesced
  log appends).
- PTY: direct binary IPC channel per agent, no JSON wrapping of byte streams.
- Hermes: fs-watch debounce 50 ms; delivery p95 budget 500 ms includes commit batching
  (commits happen *after* inbox visibility — delivery is rename, durability is commit).
- Herald: TTS streaming starts on first chunk; briefing compile is data-side (< 500 ms)
  before narration begins.

---

## 12. Traceability

| SRS | Design section |
|---|---|
| FR-1 | §1, §3, §6 (pty.ts, engines/) |
| FR-2 | §1, §6, §10 (hooks.ts) |
| FR-3 | §4.4, §7.1 (hermes.ts) |
| FR-4 | §2, §4.1–4.3 (agora.ts) |
| FR-5 | §1, §7.1–7.3 (artemis.ts) |
| FR-6 | §2, §4, ADR-0006, ADR-0016 (library.ts) |
| FR-7 | §4.2, §4.5, §7.2–7.3 (odeon.ts) |
| FR-8 | §8 (herald/) |
| FR-9 | ADR-0012, §7.5 (profiles.ts) |
| FR-10 | §1 (harbor/) |
| FR-11 | §9 (watch/), §4.6, org.ts |
| FR-12 | §2, §7.6 (gymnasium.ts), ADR-0015 |
| FR-13 | §2, §4.7, §7.7 (stoa.ts), ADR-0017 |
| FR-14 | §9, §7.7 (watch/gates.ts, scheduler.ts), ADR-0018 |
