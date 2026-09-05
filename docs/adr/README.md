# Ephesus — Architecture Decision Records

One record per load-bearing decision. Format: Status / Context / Decision / Options
considered / Consequences / Prior art. Statuses: `accepted`, `proposed`, `superseded`.
New ADRs append; accepted ADRs are never edited, only superseded.

| ID | Title | Status |
|---|---|---|
| [ADR-0001](./ADR-0001-electron-shell.md) | Electron + React + TypeScript application shell | accepted |
| [ADR-0002](./ADR-0002-two-data-planes.md) | Two data planes: terminal (PTY) and event (hooks) | accepted |
| [ADR-0003](./ADR-0003-hermes-message-bus.md) | Hermes: file-based mailboxes with speech-act messages | accepted |
| [ADR-0004](./ADR-0004-agora-single-committer.md) | The Agora: git as coordination layer, single committer | accepted |
| [ADR-0005](./ADR-0005-artemis-orchestrator.md) | Artemis: an LLM agent as orchestrator, prompt as control surface | accepted |
| [ADR-0006](./ADR-0006-library-memory.md) | The Library: markdown-first memory, optional semantic index | accepted (layer 2 superseded by ADR-0016) |
| [ADR-0007](./ADR-0007-herald-voice-seam.md) | The Herald: provider-agnostic voice seam; ElevenLabs primary, OpenAI Realtime fallback | accepted |
| [ADR-0008](./ADR-0008-odeon-accountability.md) | The Odeon: accountability as an enforced subsystem, not a convention | accepted |
| [ADR-0009](./ADR-0009-engine-adapters.md) | Engine adapters: wrap real CLIs, never reimplement an agent runtime | accepted |
| [ADR-0010](./ADR-0010-secret-broker.md) | Write-only secret broker with env injection at spawn | accepted |
| [ADR-0011](./ADR-0011-watch-breaker-budgets.md) | The Watch: circuit-breaker ladder and a durable cost ledger | accepted |
| [ADR-0012](./ADR-0012-mission-profiles.md) | Mission profiles as declarative, versioned bundles | accepted |
| [ADR-0013](./ADR-0013-stop-hook-autonomy.md) | Autonomy loop via the engine's Stop hook | accepted |
| [ADR-0014](./ADR-0014-owned-spawn-and-floor.md) | Own the process lifecycle (spawn, not attach); the floor as observability | accepted |
| [ADR-0015](./ADR-0015-gymnasium-self-improvement.md) | The Gymnasium: self-improvement as the company's primary standing mission, governed | accepted |
| [ADR-0016](./ADR-0016-mempalace-archival.md) | MemPalace as the Library's recall index and the company archive | accepted |
| [ADR-0017](./ADR-0017-stoa-research-department.md) | The Stoa: a research department that feeds the Gymnasium external evidence | accepted |
| [ADR-0018](./ADR-0018-company-modes-proof-gate.md) | Company modes: standing self-improvement is earned through a proof gate | accepted |
| [ADR-0019](./ADR-0019-recursive-improvement-profile.md) | Recursive Improvement: the self-improvement mission as a third built-in profile | accepted |
| [ADR-0020](./ADR-0020-company-github-identity.md) | A company GitHub identity: agents co-author as themselves, never as the Architect | accepted |
| [ADR-0021](./ADR-0021-workspace-trust-at-activation.md) | The Architect's activation is the answer to the engine's trust prompt | accepted |
| [ADR-0022](./ADR-0022-company-identity-is-a-github-app.md) | The company identity is a GitHub App, not a machine user | accepted |
| [ADR-0023](./ADR-0023-usage-aware-pacing.md) | Pace the company against the account's usage window, not a fixed budget | accepted |
| [ADR-0024](./ADR-0024-claude-only-for-the-mvp.md) | The MVP ships one engine, and says so | accepted |
| [ADR-0025](./ADR-0025-workspace-trust-covers-the-worktrees-an-activation-creates.md) | Workspace trust covers the worktrees an activation creates | accepted |
| [ADR-0026](./ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md) | Engine isolation, and the harness as the only hook author | accepted |

**Clause notes** (an accepted ADR is never edited; a clause overtaken by a
recorded decision is listed here so its sentence is not read as current):

- ADR-0023 "writes each observation to `<home>/usage.json`" — as built, one
  report per agent at `<home>/usage/<agent>.json`. The account WINDOWS are
  account-wide and a single file served them, but the report also carries the
  live per-session cost, and one shared file is last-writer-wins: whichever
  agent rendered most recently would have every other agent's spend attributed
  to it. The decision is unchanged; only the file layout is.
- ADR-0011 "Budgets are enforced pre-flight where possible (burn-rate
  projection) … budget state feeds trip signal #4" — superseded by ADR-0023.
  The per-agent `dailyTokens` ceiling survives as a runaway backstop and
  `breached` still feeds signal #4, but `projected-breach` no longer trips the
  breaker, and normal operation is governed by the account's resetting usage
  window instead. The rest of ADR-0011 stands.
- ADR-0008 §4 "minutes + action items written to blackboard + ledger on close" —
  as built (M5.5, DECISIONS-LOG 2026-08-28), minutes archive in `odeon/minutes/`
  and action items go to the orchestrator as a `request`; nothing but the single
  scribe writes `board.md`/`tasks.json` (FR-4.2, ADR-0004). SDD, which takes
  precedence, states the built behavior.
