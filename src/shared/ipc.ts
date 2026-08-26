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
  ptyKill: 'pty:kill'
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

export interface EphApi {
  config: {
    get: () => Promise<ConfigSnapshot>
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
