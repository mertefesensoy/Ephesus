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

**Exit:** SRS §6.2 standup test and §6.5 failover test pass live; S-FAILOVER passes
scripted; a full day driven by voice without touching the keyboard for status.

## M7 — The Harbor + missions: the working company (≈ 3–4 weeks) — *differentiator*

Profile schema + loader + activation UI. **Skeleton Crew** built-in profile (health
watcher, CI babysitter, dependency updates, incident playbooks + severity
escalation). **Front Office** built-in profile (issue/PR triage, reply drafting with
autonomy levels, docs/changelog sync, release-prep checklist). **Recursive
Improvement** built-in profile (FR-9.5, ADR-0019 — needs M5b's Stoa and modes):
researcher + improver roles, mode-gated activation, delivery as PRs under the
company identity (FR-10.5, ADR-0020 — machine account, broker-held token, the
attribution carve-out in `check-attribution.cjs` lands here). GitHub ingestion via
`gh`. Chat bridge (remote conversation, briefs, approvals; `remote` tagging).
Shareable hires/profiles (export/import, human-confirmed). Packaging: signed builds
for macOS/Windows/Linux, one-click update check.

**Exit:** **The one-hour company test (SRS §6.1) passes on a real repo.** S-PROFILE
and S-RECURSE pass; the recursive test (SRS §6.10) lands one real chain — URL on
the Stoa panel → brief → approved proposal → company-identity PR → Architect
merge; a real overnight run produces a truthful morning brief on the phone. The
Gymnasium and Stoa cadence triggers are live under company-mode governance
(ADR-0018 — they fire autonomously only in `improving`, which the proof gate
§6.9 must first unlock), and the two-week gymnasium acceptance test
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
| R12 | Prompt injection / hostile content in a watched source steers the researcher | Medium | High | ADR-0017 R2: content is data; read-only, no-secrets researcher spawns enforced by the Watch (NFR-17); adversarial S-STOA plants an injection per run; nothing from a source lands ungated (FR-13.4) |
| R13 | License/IP contamination from studied repositories | Low | High | Patterns not code (FR-13.5); license recorded at registration, `unverified` refuses pattern intake; verbatim/derived intake demands memo + attribution (ENGINEERING-STANDARDS §5) |
| R14 | Autonomy enabled before the loop is trustworthy, or left on through a failure | Low | High | ADR-0018: proof gate refuses the first enable until §6.9 evidence exists; mode is architect-only, always visible, mode-tagged records; breaker rung 3 auto-reverts (FR-14.5) |
| R15 | Recursive Improvement floods the Architect with PRs, or review decays into rubber-stamping | Medium | Medium | One scoped change per proposal (FR-12.2) bounds PR size; Artemis ranks before anything is implemented; the gym budget slice (FR-12.5) bounds volume; PR throughput + time-in-review become org-panel health metrics reviewed in retros (UC-12) |
| R16 | Company GitHub credential leaks or the account is misused | Low | High | ADR-0020: fine-grained PAT, broker write-only, env-grant to improver roles only; account holds write not admin; `main` PR-and-review protected so the host blocks merges; every remote act logged; one broker action revokes |

## Dependency order (what blocks what)

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M6 ─► M7
            │          │      ▲ └► M5b ──┘   (Stoa + modes need only Gymnasium v1;
            │          └──────┘              M7's cadences run under M5b's modes)
            └── fake-engine rig ─────────┘   (everything tests against it)
```

The only cross-cutting asset built early and maintained forever is the fake-engine
rig — it is the test double for every milestone and the reason the differentiators
can be built deterministically.
