import type { AgentCard, SpawnRequest } from './agents'
import type { AvatarSnapshot } from './avatar'
import type { CommandState } from './commands'
import type { EphConfig } from './config'

/**
 * The typed `window.eph` surface (SDD §5) — the ONLY renderer door. Groups are
 * added milestone by milestone; every channel is registered in src/main/ipc.ts
 * and validated in main before touching state.
 */
export const IpcChannels = {
  configGet: 'config:get',
  ptyEnsureDevShell: 'pty:ensure-dev-shell',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  agentsList: 'agents:list',
  agentsSpawn: 'agents:spawn',
  agentsCard: 'agents:card',
  agentsKill: 'agents:kill',
  agentsInterrupt: 'agents:interrupt',
  agentsSend: 'agents:send',
  avatarsList: 'avatars:list',
  hooksState: 'hooks:state',
  commandsList: 'commands:list',
  commandsSubmit: 'commands:submit'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

// NOTE: this module must stay free of runtime dependencies (zod included) —
// the sandboxed preload imports it, and sandboxed preloads cannot require
// external modules at runtime. Validators live in the sibling schema modules
// (config.ts, pty.ts) which only main imports.

/** The single hardcoded dev shell of milestone M0.3. */
export const DEV_SHELL_ID = 'shell-0'

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
  pty: {
    /** Spawns the M0.3 hardcoded dev shell if needed; resolves with its pty id. */
    ensureDevShell: () => Promise<string>
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    kill: (id: string) => Promise<void>
    /** Subscribe to output bytes for one pty id. Returns an unsubscribe function. */
    onData: (id: string, cb: (data: string) => void) => () => void
    /** Subscribe to process exit for one pty id. Returns an unsubscribe function. */
    onExit: (id: string, cb: (exitCode: number) => void) => () => void
  }
}
