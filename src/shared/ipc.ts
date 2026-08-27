import type { AgentCard, SpawnRequest } from './agents'
import type { AvatarSnapshot } from './avatar'
import type { CommandState } from './commands'
import type { LogEntry } from './log'
import type { Registry } from './registry'
import type { SecretStatus, SecretTest } from './secrets'
import type { TaskLedger } from './tasks'
import type { EphConfig } from './config'

/**
 * The typed `window.eph` surface (SDD §5) — the ONLY renderer door. Groups are
 * added milestone by milestone; every channel is registered in src/main/ipc.ts
 * and validated in main before touching state.
 */
export const IpcChannels = {
  configGet: 'config:get',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  agentsList: 'agents:list',
  agentsSpawn: 'agents:spawn',
  agentsCard: 'agents:card',
  agentsKill: 'agents:kill',
  agentsInterrupt: 'agents:interrupt',
  agentsSend: 'agents:send',
  avatarsList: 'avatars:list',
  hooksState: 'hooks:state',
  commandsList: 'commands:list',
  commandsSubmit: 'commands:submit',
  agoraRegistry: 'agora:registry',
  agoraTasks: 'agora:tasks',
  agoraLog: 'agora:log',
  agoraHealth: 'agora:health',
  // SDD §5's four channels, exactly. Write-only by construction (ADR-0010):
  // there is deliberately no `secrets:get`, and the API-surface test in
  // test/main/secrets.test.ts fails if a fifth channel is ever added here —
  // whether it reads a value or not, since widening the documented IPC
  // signature is a BUILD-PROMPT §8 must-ask, not an implementation detail.
  secretsSet: 'secrets:set',
  secretsStatus: 'secrets:status',
  secretsTest: 'secrets:test',
  secretsDelete: 'secrets:delete'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

// NOTE: this module must stay free of runtime dependencies (zod included) —
// the sandboxed preload imports it, and sandboxed preloads cannot require
// external modules at runtime. Validators live in the sibling schema modules
// (config.ts, pty.ts) which only main imports.

/** Per-id event channels pushed main→renderer (SDD §5: `pty:data:<id>`). */
export const ptyDataChannel = (id: string): string => `pty:data:${id}`
export const ptyExitChannel = (id: string): string => `pty:exit:${id}`

export interface ConfigSnapshot {
  config: EphConfig
  /** Non-null when config.json failed validation — shown in the UI, never silent. */
  warning: string | null
}

/** Push channel carrying agent-card changes to the renderer (SDD §5 `state:agents`). */
export const AGENTS_STATE_CHANNEL = 'state:agents'

/** Push channel carrying one agent's avatar snapshot (SDD §6, ADR-0002). */
export const AVATARS_STATE_CHANNEL = 'state:avatars'

/** Push channel carrying one agent's held command text (FR-1.3). */
export const COMMANDS_STATE_CHANNEL = 'state:commands'

/** Push channel signalling that `log.jsonl` has grown (SDD §5 `log:append`). */
export const LOG_APPEND_CHANNEL = 'log:append'

/** One agent's avatar snapshot, addressed. */
export interface AvatarUpdate {
  readonly agentId: string
  readonly snapshot: AvatarSnapshot
}

/**
 * Health of the event plane, for the visible degradation states FR-2.3 and
 * SDD §10 require: schema drift must be shown, and a hook endpoint that never
 * came up must be shown as "events unavailable" rather than a frozen floor with
 * no explanation.
 */
export interface HooksState {
  /** Endpoint currently listening, or null when the event plane is down. */
  readonly endpoint: string | null
  /** Distinct drift warnings seen this run, in first-seen order (FR-2.3). */
  readonly driftWarnings: readonly string[]
  /** Why the endpoint is down, when it is. */
  readonly failure: string | null
}

/**
 * Data-plane health, for invariant §7: every degradation is a visible UI state,
 * never a `console.warn` only the developer can see. Corrupt schema files,
 * commit-queue give-ups, and runtime failures (sweep/exit/hook-handler errors)
 * all surface here.
 */
export interface AgoraHealth {
  /** Schema files that failed to parse this run (kept on disk as evidence). */
  readonly fileWarnings: readonly { readonly file: string; readonly reason: string }[]
  /** Commits the queue gave up on after exhausting its retry budget. */
  readonly commitFailures: readonly { readonly subject: string; readonly reason: string }[]
  /** Runtime degradations reported by main since boot (bounded, newest last). */
  readonly runtime: readonly {
    readonly at: number
    readonly source: string
    readonly detail: string
  }[]
}

export interface EphApi {
  config: {
    get: () => Promise<ConfigSnapshot>
  }
  agents: {
    list: () => Promise<readonly AgentCard[]>
    /** Spawns one agent through its engine adapter; resolves with its card. */
    spawn: (request: SpawnRequest) => Promise<AgentCard>
    card: (agentId: string) => Promise<AgentCard>
    kill: (agentId: string) => Promise<void>
    /** Writes the engine's cancel key into the agent's PTY (ADR-0009). */
    interrupt: (agentId: string) => Promise<void>
    /** Sends Architect text to the agent's PTY verbatim (FR-1.3). */
    send: (agentId: string, text: string) => Promise<void>
    /** Subscribe to agent-card changes. Returns an unsubscribe function. */
    onChange: (cb: (card: AgentCard) => void) => () => void
  }
  avatars: {
    list: () => Promise<readonly AvatarUpdate[]>
    /** Subscribe to avatar snapshots. Returns an unsubscribe function. */
    onChange: (cb: (update: AvatarUpdate) => void) => () => void
  }
  hooks: {
    /** Event-plane health, including drift warnings that must be shown. */
    state: () => Promise<HooksState>
  }
  agora: {
    /** The roster (SDD §4.1). */
    registry: () => Promise<Registry>
    /** The task ledger (SDD §4.2). */
    tasks: () => Promise<TaskLedger>
    /** Events after `afterSeq` — the Activity feed pages with this (SDD §4.3). */
    log: (afterSeq: number, limit: number) => Promise<readonly LogEntry[]>
    /** Subscribe to "the log grew"; the feed then pages from its own cursor. */
    onAppend: (cb: () => void) => () => void
    /** Data-plane degradations — shown, never only logged (invariant §7). */
    health: () => Promise<AgoraHealth>
  }
  commands: {
    /** Agents currently holding unsent Architect text. */
    list: () => Promise<readonly CommandState[]>
    /**
     * Sends a free prompt to an agent, or holds it until the agent is idle
     * (FR-1.3). Resolves with what the harness did with it.
     */
    submit: (agentId: string, text: string) => Promise<CommandState>
    /** Subscribe to held-text changes. Returns an unsubscribe function. */
    onChange: (cb: (state: CommandState) => void) => () => void
  }
  /**
   * Write-only credential management (ADR-0010, SDD §5). Every method here
   * either takes a value or returns presence — none returns a stored value,
   * and none ever will: "show me my key" is impossible by design, and the
   * Architect re-pastes from the provider console when in doubt.
   */
  secrets: {
    set: (name: string, value: string) => Promise<SecretStatus>
    status: (name: string) => Promise<SecretStatus>
    /** Can the broker still retrieve this credential? ok|fail, never a value. */
    test: (name: string) => Promise<SecretTest>
    delete: (name: string) => Promise<SecretStatus>
  }
  pty: {
    /**
     * Raw keystrokes to a PTY. Prompts go through `commands.submit`; this is
     * the Architect operating the engine's own interface (FR-1.3).
     */
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    /** Subscribe to output bytes for one pty id. Returns an unsubscribe function. */
    onData: (id: string, cb: (data: string) => void) => () => void
    /** Subscribe to process exit for one pty id. Returns an unsubscribe function. */
    onExit: (id: string, cb: (exitCode: number) => void) => () => void
  }
}
