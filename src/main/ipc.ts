import { ipcMain } from 'electron'
import { IpcChannels } from '../shared/ipc'
import { getConfig } from './config'

/**
 * Registers every handler behind the typed preload surface (SDD §1.1).
 * Invariant: main validates all renderer input; handlers taking arguments
 * parse them with a src/shared/ validator before acting (BUILD-PROMPT §3.2).
 */
export function registerIpc(): void {
  ipcMain.handle(IpcChannels.configGet, () => getConfig())
}
