import type { CapacityLimit } from '../../shared/capacity'
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
   * Asks the CLI whether it is LOGGED IN — a different question from
   * whether it exists (M8.4).
   *
   * Optional because not every engine has an answerable one; an adapter
   * without it is trusted, which is the behaviour every adapter had before.
   * `login` is what the Architect runs to fix it, shown on the card.
   */
  readonly authProbe?: {
    readonly command: CommandLine
    /**
     * Contract: THREE-valued, and never throws.
     *
     * `true` when the output proves a session, `false` when it proves there
     * is none, and `null` for anything else — a wording this adapter does not
     * recognise, a CLI that changed its message, an empty answer. `null` is
     * not `false`: reading "I could not tell" as "logged out" would refuse to
     * start a perfectly good company the first time an engine rephrased its
     * own status line. `test/pin.ts` is this repository's worked example of
     * the same rule.
     */
    authenticated(stdout: string, exitCode: number): boolean | null
    readonly login: string
  }
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
  /**
   * The git author the company's work is committed under (ADR-0022), or null
   * when no company identity is configured.
   *
   * Deliberately NOT carried in `envGrants`: a grant is a credential the broker
   * released to a role that declared it, and re-scoping grants to the declared
   * names is the invariant that keeps undeclared variables out of a spawn. An
   * author name is neither secret nor declared, so smuggling it through that map
   * would weaken the one check standing between a spawn and the harness's whole
   * environment.
   */
  readonly commitIdentity: { readonly name: string; readonly email: string } | null
  /** Absolute path to `agora/agents/<id>/identity.md` (SDD §2). */
  readonly identityPath: string
  /** Absolute path to the agent-facing `agora/PROTOCOL.md` (SDD §2). */
  readonly protocolPath: string
  /**
   * The Library's memory layer for this spawn, already composed and budgeted
   * (ADR-0006 layer 1, FR-6.1) — empty when the agent has written nothing yet.
   *
   * Text rather than a path, and resolved in main exactly as `envGrants` are:
   * deciding *how much* of a long memory a spawn can carry is the Library's
   * judgement, and an adapter that re-derived it would make that judgement
   * engine-specific (NFR-12).
   */
  readonly memory: string
  /**
   * The command an agent runs to search the company's memory
   * (`eph-recall`, ADR-0006 layer 2), e.g. `node /…/shims/eph-recall.mjs`.
   * Adapters export it to the agent as `EPH_RECALL`; empty when the harness has
   * no recall surface wired, in which case `PROTOCOL.md`'s instruction to use
   * it is the thing that must not be printed.
   */
  readonly recallCommand: string
  /**
   * The command an agent runs to get a FRESH GitHub installation token
   * (`eph-gh-token`, ADR-0022). Adapters export it as `EPH_GH_TOKEN`.
   *
   * Separate from the token itself, which arrives in `envGrants` and is a
   * snapshot: a token lives an hour, an agent may not, and an agent holding a
   * stale copy gets a 401 that reads like a permissions mistake. Empty when no
   * company identity is configured, in which case the adapter exports nothing
   * and `PROTOCOL.md`'s instruction to use it is the thing that must not print.
   */
  readonly ghTokenCommand: string
  /**
   * The autonomy this spawn runs at — the profile's level composed against the
   * global ceiling (ADR-0012, FR-11.1), or the ceiling alone for an agent on no
   * profile.
   *
   * Adapters map it to whatever their engine calls "ask me less". It is handed
   * over here rather than read from the Watch, because an adapter that reached
   * for policy would be a second place autonomy is decided, and the more
   * permissive of two such places always wins in the end.
   *
   * Why it exists: through M7 the harness gated its OWN actions and left the
   * engine's permission prompt untouched, so an Architect who had granted a
   * profile full autonomy was still answering "Claude is waiting for your
   * input" every few minutes. `evaluateGate` refuses `tool-permission` by
   * construction, and correctly — the harness has no action to permit there,
   * the ENGINE does — so the only place that interruption can be answered is
   * the engine's own flag.
   */
  readonly autonomy: 'manual' | 'supervised' | 'autonomous'
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

/**
 * A **cumulative** money figure the engine reports for one (session, model).
 *
 * Distinct from `UsageFact` because it behaves in the opposite way, and
 * conflating the two would double-count on the first re-read. A `UsageFact` is
 * an INCREMENT — one turn's tokens, appended once. A `CostFact` is a RUNNING
 * TOTAL, rewritten as the session goes on: Claude Code emits it as a
 * `cost-state` line whose `totalCostUSD` and per-model `costUSD` cover
 * everything the session has spent so far.
 *
 * Folding therefore takes the difference against what the ledger already holds,
 * never the value itself (`foldCosts` in `shared/cost.ts`).
 */
