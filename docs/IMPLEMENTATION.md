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
Fake-engine binary v1 and the adapter conformance suite.

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
index (CPU embeddings, mtime-gated) + FTS/grep degrade, Memory panel, reflection job
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

## M6 — The Herald: the spoken company (≈ 2–3 weeks) — *differentiator*

Voice seam interfaces + policy layer (PTT, barge-in, repeat-back, failover state
machine). ElevenLabs adapter (STT + streamed TTS), OpenAI Realtime adapter (duplex).
Persona/phrase-book assets. Spoken briefings + voice approvals + meeting narration.
Optional local wake word. Text-parity degradation.

**Exit:** SRS §6.2 standup test and §6.5 failover test pass live; S-FAILOVER passes
scripted; a full day driven by voice without touching the keyboard for status.

## M7 — The Harbor + missions: the working company (≈ 3–4 weeks) — *differentiator*

Profile schema + loader + activation UI. **Skeleton Crew** built-in profile (health
watcher, CI babysitter, dependency updates, incident playbooks + severity
escalation). **Front Office** built-in profile (issue/PR triage, reply drafting with
autonomy levels, docs/changelog sync, release-prep checklist). GitHub ingestion via
`gh`. Chat bridge (remote conversation, briefs, approvals; `remote` tagging).
Shareable hires/profiles (export/import, human-confirmed). Packaging: signed builds
for macOS/Windows/Linux, one-click update check.

**Exit:** **The one-hour company test (SRS §6.1) passes on a real repo.** S-PROFILE
passes; a real overnight run produces a truthful morning brief on the phone. The
Gymnasium cadence trigger is live, and the two-week gymnasium acceptance test
(SRS §6.7) is booked as the final v1 acceptance gate.

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

## Dependency order (what blocks what)

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M6 ─► M7
            │          │      ▲      ▲
            │          └──────┘      │   (Library feeds briefing quality)
            └── fake-engine rig ─────┘   (everything tests against it)
```

The only cross-cutting asset built early and maintained forever is the fake-engine
rig — it is the test double for every milestone and the reason the differentiators
can be built deterministically.
