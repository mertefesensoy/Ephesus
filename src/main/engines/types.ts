import type { EngineId, HookSupport } from '../../shared/engines'

/**
 * The engine adapter surface — normative in ADR-0009, with the runtime notes of
 * SDD §3. This file is a transcription, not a design: the `EngineAdapter`
 * members below are exactly the ADR's members, and the supporting types carry
 * only what the ADR/SDD name (argv · cwd · env · settings injection · install
 * command · version probe · shim install with backup+uninstall · cancel key ·
 * resume · transcript usage facts).
 *
 * Adapters never leak into core (NFR-12): Hermes, the Agora, the Odeon and the
 * floor consume only this surface, and the import-boundary lint keeps
 * engine-specific SDKs under `src/main/engines/`.
 */

/** An executable invocation: the program plus its argument vector. */
export interface CommandLine {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * ADR-0009 `binary()`: "name, install command, version probe".
 * `install` runs in the *agent's own visible terminal* when the binary is
 * missing (FR-1.6) — never as a hidden background install.
 */
export interface BinarySpec {
  /** Executable name resolved on PATH, e.g. `claude`. */
  readonly name: string
  /** Command that installs the engine, run where the Architect can watch it. */
  readonly install: CommandLine
  /** Command whose stdout carries the version string. */
  readonly versionProbe: CommandLine
  /**
   * Contract: extracts a version from `versionProbe` stdout, or null when the
   * output does not match what this engine is known to print. Null is a
   * visible "version unknown" state on the agent card, never a silent guess.
   */
  parseVersion(stdout: string): string | null
}

/**
 * Everything the harness knows about one spawn before the process exists.
 * `env` composition is SDD §3: base ∪ role-declared secret grants (ADR-0010)
 * ∪ `EPH_AGENT_ID`/`EPH_HOOK_TOKEN`.
 */
export interface AgentSpawnConfig {
  /** Registry id of the agent being spawned, e.g. `agent.mason` (`EPH_AGENT_ID`). */
  readonly agentId: string
  /** Per-spawn hook token validated on every hook payload (`EPH_HOOK_TOKEN`). */
  readonly hookToken: string
  /** Where the hook shim POSTs lifecycle events: UDS path or Windows pipe name. */
  readonly hookEndpoint: string
  /** Working directory: the target repo or the agent's assigned worktree. */
  readonly cwd: string
  /**
   * Role-declared secret grants, already resolved by the broker (ADR-0010).
   * Least-privilege: only what the hire template declares reaches this map.
   */
  readonly envGrants: Readonly<Record<string, string>>
  /** Absolute path to `agora/agents/<id>/identity.md` (SDD §2). */
  readonly identityPath: string
  /** Absolute path to the agent-facing `agora/PROTOCOL.md` (SDD §2). */
  readonly protocolPath: string
}

/**
 * A settings file the harness writes into the agent's cwd at spawn. Only ever
 * a local/gitignored variant (`settings.local.json` convention, ADR-0009), and
 * the pre-existing file is backed up before it is replaced.
 */
export interface SettingsInjection {
  /** Absolute path inside the spawn cwd. */
  readonly path: string
  readonly contents: string
}

/** ADR-0009 `spawnArgs()`: argv, env, cwd, settings injection (SDD §3). */
export interface SpawnPlan {
  /** Full argument vector, argv[0] being the engine binary name. */
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /**
   * Settings files this plan requires in place before the process starts —
   * produced by `wireHooks()` and installed through its `HookPlan`, so the
   * backup/uninstall path is never bypassed.
   */
  readonly settings: readonly SettingsInjection[]
}

/**
 * ADR-0009 `wireHooks()`: the shim install for one spawn. `install()` backs up
 * any pre-existing file first; `uninstall()` restores it byte-for-byte, which
 * is what the conformance suite's settings-file hygiene case asserts
 * (TEST-STRATEGY §5).
 */
export interface HookPlan {
  /** The files this plan writes; feeds `SpawnPlan.settings`. */
  readonly injections: readonly SettingsInjection[]
  /** Writes the injections after backing up whatever was there. */
  install(): Promise<void>
  /** Restores the backed-up state. Safe (a no-op) when nothing was installed. */
  uninstall(): Promise<void>
}

/**
 * ADR-0009 `interrupt()`: the engine's cancel key, written straight into the
 * agent's PTY. `label` exists because anything the harness sends on the
 * Architect's behalf must be inspectable (ENGINEERING-STANDARDS §4).
 */
export interface KeySequence {
  /** What the UI calls it, e.g. `Escape`. */
  readonly label: string
  /** The bytes written to the PTY, e.g. the escape character U+001B. */
  readonly bytes: string
}

/** ADR-0009 `resume?`: session-resume capability where the engine has one (FR-1.4). */
export interface ResumeSupport {
  /**
   * Contract: argv fragment that resumes `sessionId`, appended to the spawn
   * plan's argv. The session id itself comes from the event plane (hook
   * payloads carry it), not from this interface.
   */
  resumeArgs(sessionId: string): readonly string[]
}

/**
 * One usage fact folded from an engine transcript into the durable cost ledger
 * (FR-11.2; ledger columns in SDD §4.6). Cost figures always originate here or
 * in the ledger — never from an in-memory counter (BUILD-PROMPT §3.11).
 */
export interface UsageFact {
  readonly sessionId: string
  readonly model: string
  readonly inTokens: number
  readonly outTokens: number
  /** Engine-reported cost when it reports one; null means "derive downstream". */
  readonly costUsd: number | null
  /**
   * When the engine recorded this usage, ISO-8601, or null when the transcript
   * does not say.
   *
   * The ledger's `day` column IS the budget window (SDD §4.6 read with registry
   * §4.1's `dailyTokens`), so it has to be the day the tokens were *spent*, not
   * the day the harness happened to fold them. Without this, an agent running
   * across midnight bills its pre-midnight spend to tomorrow, and a repo with a
   * pre-existing transcript breaches its budget on the first tick from history
   * alone.
   */
  readonly at: string | null
}

/** ADR-0009 `transcripts?`: the token/cost telemetry source for an engine. */
export interface TranscriptReader {
  /** Absolute directory where this engine writes transcripts for the spawn. */
  transcriptDir(cfg: AgentSpawnConfig): string
  /**
   * Contract: parses one transcript file into usage facts. Unrecognized lines
   * are skipped, never guessed at — a drifted transcript format yields fewer
   * facts, not invented ones.
   */
  read(filePath: string): Promise<readonly UsageFact[]>
}

/** The conformance surface every engine integration implements (ADR-0009). */
export interface EngineAdapter {
  readonly id: EngineId
  binary(): BinarySpec
  spawnArgs(cfg: AgentSpawnConfig): SpawnPlan
  /** Declared hook fidelity; the conformance suite checks it against reality. */
  readonly hooks: HookSupport
  wireHooks(cfg: AgentSpawnConfig): HookPlan
  /**
   * Arranges for `identity.md` + `PROTOCOL.md` context to reach the agent —
   * engine-native context file, `--append-system-prompt`, or first-prompt
   * injection; the adapter's choice, conformance-tested for effect, not
   * mechanism (SDD §3).
   */
  injectIdentity(cfg: AgentSpawnConfig): void
  interrupt(): KeySequence
  resume?: ResumeSupport
  transcripts?: TranscriptReader
}
