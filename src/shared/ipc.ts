import type { EphConfig } from './config'

/**
 * The typed `window.eph` surface (SDD §5) — the ONLY renderer door. Groups are
 * added milestone by milestone; every channel is registered in src/main/ipc.ts
 * and validated in main before touching state.
 */
export const IpcChannels = {
  configGet: 'config:get'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

export interface EphApi {
  config: {
    get: () => Promise<EphConfig>
  }
}
