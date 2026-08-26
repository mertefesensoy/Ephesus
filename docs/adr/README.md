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