export interface CostFact {
  readonly sessionId: string
  readonly model: string
  /** Total USD this session has spent on this model, since the session began. */
  readonly cumulativeUsd: number
  /**
   * False when the engine said it could not price every model it used
   * (`hasUnknownModelCost`). The priced models' figures are still true, so they
   * are still folded — but the total they add up to is an UNDERSTATEMENT, and
   * the caller has to be able to say so out loud rather than presenting it as
   * the whole bill (invariant §7).
   */
  readonly priced: boolean
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
  /**
   * Contract: pure. Classifies ONE already-parsed transcript record as a
   * provider-capacity refusal, or returns null for everything else.
   *
   * OPTIONAL, and the optionality is the honest part: an engine whose
   * transcript does not distinguish "the provider refused" from "the turn
   * ended" cannot support parking, and the Watch says so (`CapacityWatch`
   * reports `unwatched`) rather than pretending an agent is covered.
   *
   * Pure and per-record rather than per-file so the Watch owns the reading —
   * one tail-read, one JSONL split — and the adapter owns only the shape it
   * alone knows (NFR-12). It is the same division as `claudeUsageFact`.
   *
   * A classifier must be NARROW. Waiting fixes a rate limit; it does not fix a
   * billing failure, a bad request, or an overloaded server. Matching those too
   * would park a company on a condition that never clears.
   */
  limitOf?(raw: unknown): CapacityLimit | null
  /**
   * Contract: the engine's own money figures for one transcript, or none.
   *
   * OPTIONAL, and its absence is a real product tier rather than a fault: an
   * engine that reports tokens but not dollars leaves `costUsd` null, which the
   * UI must show as "not reported" and never as "free" (ADR-0011).
   *
   * At most ONE fact per (session, model) — the newest running total. An engine
   * that writes several snapshots into one file must yield only the last, or
   * the caller cannot tell a re-read from real spending.
   */
  costs?(filePath: string): Promise<readonly CostFact[]>
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
  /**
   * Records the Architect's approval of a working directory in whatever store
   * the engine consults before it will start there (ADR-0021).
   *
   * OPTIONAL, and absent on purpose for engines whose only route past their own
   * trust prompt is a bypass flag: DECISIONS-LOG 2026-08 pinned codex and gemini
   * at `pty-heuristic` rather than pass `--dangerously-bypass-hook-trust` or
   * `--skip-trust`, and this hook does not reopen that. It exists for engines
   * that keep a per-workspace record a human's decision can be written into,
   * which today means Claude Code alone.
   *
   * Contract: called ONLY from an activation the Architect performed, with the
   * target of that activation, and never from spawn. Returns what it did so the
   * caller can log it — pre-trusting must never be silent.
   */
  trustWorkspace?(cwd: string, existence?: WorkspaceExistence): WorkspaceTrustResult
  /**
   * Sorts one `notification` event into what the engine actually meant.
   *
   * Engines fire a single notification for at least two unrelated situations,
   * and the words are the only thing that tells them apart — so the words live
   * here (NFR-12) and core never learns an engine's phrasing.
   *
   * `null` means "cannot tell", and the caller must treat that as a permission
   * prompt: a real prompt mistaken for idleness would leave an agent blocked
   * with nobody told, which is the worse of the two errors.
   */
  notificationKind?(payload: unknown): NotificationKind | null
}

/**
 * What an engine's notification meant. `waiting` is an agent sitting at an
 * empty prompt with nothing to do — a fact about idleness, not a request for a
 * decision, and gating it asks the Architect to approve an agent's silence.
 */
export type NotificationKind = 'permission' | 'waiting'

/**
 * Whether the directory being trusted is there yet (M8.7).
 *
 * `must-exist` is the default and ADR-0021's original case: the Architect named
 * a target that is on the disk in front of them, and it is resolved through
 * `realpath` in full so the record cannot be aimed at another directory by a
 * junction swapped in afterwards.
 *
 * `will-be-created` exists because M8.6 made isolation the default: the agents
 * an activation hires now work in `<home>/worktrees/<agentId>`, which git has
 * not made yet at the moment the Architect clicks. Trust is keyed on the exact
 * directory, so trusting only the target leaves every isolated hire meeting the
 * first-run dialog with no session and therefore no hook to report it — the
 * MUSAHIT parking failure ADR-0021 was written to close, re-opened from the
 * other side. The leaf cannot be resolved before it exists, so the PARENT is
 * resolved instead and the leaf appended; the parent is `<home>/worktrees`,
 * which the harness owns and creates, so nothing a repository or a target can
 * influence is left unresolved.
 */
export type WorkspaceExistence = 'must-exist' | 'will-be-created'

/** What `trustWorkspace` did, for the log line that must follow it. */
export type WorkspaceTrustResult =
  | { readonly ok: true; readonly path: string; readonly alreadyTrusted: boolean }
  | { readonly ok: false; readonly because: string }
