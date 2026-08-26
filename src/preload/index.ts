import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EphConfig } from '../shared/config'
import { IpcChannels, ptyDataChannel, ptyExitChannel, type EphApi } from '../shared/ipc'

// The single door between renderer and main (SDD §1, §5). Every method is a
// thin, typed forward to an ipcMain handler that validates in main.
const eph: EphApi = {
  config: {
    get: () => ipcRenderer.invoke(IpcChannels.configGet) as Promise<EphConfig>
  },
  pty: {
    ensureDevShell: () => ipcRenderer.invoke(IpcChannels.ptyEnsureDevShell) as Promise<string>,
    write: (id, data) => ipcRenderer.invoke(IpcChannels.ptyWrite, { id, data }) as Promise<void>,
    resize: (id, cols, rows) =>
      ipcRenderer.invoke(IpcChannels.ptyResize, { id, cols, rows }) as Promise<void>,
    kill: (id) => ipcRenderer.invoke(IpcChannels.ptyKill, { id }) as Promise<void>,
    onData: (id, cb) => {
      const channel = ptyDataChannel(id)
      const listener = (_ev: IpcRendererEvent, data: string): void => cb(data)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, cb) => {
      const channel = ptyExitChannel(id)
      const listener = (_ev: IpcRendererEvent, exitCode: number): void => cb(exitCode)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('eph', eph)
