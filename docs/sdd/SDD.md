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
| `engines/` | `EngineAdapter` registry: `claude.ts` (reference), `codex.ts`, `gemini.ts`, `grok.ts`, `opencode.ts`, `custom.ts` | 0009 |
| `agents.ts` | `AgentManager`: spawn ordering (probe → token → identity → settings → process), FR-1.6 install offer, exit unwind (settings restored, token revoked) | 0009, 0010 |
| `pty.ts` | `PtyManager`: spawn/write/resize/interrupt/kill/resume; PATH resolution for spawn plans (`which.ts`); the redaction filter on outbound streams, wired in `pty-stream.ts` (split out so it is testable without node-pty) | 0014, 0010 |
| `avatars.ts` | `AvatarDirector`: hook events → §6 avatar snapshots, the walk clock (`arrive`) and the §6 timers | 0002 |
| `commands.ts` | `CommandQueue`: FR-1.3 queue-until-idle, held text, two-write submit | — |
| `prompts.ts` | `PromptStore`: harness-home-first prompt/template loading, seeded from the bundled copies | — |
| `hooks.ts` | UDS/named-pipe server; payload validation; schema-drift warnings; PTY-heuristic fallback registration | 0002 |
| `hermes.ts` | Outbox watchers, delivery (temp+rename), hop-cap diversion, bounce, broadcast fan-out, wake watchdog, Stop-hook decisioning | 0003, 0013 |
| `git.ts` | The **only** module that invokes `git` in the app, worktree isolation (UC-01 2a) included. ADR-0004's single-committer claim lives here, and CI fails on a `git` call anywhere else — except the named development-repo tools in `check-invariants.cjs`'s allowlist, which run outside the app process and never touch a harness home | 0004 |
| `eventlog.ts` | `log.jsonl` appender/reader: seq recovery, append-only writes, tolerance of a torn tail from a killed harness | 0004 |
| `settings-registry.ts` | Durable record of settings files written into an agent's repo, so a force-killed harness can undo them on the next boot | 0009 |
| `agora.ts` | On-disk layout, registry/ledger/board accessors, `log.jsonl` appender, the single git committer (queue, retry+backoff, startup reconcile) | 0004 |
| `ledger.ts` | The task-ledger endpoint (§7.1): validates Artemis's `propose` acts and writes `tasks.json` and `board.md` through the single committer — agents never touch either file | 0005, 0004 |
| `artemis.ts` | Orchestrator lifecycle: auto-spawn, reserved seat, respawn-with-memory, prompt/config assembly, delegated-authority table | 0005 |
| `library.ts` | Memory read/write helpers, the corpus, the recall ladder and its visible state, MemPalace driver (`eph-recall`, archive ingestion), reflection scheduler, knowledge shelf. `library-fts.ts` holds the FTS rung's behaviour (mtime gate, scoring, scope) and `library-fts-sqlite.ts` its SQLite FTS5 storage, split so the native module stays out of the test runner; `library-mempalace.ts` drives the MemPalace CLI under ADR-0009's subprocess discipline (version probe, visible install offer, no daemon flags, engine-side auto-save hooks forced off) | 0006, 0016 |
| `odeon.ts` | Briefing compiler, deck-gate on task close, memo policy engine + queues + verdict routing, meeting driver (turn-taking, minutes) | 0008 |
| `herald/` | `seam.ts` (STT/TTS/Duplex interfaces), `policy.ts` (wake word, barge-in, repeat-back, failover), `elevenlabs.ts`, `openai-realtime.ts` | 0007 |
| `harbor/` | `github.ts` (issues/PRs/CI via `gh`), `bridge.ts` (chat bridge), `webhooks.ts`, `hires.ts` (export/import) | — |
| `watch/` | `gates.ts` (approval queue + policy), `budgets.ts` + `ledger.ts` (durable cost), `breaker.ts` (ladder), `telemetry.ts` (OTel spans, waterfall), `secrets.ts` + `cipher.ts` (write-only broker, OS-keychain seam) | 0011, 0010 |
| `profiles.ts` | Profile load/validate/activate/instantiate; schema versioning | 0012 |
| `org.ts` | Departments, hire-template versioning, per-agent metrics, review/retro reports | — |
| `gymnasium.ts` | Improvement-proposal validation (metric + rollback required), ledger accessors, gate classification, metric-check scheduling, rollback driver | 0015 |
| `stoa.ts` | Watchlist accessors (Architect-only mutation, enforced in the handler like `gym.verdict`), researcher spawn plans (read-only checkout, no secret grants), brief validation (uncited finding ⇒ rejected pre-human), brief archive, the Stoa cadence (a scheduler client, mode-gated) | 0017, 0018 |
| `scheduler.ts` | Cron-like triggers (standups, reflection, reviews, profile triggers) with idempotent ticks — a trigger fires at most once per interval and is never re-entered while running. `reflection.ts` is its first client: it asks an agent to condense its own memory (ADR-0006 layer 3) and applies what the agent proposes back to the reserved `agent.library` endpoint — the harness never summarizes (ADR-0005) | 0006, 0005 |
| `db.ts` | SQLite: app-local state (window bounds, command history) + cost ledger | 0004, 0011 |
| `config.ts` | Harness home setup, config persistence (text assets are loaded by `prompts.ts`) | — |
| `home.ts` | The harness home's shape: `HOME_DIRS`, creation, `config.json` load with a visible warning on a corrupt file (SDD §2) | — |
| `fsx.ts` | `writeFileAtomic` — temp file + rename, the one write path for anything another process reads (invariant §3) | 0003 |
| `index.ts` | Boot and wiring: constructs every module above, connects the two planes, registers IPC, and owns shutdown. Holds no logic of its own | 0001 |
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
    gymnasium/
      LEDGER.md              # permanent self-improvement ledger (seeded from the
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
gym, shutdown, error }`. `shutdown` carries closing time (GYM-003):
begin / ack / complete, with the shortfall named. `orchestrator` carries Artemis's lifecycle (respawn ladder, down) and
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
out_tokens, cost_usd, source)` (append-only; ADR-0011), `metrics_rollup` (org layer).
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
    "registeredBy": "architect",            // only ever "architect" (FR-13.1)
    "registeredAt": "ISO-8601",
    "notes": "why this source; what the Architect wants learned"
  }]
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
odeon:    briefs() decks() memos(queue) verdict(memoId, v) convene(meeting) meetingSay(text)
herald:   pttStart() pttStop() speakBrief(id) config()
watch:    approvals() approve(gateId, v) budgets() humanQueue() dismiss(id) waterfall(id) breakerState()
harbor:   repos() bridgeStatus() hireExport(role) hireImport(blob)
profiles: list() inspect(name) activate(name, target) deactivate(instanceId)
org:      chart() metrics(agentId) reviews() applyReview(changeSet)
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

