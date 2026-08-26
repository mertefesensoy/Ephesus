import { contextBridge, ipcRenderer } from 'electron'
import type { EphConfig } from '../shared/config'
import { IpcChannels, type EphApi } from '../shared/ipc'

// The single door between renderer and main (SDD §1, §5). Every method is a
// thin, typed forward to an ipcMain handler that validates in main.
const eph: EphApi = {
  config: {
    get: () => ipcRenderer.invoke(IpcChannels.configGet) as Promise<EphConfig>
  }
}

contextBridge.exposeInMainWorld('eph', eph)
