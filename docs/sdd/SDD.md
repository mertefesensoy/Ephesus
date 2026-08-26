# Ephesus — Software Design Description (SDD)

**Version:** 1.0 · **Status:** Approved for implementation
**Satisfies:** [SRS](../srs/SRS.md) FR-1…FR-11, NFR-1…NFR-16 · **Justified by:** [ADR-0001…0014](../adr/README.md)

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
| `pty.ts` | `PtyManager`: spawn/write/resize/interrupt/kill/resume; redaction filter on outbound streams | 0014, 0010 |
| `hooks.ts` | UDS/named-pipe server; payload validation; schema-drift warnings; PTY-heuristic fallback registration | 0002 |
| `hermes.ts` | Outbox watchers, delivery (temp+rename), hop-cap diversion, bounce, broadcast fan-out, wake watchdog, Stop-hook decisioning | 0003, 0013 |
| `agora.ts` | On-disk layout, registry/ledger/board accessors, `log.jsonl` appender, the single git committer (queue, retry+backoff, startup reconcile) | 0004 |
| `artemis.ts` | Orchestrator lifecycle: auto-spawn, reserved seat, respawn-with-memory, prompt/config assembly, delegated-authority table | 0005 |
| `library.ts` | Memory read/write helpers, recall index driver (`eph recall`), FTS fallback, reflection scheduler, knowledge shelf | 0006 |
| `odeon.ts` | Briefing compiler, deck-gate on task close, memo policy engine + queues + verdict routing, meeting driver (turn-taking, minutes) | 0008 |
| `herald/` | `seam.ts` (STT/TTS/Duplex interfaces), `policy.ts` (wake word, barge-in, repeat-back, failover), `elevenlabs.ts`, `openai-realtime.ts` | 0007 |
| `harbor/` | `github.ts` (issues/PRs/CI via `gh`), `bridge.ts` (chat bridge), `webhooks.ts`, `hires.ts` (export/import) | — |
| `watch/` | `gates.ts` (approval queue + policy), `budgets.ts` + `ledger.ts` (durable cost), `breaker.ts` (ladder), `telemetry.ts` (OTel spans, waterfall) | 0011 |
| `profiles.ts` | Profile load/validate/activate/instantiate; schema versioning | 0012 |
| `org.ts` | Departments, hire-template versioning, per-agent metrics, review/retro reports | — |
| `scheduler.ts` | Cron-like triggers (standups, reflection, reviews, profile triggers) | — |
| `db.ts` | SQLite: app-local state (window bounds, command history) + cost ledger | 0004, 0011 |
| `config.ts` | Harness home setup, config persistence, prompt/persona/template text assets | — |
| `ipc.ts` | Registers every handler behind the typed preload surface | 0001 |

---

## 2. On-disk layout (the harness home)

```
~/.ephesus/
  config.json                # app config (no secrets)
  events.sock                # hook socket (0600)
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
    agents/<agentId>/
      identity.md            # role, capabilities, env grants (mirrors hire template)
      memory.md              # long-term memory (Library layer 1)
      memory-archive/        # reflection condensation output
      inbox/  inbox/.done/   # Hermes delivery targets
      outbox/                # agent-written, router-drained
      cursor.json            # { lastProcessed }
  index/                     # recall index data (Library layer 2; disposable/rebuildable)
```

Rules: agents write only inside their own `agents/<id>/` and their assigned worktrees;
`board.md` only via Artemis; `log.jsonl` and `odeon/` only via the harness; the `index/`
directory is derived state and excluded from the Agora repo.

---

## 3. Engine adapter surface

Defined normatively in ADR-0009. Runtime notes:

- `SpawnPlan` composes: argv, cwd (target repo or worktree), env = base ∪ role-declared
  secret grants (ADR-0010) ∪ `EPH_AGENT_ID`/`EPH_HOOK_TOKEN`, and settings injection
  (e.g. writing hook shims into `<cwd>/.claude/settings.local.json`, backed up, with
  uninstall).
- **Identity injection:** at spawn the adapter arranges for `identity.md` +
  `PROTOCOL.md` context to reach the agent (engine-native context file, `--append-system-prompt`,
  or first-prompt injection — adapter's choice, conformance-tested for effect not
  mechanism).
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
brief, deck, meeting, breaker, budget, remote, secret-rotated, profile, error }`.
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

---

## 5. IPC contract (`window.eph`)

Typed, promise-based, all validated in main. Grouped surface (abridged — the `.d.ts`
generated from `ipc.ts` is normative once code exists):

```
agents:   list() spawn(cfg) kill(id) interrupt(id) resume(id) card(id)
pty:      write(id, data) resize(id, cols, rows) onData(id, cb)
agora:    registry() tasks() board() log(afterSeq, limit) memory(id)
hermes:   threads(filter) compose(msgDraft)          // human-authored mail goes via Artemis
odeon:    briefs() decks() memos(queue) verdict(memoId, v) convene(meeting) meetingSay(text)
herald:   pttStart() pttStop() speakBrief(id) config()
watch:    approvals() approve(gateId, v) budgets() waterfall(id) breakerState()
harbor:   repos() bridgeStatus() hireExport(role) hireImport(blob)
profiles: list() inspect(name) activate(name, target) deactivate(instanceId)
org:      chart() metrics(agentId) reviews() applyReview(changeSet)
secrets:  set(name, value) status(name) test(name) delete(name)   // write-only (ADR-0010)
config:   get() set(patch) prompts.get(name) prompts.set(name, text)
```

Events pushed to the renderer: `pty:data:<id>`, `state:agents`, `state:tasks`,
`log:append`, `odeon:queue`, `gate:open`, `breaker:trip`, `herald:transcript`.

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
  (§4.6). Breaker signal wiring per ADR-0011.
- **Telemetry**: every tool call becomes a span (agent, tool, duration, outcome) →
  waterfall UI; spans are local-only (NFR-10).

---

## 10. Error handling & recovery invariants

| Failure | Behavior |
|---|---|
| Agent process crash | ghost → archive; ledger tasks back to `todo` with note; respawn offer (resume if engine supports) |
| Harness crash | On start: committer reconciles uncommitted Agora files; cursors prevent re-processing; PTYs are gone — agents relisted as `ghost`, resumable ones offered |
| Hook socket down | Engine shims fail-open (agent unaffected); floor freezes with a visible "events stale" banner, never invents motion |
| Message to dead agent | bounce `refuse` + log (FR-3.4) |
| Git lock contention | impossible by construction (single committer); stale locks from crashes cleaned at startup (ADR-0004) |
| Voice provider down | failover §7.4; both down → text-only banner, zero feature loss outside audio (FR-8.6) |
| Recall index corrupt | delete + rebuild from markdown (derived state, §2) |
| Schema drift (hooks/profile) | validate, warn visibly, degrade per FR-2.3 / refuse activation with diff |

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
| FR-6 | §2, §4, ADR-0006 (library.ts) |
| FR-7 | §4.2, §4.5, §7.2–7.3 (odeon.ts) |
| FR-8 | §8 (herald/) |
| FR-9 | ADR-0012, §7.5 (profiles.ts) |
| FR-10 | §1 (harbor/) |
| FR-11 | §9 (watch/), §4.6, org.ts |