mode change (UC-15): architect requests `improving`
  ─► watch/gates.ts checks the proof gate (SRS §6.9) against gym ledger + log ONLY
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
- **Telemetry**: every tool call becomes a span (agent, tool, duration, outcome) →
  waterfall UI; spans are local-only (NFR-10).
- **Company mode** (ADR-0018): `directed`/`improving` lives in `config.json`;
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
| Agent process crash | ghost → archive; ledger tasks back to `todo` with note (the note is a `task`/`returned` entry in `log.jsonl` — `tasks.json` carries no notes field); respawn offer on the agent card (`resumable` only where the adapter has `resume` *and* the event plane saw a session; `memorySections` from ADR-0006 layer 1) |
| Harness crash | On start: committer reconciles uncommitted Agora files; cursors prevent re-processing; PTYs are gone — agents relisted as `ghost`, resumable ones offered |
| Hook socket down | Engine shims fail-open (agent unaffected); floor freezes with a visible "events stale" banner, never invents motion |
| Message to dead agent | bounce `refuse` + log (FR-3.4) |
| Git lock contention | impossible by construction (single committer); stale locks from crashes cleaned at startup (ADR-0004) |
| Voice provider down | failover §7.4; both down → text-only banner, zero feature loss outside audio (FR-8.6) |
| Recall index corrupt | delete + rebuild from markdown (derived state, §2) |
| Schema drift (hooks/profile) | validate, warn visibly, degrade per FR-2.3 / refuse activation with diff |
| Orderly quit with live agents (GYM-003, `closing.ts`) | Closing time is *offered*, never forced: on accept, every live agent gets a `request` from `agent.closing` (park WIP, append state to `memory.md`, acknowledge); acks route back as an endpoint hand-off; teardown proceeds when all ack or at the hard deadline, with every silent agent named in the report and `log.jsonl` (`kind: shutdown`). "Quit now" and an empty floor skip straight to teardown — today's path, one click |

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
