# ADR-0009 — Engine adapters: wrap real CLIs, never reimplement an agent runtime

**Status:** accepted · **Date:** 2026-08-26

## Context
The agent runtimes the Architect already pays for (Claude Code first) are mature: they
own tool use, permissions, context management, transcripts, and their own auth/limits.
Rebuilding any of that (via raw model APIs) would make Ephesus an agent framework —
a different, worse product with a permanent maintenance war.

## Decision
Ephesus **wraps CLIs**. Each engine is integrated through an `EngineAdapter` with a
fixed conformance surface:

```ts
interface EngineAdapter {
  id: EngineId;                      // 'claude' | 'codex' | 'gemini' | 'grok' | 'opencode' | 'custom'
  binary(): BinarySpec;              // name, install command, version probe
  spawnArgs(cfg: AgentSpawnConfig): SpawnPlan;   // argv, env, cwd, settings injection
  hooks: HookSupport;                // 'native' | 'wrapper' | 'pty-heuristic'
  wireHooks(cfg): HookPlan;          // shim install (settings.local.json etc.)
  injectIdentity(cfg): void;         // how identity/protocol context reaches the agent
  interrupt(): KeySequence;          // engine's cancel key
  resume?: ResumeSupport;            // session-resume capability
  transcripts?: TranscriptReader;    // token/cost telemetry source (FR-11.2)
}
```

Rules:
- **Claude Code is the reference adapter** and the only one that may gate a release.
- Hook fidelity is graded (`native` > `wrapper` > `pty-heuristic`) and displayed on the
  agent card — degraded engines are honest about it (FR-2.3).
- Adapters never leak into core: Hermes, the Agora, the Odeon, and the floor consume
  only the adapter surface (NFR-12; enforced by dependency lint).
- Engine settings files are only ever written to local/gitignored variants
  (`settings.local.json` convention), backed up first, with an uninstall path.
- Missing binaries self-heal: the adapter's install command runs *in the agent's own
  visible terminal* with the Architect watching (FR-1.6) — no hidden installs.

## Options considered
- **Model APIs + our own tool loop.** Full control, and full ownership of the hardest
  problems (tool sandboxing, permissions, context) that vendors already solved; also
  forfeits the Architect's existing subscriptions. Rejected.
- **One engine only.** Simpler, but engine diversity is real leverage (different
  strengths, separate rate limits act as capacity pools) and upstream proved the demand.
- **SDK embedding (e.g. Claude Agent SDK).** Attractive for headless workers later;
  kept open as a future adapter *kind* behind the same interface — explicitly not a
  replacement for the PTY path, which is what makes terminals authentic.

## Consequences
- Ephesus inherits engine quirks (prompt formats, hook payload drift) — the adapter
  conformance suite (TEST-STRATEGY §5) is the containment wall.
- Capability differences (no hooks, no resume) become visible product tiers per engine
  rather than hidden breakage.

## Prior art
Munder Difflin's twelve-engine roster and provider bridge shims; its migration from
tmux-attach to owned spawn (see ADR-0014).
