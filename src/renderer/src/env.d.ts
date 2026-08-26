import type { EphApi } from '../../shared/ipc'

declare global {
  interface Window {
    /** Present only under Electron with the preload bridge; absent in a bare browser. */
    eph?: EphApi
  }
}

export {}
