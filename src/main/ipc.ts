import { ipcMain } from 'electron'
import { DEV_SHELL_ID, IpcChannels, type ConfigSnapshot } from '../shared/ipc'
import { ptyKillSchema, ptyResizeSchema, ptyWriteSchema } from '../shared/pty'
import { getHome } from './config'
import type { PtyManager } from './pty'

/**
 * Registers every handler behind the typed preload surface (SDD §1.1).
 * Invariant: main validates all renderer input; handlers taking arguments
 * parse them with a src/shared/ validator before acting (BUILD-PROMPT §3.2).
 */
export function registerIpc(ptyManager: PtyManager): void {
  ipcMain.handle(IpcChannels.configGet, (): ConfigSnapshot => {
    const home = getHome()
    return { config: home.config, warning: home.configWarning }
  })

  // Renderer asks for the dev shell AFTER subscribing to its data channel,
  // so the first prompt bytes are never lost to a subscribe race.
  ipcMain.handle(IpcChannels.ptyEnsureDevShell, () => {
    ptyManager.spawnShell(DEV_SHELL_ID)
    return DEV_SHELL_ID
  })

  ipcMain.handle(IpcChannels.ptyWrite, (_ev, raw: unknown) => {
    const { id, data } = ptyWriteSchema.parse(raw)
    ptyManager.write(id, data)
  })

  ipcMain.handle(IpcChannels.ptyResize, (_ev, raw: unknown) => {
    const { id, cols, rows } = ptyResizeSchema.parse(raw)
    ptyManager.resize(id, cols, rows)
  })

  ipcMain.handle(IpcChannels.ptyKill, (_ev, raw: unknown) => {
    const { id } = ptyKillSchema.parse(raw)
    ptyManager.kill(id)
  })
}
